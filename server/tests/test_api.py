"""API tests — document upload/render pipeline and the abuse guards."""
import io
import time

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


def test_langs_endpoint_lists_installed_packs():
    r = client.get("/api/langs")
    assert r.status_code == 200
    body = r.json()
    assert isinstance(body["langs"], list)
    assert body["default"]                                  # always resolves to something
    if appmod.HAS_OCR:
        assert "eng" in body["langs"]


def test_clean_lang_drops_unavailable_codes(monkeypatch):
    """A missing language pack must degrade, never turn an upload into an error."""
    monkeypatch.setattr(appmod, "OCR_LANGS", ["eng", "rus", "uzb"])
    monkeypatch.setattr(appmod, "DEFAULT_OCR_LANG", "eng")
    assert appmod._clean_lang("uzb+eng") == "uzb+eng"
    assert appmod._clean_lang("uzb+klingon") == "uzb"       # unknown code dropped
    assert appmod._clean_lang("klingon") == "eng"           # nothing left → default
    assert appmod._clean_lang("") == "eng"
    assert appmod._clean_lang("rus + rus") == "rus"         # spaces and dupes


def test_analyze_passes_language_to_tesseract(monkeypatch):
    """The chosen language must actually reach pytesseract, not just the response."""
    seen = {}

    def fake_ocr(png, scale, lang=""):
        seen["lang"] = lang
        return [], []

    monkeypatch.setattr(appmod, "OCR_LANGS", ["eng", "uzb"])
    monkeypatch.setattr(appmod, "HAS_OCR", True)
    monkeypatch.setattr(appmod, "_ocr_page", fake_ocr)
    r = client.post("/api/analyze",
                    data={"lang": "uzb+eng"},
                    files={"file": ("scan.png", _png(300, 200), "image/png")})
    assert r.status_code == 200
    assert seen["lang"] == "uzb+eng"
    assert r.json()["lang"] == "uzb+eng"


def test_concurrent_ocr_keeps_run_ids_sequential_by_page(monkeypatch):
    """Pages are OCR'd in a thread pool, so ids are handed out afterwards —
    they must still run in page order, because /api/ai-edit and the client's
    box lookups both key off them."""
    import threading
    seen_threads = set()

    def fake_ocr(png, scale, lang=""):
        seen_threads.add(threading.get_ident())
        time.sleep(0.02)                                    # let the pool overlap
        box = {"id": 0, "x": 1.0, "y": 2.0, "w": 3.0, "h": 4.0, "text": "42",
               "kind": "ocr", "base": 5.0, "fontSize": 6.0, "color": "#000000",
               "bold": False, "italic": False, "family": "sans"}
        mt = {"id": 0, "rect": [0, 0, 1, 1], "text": "42", "base": 1.0, "fontSize": 1.0,
              "color": "#000000", "bold": False, "italic": False, "family": "sans",
              "block": 0, "line": 0}
        return [dict(box), dict(box)], [dict(mt), dict(mt)]

    monkeypatch.setattr(appmod, "HAS_OCR", True)
    monkeypatch.setattr(appmod, "_ocr_page", fake_ocr)
    # image-only pages → every page takes the OCR path
    doc = fitz.open()
    for _ in range(4):
        doc.new_page(width=200, height=150)
    data = doc.tobytes()
    doc.close()

    r = client.post("/api/analyze", files={"file": ("scan.pdf", data, "application/pdf")})
    assert r.status_code == 200
    pages = r.json()["pages"]
    assert len(pages) == 4
    ids = [b["id"] for p in pages for b in p["boxes"]]
    assert ids == list(range(1, len(ids) + 1)), f"ids not sequential in page order: {ids}"
    assert len(seen_threads) > 1, "pages were not OCR'd concurrently"


def test_digitize_keeps_non_ascii_text(monkeypatch):
    """Cyrillic / Uzbek characters must survive digitize, not come out blank."""
    if not appmod.UNICODE_FONT:
        pytest.skip("no Unicode font installed on this machine")
    doc = fitz.open()
    page = doc.new_page(width=400, height=300)
    page.insert_text((50, 100), "Ҳисоб рақами", fontsize=18,
                     fontfile=appmod.UNICODE_FONT, fontname="uni")
    data = doc.tobytes()
    doc.close()
    r = client.post("/api/analyze", files={"file": ("t.pdf", data, "application/pdf")})
    sid = r.json()["session"]
    resp = client.post("/api/digitize", data={"session": sid, "useAi": "0"})
    assert resp.status_code == 200
    out = fitz.open(stream=resp.content, filetype="pdf")
    text = out[0].get_text()
    out.close()
    assert "Ҳисоб" in text, f"digitize dropped the Cyrillic text: {text!r}"


# ── page operations ──────────────────────────────────────────────────────────
def _multipage_pdf(n=3):
    doc = fitz.open()
    for i in range(n):
        doc.new_page(width=400, height=300).insert_text((60, 100), f"Page{i}", fontsize=20)
    data = doc.tobytes()
    doc.close()
    return data


