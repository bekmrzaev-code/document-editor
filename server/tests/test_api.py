"""API tests — document upload/render pipeline and the abuse guards."""
import io

import app as appmod
import fitz
import pytest
from fastapi.testclient import TestClient
from PIL import Image

client = TestClient(appmod.app)


def _pdf_with_text(text="Hello Apple 1234"):
    doc = fitz.open()
    page = doc.new_page(width=400, height=300)
    page.insert_text((60, 100), text, fontsize=20)
    data = doc.tobytes()
    doc.close()
    return data


def _png(w=120, h=80, color=(255, 255, 255)):
    buf = io.BytesIO()
    Image.new("RGB", (w, h), color).save(buf, "PNG")
    return buf.getvalue()


def test_health():
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.json()["ok"] is True


async def _noop(*a, **k):
    return None


def test_support_saves_report_with_attachments(tmp_path, monkeypatch):
    monkeypatch.setattr(appmod, "SUPPORT_DIR", tmp_path)
    monkeypatch.setattr(appmod.notify, "send_support", _noop)   # no real Telegram call
    # open a doc so the session-document gets attached automatically
    a = client.post("/api/analyze",
                    files={"file": ("t.pdf", _pdf_with_text(), "application/pdf")})
    sid = a.json()["session"]
    r = client.post(
        "/api/support",
        data={"message": "Cannot edit this scan", "session": sid, "email": "u@x.com"},
        files={"screenshot": ("shot.png", _png(60, 40), "image/png")},
    )
    assert r.status_code == 200
    ticket = r.json()["ticket"]
    tdir = tmp_path / ticket
    report = (tdir / "report.txt").read_text()
    assert "Cannot edit this scan" in report and "u@x.com" in report
    assert (tdir / "screenshot.png").exists()
    assert (tdir / "session-document.pdf").exists()      # pulled from the live session


def test_support_requires_message():
    r = client.post("/api/support", data={"message": "   "})
    assert r.status_code == 400


def test_analyze_returns_pages():
    r = client.post("/api/analyze",
                    files={"file": ("t.pdf", _pdf_with_text(), "application/pdf")})
    assert r.status_code == 200
    body = r.json()
    assert body["session"]
    assert len(body["pages"]) == 1
    p = body["pages"][0]
    assert p["width"] > 0 and p["height"] > 0
    assert p["scanned"] is False


def test_analyze_detects_all_words_with_style():
    r = client.post("/api/analyze",
                    files={"file": ("t.pdf", _pdf_with_text("Hello Apple 1234"), "application/pdf")})
    boxes = r.json()["pages"][0]["boxes"]
    texts = [b["text"] for b in boxes]
    assert "Hello" in texts and "Apple" in texts and "1234" in texts
    b = boxes[0]
    for field in ("fontSize", "color", "bold", "italic", "family", "base", "fontName"):
        assert field in b, f"missing style field {field}"
    assert b["w"] > 0 and b["h"] > 0


def test_stroke_width_separates_bold_from_regular():
    import numpy as np
    import scan
    thin_img = np.full((40, 200, 3), 255, np.uint8)
    thin_img[10:12, 20:180] = 0                            # 2px stroke
    thick_img = np.full((40, 200, 3), 255, np.uint8)
    thick_img[10:16, 20:180] = 0                           # 6px stroke
    thin = scan.stroke_width(thin_img, (0, 0, 200, 40))
    thick = scan.stroke_width(thick_img, (0, 0, 200, 40))
    assert thick > thin >= 1, (thin, thick)


def test_erase_auto_background():
    r = client.post(
        "/api/erase",
        data={"rects": '[{"x":30,"y":20,"w":50,"h":30}]', "fillMode": "auto"},
        files={"file": ("c.png", _png(120, 80, (250, 250, 250)), "image/png")},
    )
    assert r.status_code == 200
    img = Image.open(io.BytesIO(r.content)).convert("RGB")
    px = img.getpixel((55, 35))
    assert all(abs(c - 250) < 12 for c in px), f"background not preserved: {px}"


def test_erase_gradient_background_interpolates_no_blur():
    """On a non-uniform background the erased area is rebuilt by interpolating
    the surrounding pixels — it must follow the gradient, not become a smudge."""
    grad = Image.new("RGB", (200, 80))
    for gx in range(200):
        v = int(55 + gx)                      # left → right: 55 … 254
        for gy in range(80):
            grad.putpixel((gx, gy), (v, v, v))
    buf = io.BytesIO(); grad.save(buf, "PNG")
    r = client.post(
        "/api/erase",
        data={"rects": '[{"x":60,"y":20,"w":80,"h":40}]', "fillMode": "auto"},
        files={"file": ("g.png", buf.getvalue(), "image/png")},
    )
    assert r.status_code == 200
    img = Image.open(io.BytesIO(r.content)).convert("RGB")
    for gx in (70, 100, 130):                 # inside the erased area
        expected = 55 + gx
        px = img.getpixel((gx, 40))
        assert all(abs(c - expected) < 14 for c in px), \
            f"gradient not preserved at x={gx}: {px} vs ~{expected}"


