"""API tests — focused on the guarantees that matter for a redaction tool:
detection works, export leaves no recoverable text, fixed-color fill is honored,
and the abuse guards actually reject oversized / oversized-page uploads.
"""
import io

import app as appmod
import fitz
import pytest
from fastapi.testclient import TestClient
from PIL import Image

client = TestClient(appmod.app)


def _pdf_with_number(text="Container 1234567"):
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


def test_analyze_detects_numbers():
    r = client.post("/api/analyze",
                    files={"file": ("t.pdf", _pdf_with_number(), "application/pdf")})
    assert r.status_code == 200
    pages = r.json()["pages"]
    assert pages, "no pages returned"
    boxes = pages[0]["boxes"]
    assert any(any(c.isdigit() for c in b["text"]) for b in boxes), "no number detected"


def test_export_flattens_to_image_no_text():
    """The core redaction promise: an exported page carries no selectable text."""
    doc = fitz.open(stream=_pdf_with_number("SECRET 987654"), filetype="pdf")
    png = doc[0].get_pixmap().tobytes("png")
    doc.close()
    r = client.post("/api/export", files=[("files", ("p0.png", png, "image/png"))])
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/pdf"
    out = fitz.open(stream=r.content, filetype="pdf")
    text = "".join(p.get_text() for p in out).strip()
    out.close()
    assert "987654" not in text
    assert text == ""


def test_inpaint_fixed_color_is_honored():
    """The 'Fixed' fill mode must actually persist the chosen color."""
    r = client.post(
        "/api/inpaint",
        data={"rects": '[{"x":30,"y":20,"w":50,"h":30}]', "fillMode": "fixed", "color": "#ff0000"},
        files={"file": ("c.png", _png(120, 80, (255, 255, 255)), "image/png")},
    )
    assert r.status_code == 200
    img = Image.open(io.BytesIO(r.content)).convert("RGB")
    assert img.getpixel((55, 35)) == (255, 0, 0), "fixed color not applied"


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


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(pytest.main([__file__, "-q"]))