def test_rotate_swaps_dimensions_and_remaps_boxes():
    """Rotation must re-detect: the boxes have to follow the pixels, otherwise
    every word on the page becomes unclickable."""
    r = client.post("/api/analyze",
                    files={"file": ("t.pdf", _pdf_with_text("Apple"), "application/pdf")})
    sid = r.json()["session"]
    before = r.json()["pages"][0]
    resp = client.post("/api/rotate", data={"session": sid, "page": "0", "deg": "90"})
    assert resp.status_code == 200
    after = resp.json()["page"]
    assert after["rotation"] == 90
    assert abs(after["width"] - before["height"]) <= 2      # portrait ↔ landscape
    assert abs(after["height"] - before["width"]) <= 2
    box = after["boxes"][0]
    assert box["text"] == "Apple"
    assert 0 <= box["x"] and box["x"] + box["w"] <= after["width"] + 1
    assert 0 <= box["y"] and box["y"] + box["h"] <= after["height"] + 1
    # rotation accumulates rather than resetting
    assert client.post("/api/rotate", data={"session": sid, "page": "0", "deg": "90"}
                       ).json()["page"]["rotation"] == 180


def test_rotate_rejects_bad_input():
    r = client.post("/api/analyze",
                    files={"file": ("t.pdf", _pdf_with_text(), "application/pdf")})
    sid = r.json()["session"]
    assert client.post("/api/rotate", data={"session": sid, "page": "0", "deg": "45"}).status_code == 400
    assert client.post("/api/rotate", data={"session": sid, "page": "7", "deg": "90"}).status_code == 404


def test_pages_reorder_and_delete_follow_through_to_the_server():
    """Deleting a page client-side isn't enough — digitize and the AI endpoints
    read the server's page list."""
    r = client.post("/api/analyze", files={"file": ("t.pdf", _multipage_pdf(3), "application/pdf")})
    sid = r.json()["session"]
    resp = client.post("/api/pages", data={"session": sid, "order": "[2, 0]"})
    assert resp.status_code == 200 and resp.json()["pages"] == 2
    # the digitized document now has exactly the kept pages, in the new order
    out = fitz.open(stream=client.post("/api/digitize", data={"session": sid}).content,
                    filetype="pdf")
    assert out.page_count == 2
    assert "Page2" in out[0].get_text() and "Page0" in out[1].get_text()
    out.close()
    assert client.get(f"/api/page/{sid}/2").status_code == 404      # really gone


def test_pages_rejects_invalid_order():
    r = client.post("/api/analyze", files={"file": ("t.pdf", _multipage_pdf(2), "application/pdf")})
    sid = r.json()["session"]
    for bad in ("[]", "[0, 0]", "[5]", "[-1]", "not-json", '["a"]'):
        assert client.post("/api/pages", data={"session": sid, "order": bad}).status_code == 400
    assert len(client.post("/api/digitize", data={"session": sid}).content) > 0   # untouched


# ── session store ────────────────────────────────────────────────────────────
def _store(tmp_path, **kw):
    from store import SessionStore
    return SessionStore(root=tmp_path / "sessions", ttl=kw.pop("ttl", 3600), **kw)


def _session(n_pages=1):
    return {"pdf": b"%PDF-fake", "created": time.time(),
            "pages": [{"png": _png(20, 10), "thumb": _png(8, 4), "scale": 2.0,
                       "ptw": 400.0, "pth": 300.0, "scanned": False,
                       "boxes": [{"id": 1, "text": "Apple", "rect": [1, 2, 3, 4]}]}
                      for _ in range(n_pages)]}


def test_store_survives_a_restart(tmp_path):
    """A fresh store over the same directory must find the earlier session —
    this is the whole point: a redeploy shouldn't evict everyone's document."""
    s1 = _store(tmp_path)
    s1.put("abc123", _session(2))
    s2 = _store(tmp_path)                                   # "restart"
    got = s2.get("abc123")
    assert got is not None
    assert got["pdf"] == b"%PDF-fake"
    assert len(got["pages"]) == 2
    assert got["pages"][0]["boxes"][0]["text"] == "Apple"
    assert got["pages"][1]["png"] == _png(20, 10)           # image bytes round-trip
    assert got["pages"][0]["scale"] == 2.0


def test_store_evicts_from_memory_but_keeps_disk(tmp_path):
    s = _store(tmp_path, max_cached=2)
    for i in range(4):
        sess = _session()
        sess["created"] = time.time() + i                   # deterministic ordering
        s.put(f"sid{i}", sess)
    assert len(s._mem) <= 2                                 # memory trimmed
    assert s.get("sid0") is not None                        # …but still loadable
    assert len(s) == 4


def test_store_expires_sessions(tmp_path):
    s = _store(tmp_path, ttl=0)
    s.put("gone", _session())
    s.cleanup()
    assert s.get("gone") is None
    assert len(s) == 0


def test_store_save_meta_persists_text_edits(tmp_path):
    """AI OCR fixes change box text with no pixel change — they must be saved."""
    s1 = _store(tmp_path)
    s1.put("sid", _session())
    s1.get("sid")["pages"][0]["boxes"][0]["text"] = "CORRECTED"
    s1.save_meta("sid")
    assert _store(tmp_path).get("sid")["pages"][0]["boxes"][0]["text"] == "CORRECTED"


def test_store_rejects_path_traversal(tmp_path):
    s = _store(tmp_path)
    for evil in ("../../etc", "a/b", "..", "a.b"):
        assert s.get(evil) is None


def test_store_memory_only_mode(tmp_path):
    s = _store(tmp_path, persist=False)
    s.put("sid", _session())
    assert s.get("sid") is not None                         # served from memory
    assert not (tmp_path / "sessions" / "sid").exists()      # nothing written


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(pytest.main([__file__, "-q"]))