def test_erase_object_heals_whole_stroke():
    """Object mode: the rect only SEEDS the selection — connected ink spilling
    outside it is healed too, and untouched background stays byte-identical."""
    import numpy as np
    import scan
    img = np.full((120, 200, 3), 245, np.uint8)
    img[40:44, 30:170] = (20, 20, 20)          # a long stroke ("handwriting")
    img[90:95, 30:60] = (20, 20, 20)           # unrelated mark far below
    buf = io.BytesIO(); Image.fromarray(img[..., ::-1]).save(buf, "PNG")
    # the rect misses ~15px of the stroke on each side (within the 24px grow)
    out = scan.erase_object(buf.getvalue(), {"x": 45, "y": 30, "w": 110, "h": 25})
    res = np.array(Image.open(io.BytesIO(out)).convert("RGB"))
    assert res[42, 40:160].max() > 150, "stroke not fully healed"      # ink gone
    assert res[92, 45].sum() < 200, "unrelated mark must survive"      # not touched
    r_, g_, b_ = res[20, 100]
    assert abs(int(r_) - 245) < 12, "background near the stroke was altered"


def test_erase_redraws_table_rule_across_gap():
    """A horizontal rule crossing an erased rect must be painted back, not left
    with a white gap where the grid line was."""
    import numpy as np
    import scan
    img = np.full((80, 200, 3), 245, np.uint8)
    img[40:43, :] = (25, 25, 25)               # a full-width horizontal rule
    buf = io.BytesIO(); Image.fromarray(img[..., ::-1]).save(buf, "PNG")
    out = scan.erase(buf.getvalue(), [{"x": 80, "y": 30, "w": 40, "h": 24}])
    res = np.array(Image.open(io.BytesIO(out)).convert("RGB"))
    # the rule row inside the erased span must still be dark
    assert res[41, 100].mean() < 90, f"table rule not redrawn: {res[41, 100]}"


def test_export_uniform_jpeg_no_metadata():
    """Exported PDF re-encodes pages as JPEG (uniform ELA) and strips metadata."""
    doc = fitz.open(stream=_pdf_with_text("SECRET 987654"), filetype="pdf")
    png = doc[0].get_pixmap().tobytes("png")
    doc.close()
    r = client.post("/api/export", files=[("files", ("p0.png", png, "image/png"))])
    assert r.status_code == 200
    out = fitz.open(stream=r.content, filetype="pdf")
    meta = out.metadata
    assert not meta.get("producer") and not meta.get("creationDate")
    # the embedded image is JPEG (DCT), not a lossless PNG/Flate raster
    imgs = out[0].get_images()
    assert imgs, "no image embedded"
    ext = out.extract_image(imgs[0][0])["ext"]
    out.close()
    assert ext in ("jpeg", "jpg"), f"page not JPEG-encoded: {ext}"


def test_erase_fixed_color_is_honored():
    r = client.post(
        "/api/erase",
        data={"rects": '[{"x":30,"y":20,"w":50,"h":30}]', "fillMode": "fixed", "color": "#ff0000"},
        files={"file": ("c.png", _png(120, 80, (255, 255, 255)), "image/png")},
    )
    assert r.status_code == 200
    img = Image.open(io.BytesIO(r.content)).convert("RGB")
    assert img.getpixel((55, 35)) == (255, 0, 0), "fixed color not applied"


def test_export_flattens_to_image_no_text():
    """An exported page carries no selectable text — edits are truly baked in."""
    doc = fitz.open(stream=_pdf_with_text("SECRET 987654"), filetype="pdf")
    png = doc[0].get_pixmap().tobytes("png")
    doc.close()
    r = client.post("/api/export", files=[("files", ("p0.png", png, "image/png"))])
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/pdf"
    out = fitz.open(stream=r.content, filetype="pdf")
    text = "".join(p.get_text() for p in out).strip()
    out.close()
    assert text == ""


def test_page_and_thumb_streaming():
    r = client.post("/api/analyze",
                    files={"file": ("t.pdf", _pdf_with_text(), "application/pdf")})
    sid = r.json()["session"]
    for path in (f"/api/page/{sid}/0", f"/api/thumb/{sid}/0"):
        pr = client.get(path)
        assert pr.status_code == 200
        assert pr.headers["content-type"] == "image/png"
        Image.open(io.BytesIO(pr.content)).verify()
    assert client.get(f"/api/page/{sid}/99").status_code == 404
    assert client.get("/api/page/nosuchsession/0").status_code == 404


def test_image_upload_becomes_one_page():
    r = client.post("/api/analyze",
                    files={"file": ("t.png", _png(200, 150), "image/png")})
    assert r.status_code == 200
    assert len(r.json()["pages"]) == 1


def test_sample_ink_color_ignores_antialias_halo():
    """Real scans have more pale halo pixels (antialiasing) than ink-core
    pixels; the sampled color must be the dark core, not the halo."""
    import numpy as np
    import scan
    img = np.full((20, 40, 3), 255, np.uint8)             # white background
    img[5:15, 4:30] = (205, 205, 205)                      # wide pale halo
    img[8:12, 8:26] = (40, 40, 45)                         # dark ink core (fewer px)
    r, g, b = scan.sample_ink_color(img, (0, 0, 40, 20))
    assert r < 90 and g < 90 and b < 90, f"picked the halo, not the ink: {(r, g, b)}"


@pytest.mark.skipif(not appmod.HAS_OCR, reason="Tesseract not installed")
def test_scanned_image_words_found_via_ocr():
    doc = fitz.open(stream=_pdf_with_text("SHIPMENT RECEIPT 42"), filetype="pdf")
    png = doc[0].get_pixmap(matrix=fitz.Matrix(2.5, 2.5)).tobytes("png")
    doc.close()
    r = client.post("/api/analyze", files={"file": ("scan.png", png, "image/png")})
    assert r.status_code == 200
    body = r.json()
    assert body["ocrAvailable"] is True
    p = body["pages"][0]
    assert p["scanned"] is True
    texts = [b["text"] for b in p["boxes"]]
    assert any("SHIPMENT" in t for t in texts), f"OCR missed the word: {texts}"
    ocr_box = p["boxes"][0]
    assert ocr_box["kind"] == "ocr"
    assert ocr_box["fontSize"] > 0 and ocr_box["color"].startswith("#")
    # A caps-only word's glyph box is ~0.72 em tall, so the estimated em size
    # must be LARGER than the box height (the old h*1.15 guess undershot it).
    caps = next(b for b in p["boxes"] if "SHIPMENT" in b["text"])
    assert caps["fontSize"] > caps["h"] * 1.25, (caps["fontSize"], caps["h"])
    assert caps["base"] >= caps["y"] + caps["h"] * 0.95     # caps sit on the baseline


def test_upload_too_large_rejected(monkeypatch):
    monkeypatch.setattr(appmod, "MAX_UPLOAD_BYTES", 10)
    r = client.post("/api/analyze",
                    files={"file": ("t.pdf", b"%PDF-" + b"x" * 200, "application/pdf")})
    assert r.status_code == 413


def test_too_many_pages_rejected(monkeypatch):
    monkeypatch.setattr(appmod, "MAX_PAGES", 1)
    doc = fitz.open()
    doc.new_page(); doc.new_page()
    data = doc.tobytes(); doc.close()
    r = client.post("/api/analyze",
                    files={"file": ("t.pdf", data, "application/pdf")})
    assert r.status_code == 413


def test_empty_upload_rejected():
    r = client.post("/api/analyze", files={"file": ("t.pdf", b"", "application/pdf")})
    assert r.status_code == 400


def test_ai_chat_503_when_no_key(monkeypatch):
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    r = client.post("/api/analyze",
                    files={"file": ("t.pdf", _pdf_with_text(), "application/pdf")})
    sid = r.json()["session"]
    resp = client.post("/api/ai-chat", data={"session": sid, "question": "What is this?"})
    assert resp.status_code == 503


def test_ai_edit_filters_hallucinations(monkeypatch):
    """Only proposals whose id+oldText match the document survive."""
    import ai_edit

    def fake_propose(instruction, runs):
        apple = next(r for r in runs if r["text"] == "Apple")
        return [
            {"id": apple["id"], "oldText": "Apple", "newText": "Orange"},   # valid
            {"id": apple["id"], "oldText": "Apple", "newText": "Kiwi"},     # duplicate id → dropped
            {"id": 99999, "oldText": "Ghost", "newText": "X"},              # unknown id → dropped
            {"id": runs[0]["id"], "oldText": "WRONG", "newText": "Y"},      # oldText mismatch → dropped
        ]

    monkeypatch.setattr(ai_edit, "propose_edits", fake_propose)
    r = client.post("/api/analyze",
                    files={"file": ("t.pdf", _pdf_with_text("Hello Apple 1234"), "application/pdf")})
    sid = r.json()["session"]
    resp = client.post("/api/ai-edit", data={"session": sid, "instruction": "apple->orange"})
    assert resp.status_code == 200
    edits = resp.json()["edits"]
    assert len(edits) == 1
    assert edits[0]["oldText"] == "Apple" and edits[0]["newText"] == "Orange"
    assert edits[0]["page"] == 0


def test_propose_edits_parses_structured_response(monkeypatch):
    import ai_edit

    class R:
        text = '{"edits": [{"id": 1, "oldText": "Apple", "newText": "Orange"}]}'
    monkeypatch.setattr(ai_edit, "_generate", lambda contents, **kw: R())
    edits = ai_edit.propose_edits("swap", [{"id": 1, "page": 0, "text": "Apple"}])
    assert edits == [{"id": 1, "oldText": "Apple", "newText": "Orange"}]


def test_ai_ocr_applies_valid_fixes(monkeypatch):
    import ai_edit
    monkeypatch.setattr(ai_edit, "fix_ocr", lambda png, words: [
        {"id": words[0]["id"], "text": "CORRECTED"},
        {"id": 99999, "text": "ghost"},                     # unknown id → dropped
        {"id": words[-1]["id"], "text": words[-1]["text"]},  # unchanged → dropped
    ])
    doc = fitz.open(stream=_pdf_with_text("SHIPMENT RECEIPT 42"), filetype="pdf")
    png = doc[0].get_pixmap(matrix=fitz.Matrix(2.5, 2.5)).tobytes("png")
    doc.close()
    r = client.post("/api/analyze", files={"file": ("scan.png", png, "image/png")})
    body = r.json()
    if not body["pages"][0]["boxes"]:
        pytest.skip("OCR unavailable")
    sid = body["session"]
    resp = client.post("/api/ai-ocr", data={"session": sid, "page": "0"})
    assert resp.status_code == 200
    fixes = resp.json()["fixes"]
    assert len(fixes) == 1 and fixes[0]["text"] == "CORRECTED"
    # digital pages are rejected
    r2 = client.post("/api/analyze",
                     files={"file": ("t.pdf", _pdf_with_text(), "application/pdf")})
    resp2 = client.post("/api/ai-ocr", data={"session": r2.json()["session"], "page": "0"})
    assert resp2.status_code == 400


def test_ai_fonts_returns_identified_styles(monkeypatch):
    import ai_edit
    monkeypatch.setattr(ai_edit, "identify_fonts", lambda png: [
        {"font": "Arial", "style": "bold", "approxSizePt": 14,
         "usage": "headers", "examples": ["Hello"]},
    ])
    r = client.post("/api/analyze",
                    files={"file": ("t.pdf", _pdf_with_text(), "application/pdf")})
    sid = r.json()["session"]
    resp = client.post("/api/ai-fonts", data={"session": sid, "page": "0"})
    assert resp.status_code == 200
    fonts = resp.json()["fonts"]
    assert fonts[0]["font"] == "Arial" and fonts[0]["style"] == "bold"
    assert client.post("/api/ai-fonts", data={"session": sid, "page": "9"}).status_code == 404


def test_digitize_produces_real_text_pdf():
    """The digitized PDF must keep the page size and carry a REAL text layer."""
    r = client.post("/api/analyze",
                    files={"file": ("t.pdf", _pdf_with_text("Hello Apple 1234"), "application/pdf")})
    sid = r.json()["session"]
    resp = client.post("/api/digitize", data={"session": sid, "useAi": "0"})
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "application/pdf"
    out = fitz.open(stream=resp.content, filetype="pdf")
    assert out.page_count == 1
    assert abs(out[0].rect.width - 400) < 1 and abs(out[0].rect.height - 300) < 1
    text = out[0].get_text()
    out.close()
    for word in ("Hello", "Apple", "1234"):
        assert word in text, f"digitized PDF lost the word {word!r}: {text!r}"


def test_ai_chat_answers_with_mocked_model(monkeypatch):
    import ai_edit

    def fake_generate(contents, **kwargs):
        assert "Apple" in contents          # document text made it into the prompt
        class R:  # mimic the SDK response shape
            text = "It mentions Apple."
        return R()

    monkeypatch.setattr(ai_edit, "_generate", fake_generate)
    r = client.post("/api/analyze",
                    files={"file": ("t.pdf", _pdf_with_text("Hello Apple 1234"), "application/pdf")})
    sid = r.json()["session"]
    resp = client.post("/api/ai-chat", data={"session": sid, "question": "What fruit?"})
    assert resp.status_code == 200
    assert resp.json()["answer"] == "It mentions Apple."


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(pytest.main([__file__, "-q"]))
