"""
BOL Editor — backend.

  /api/analyze        — PDF *or* image upload → renders pages, detects numbers
                        (text layer + Tesseract OCR), returns lightweight metadata.
  /api/page/{s}/{i}   — streams a full-resolution page PNG (lazy-loaded).
  /api/thumb/{s}/{i}  — streams a thumbnail PNG.
  /api/inpaint        — seamless removal of rectangles (auto background or fixed fill).
  /api/export         — flattens edited page images into a downloadable PDF (no
                        recoverable text layer — erased numbers are truly gone).

Also serves the static frontend, so one `uvicorn` command runs everything.
"""

from __future__ import annotations

import io
import json
import os
import re
import time
import uuid
from pathlib import Path

import fitz  # PyMuPDF
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from PIL import Image as PILImage

import scan  # local image-processing engine (seamless removal + OCR preprocessing)

# ── Optional OCR (used when a page has no text layer) ───────────────────────
try:
    import pytesseract
    pytesseract.get_tesseract_version()
    HAS_OCR = True
except Exception:
    HAS_OCR = False


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


ROOT = Path(__file__).resolve().parent.parent          # the bol-editor/ folder
RENDER_SCALE = 2.0                                     # points → pixels (digital PDFs)
MAX_DIM = 2200                                         # cap longest page side (px)
THUMB_WIDTH = 220
SESSION_TTL = _env_int("SESSION_TTL", 3600)            # seconds a session lives (idle)

# ── Abuse guards (the app stays open to everyone — these only stop DoS) ──────
MAX_UPLOAD_BYTES = _env_int("MAX_UPLOAD_BYTES", 30 * 1024 * 1024)   # 30 MB per upload
MAX_PAGES = _env_int("MAX_PAGES", 60)                              # cap pages per doc
# Guard Pillow against decompression-bomb images (~40 MP ceiling).
PILImage.MAX_IMAGE_PIXELS = _env_int("MAX_IMAGE_PIXELS", 40_000_000)

SESSIONS: dict[str, dict] = {}

app = FastAPI(title="BOL Editor API")

# Same-origin (the backend serves the UI) needs no CORS at all. Set
# ALLOWED_ORIGINS="https://a.com,https://b.com" only if you host the UI elsewhere.
_origins = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "").split(",") if o.strip()]
if _origins:
    app.add_middleware(CORSMiddleware, allow_origins=_origins,
                       allow_methods=["*"], allow_headers=["*"])


# ── Lightweight per-IP rate limiting for the heavy endpoints ────────────────
# Generous by design: a real user won't hit these; a script hammering the box will.
RATE_LIMITS = {                                        # path → (max requests, window seconds)
    "/api/analyze": (_env_int("RL_ANALYZE", 40), 60),
    "/api/inpaint": (_env_int("RL_INPAINT", 200), 60),
    "/api/export": (_env_int("RL_EXPORT", 40), 60),
}
_hits: dict[tuple, list] = {}


def _client_ip(request) -> str:
    fwd = request.headers.get("x-forwarded-for", "")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else "?"


@app.middleware("http")
async def rate_limit(request, call_next):
    limit = RATE_LIMITS.get(request.url.path)
    if limit:
        cap, window = limit
        now = time.time()
        key = (request.url.path, _client_ip(request))
        recent = [t for t in _hits.get(key, []) if now - t < window]
        if len(recent) >= cap:
            return JSONResponse({"detail": "Too many requests — please slow down."},
                                status_code=429)
        recent.append(now)
        _hits[key] = recent
        if len(_hits) > 5000:                          # occasional cleanup
            for k in [k for k, v in _hits.items() if all(now - t > 120 for t in v)]:
                _hits.pop(k, None)
    return await call_next(request)


@app.middleware("http")
async def cache_headers(request, call_next):
    """Cache Vite's hashed assets forever; always revalidate HTML."""
    resp = await call_next(request)
    p = request.url.path
    if p.startswith("/assets/"):                       # immutable, content-hashed filenames
        resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    elif p == "/" or p.endswith(".html"):
        resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    return resp


# ── Number classification (mirrors the frontend) ────────────────────────────
_DIGIT = re.compile(r"\d")
_PURE = re.compile(r"^[\d\s.,:;/$%#'\"x×()\-–—+&]+$")


def classify(text: str):
    s = (text or "").strip()
    if not _DIGIT.search(s):
        return None
    return "number" if _PURE.match(s) else "mixed"


_NUM = set("0123456789")
_SEP = set(".,:/-")  # kept only when sitting between two digits (e.g. 1,250.00)


def _union(bb, o):
    bb[0] = min(bb[0], o[0]); bb[1] = min(bb[1], o[1])
    bb[2] = max(bb[2], o[2]); bb[3] = max(bb[3], o[3])


def extract_number_runs(page):
    """Character-level number detection: group consecutive digits into tight runs,
    so each number gets a box hugging its glyphs (and 'Ref:12345' yields just
    '12345'). Horizontal bounds come from the glyph boxes; vertical bounds are
    derived from the baseline + font size so the box hugs the digits (no line
    whitespace). Returns [{text, rect(points)}]; empty on image-only pages."""
    runs = []
    raw = page.get_text("rawdict")
    for block in raw.get("blocks", []):
        for line in block.get("lines", []):
            for span in line.get("spans", []):
                chars = span.get("chars", [])
                size = span.get("size", 0) or 0
                n = len(chars)
                cur = None

                def flush():
                    nonlocal cur
                    if cur and any(d in _NUM for d in cur["text"]):
                        runs.append(cur)
                    cur = None

                for i, ch in enumerate(chars):
                    c = ch.get("c", ""); bb = ch.get("bbox"); org = ch.get("origin")
                    if not bb:
                        flush(); continue
                    keep = c in _NUM or (c in _SEP and cur is not None
                                         and i + 1 < n and chars[i + 1].get("c", "") in _NUM)
                    if keep:
                        base = org[1] if org else bb[3]
                        if cur is None:
                            cur = {"text": "", "x0": bb[0], "x1": bb[2], "base": base,
                                   "size": size or (bb[3] - bb[1])}
                        cur["text"] += c
                        cur["x0"] = min(cur["x0"], bb[0]); cur["x1"] = max(cur["x1"], bb[2])
                    else:
                        flush()
                flush()

    out = []
    for r in runs:
        s = r["size"] or 10.0
        out.append({"text": r["text"],
                    "rect": [r["x0"], r["base"] - 0.74 * s, r["x1"], r["base"] + 0.06 * s]})
    return out


def cleanup_sessions():
    now = time.time()
    for k in [k for k, v in SESSIONS.items() if now - v["created"] > SESSION_TTL]:
        SESSIONS.pop(k, None)
    if len(SESSIONS) > 30:
        for k in sorted(SESSIONS, key=lambda k: SESSIONS[k]["created"])[:-30]:
            SESSIONS.pop(k, None)


def _get_session(sid: str):
    sess = SESSIONS.get(sid)
    if not sess:
        raise HTTPException(404, "Session expired — please re-upload.")
    sess["created"] = time.time()
    return sess


def _open_document(data: bytes, filename: str, content_type: str):
    """Open a PDF, or convert an uploaded image into a 1-page PDF."""
    name = (filename or "").lower()
    is_pdf = content_type == "application/pdf" or name.endswith(".pdf") or data[:5] == b"%PDF-"
    if is_pdf:
        return fitz.open(stream=data, filetype="pdf"), data
    # image → PNG → 1-page PDF (Pillow handles jpg/png/webp/heic-ish/etc.)
    img = PILImage.open(io.BytesIO(data)).convert("RGB")
    buf = io.BytesIO(); img.save(buf, "PNG")
    imgdoc = fitz.open(stream=buf.getvalue(), filetype="png")
    pdfbytes = imgdoc.convert_to_pdf(); imgdoc.close()
    return fitz.open("pdf", pdfbytes), pdfbytes


# ── /api/analyze ────────────────────────────────────────────────────────────
@app.post("/api/analyze")
async def analyze(file: UploadFile = File(...)):
    data = await file.read()
    if not data:
        raise HTTPException(400, "Empty file")
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, f"File too large (max {MAX_UPLOAD_BYTES // (1024 * 1024)} MB).")
    try:
        doc, pdf_bytes = _open_document(data, file.filename, file.content_type or "")
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(400, "Could not open that file (PDF or image expected).")
    n_pages = doc.page_count
    if n_pages == 0:
        doc.close()
        raise HTTPException(400, "Document has no pages")
    if n_pages > MAX_PAGES:
        doc.close()
        raise HTTPException(413, f"Too many pages ({n_pages}); the limit is {MAX_PAGES}.")

    sid = uuid.uuid4().hex
    pages_out, pages_store = [], []
    bid = 1

    for pno in range(doc.page_count):
        page = doc[pno]
        # cap resolution so large photos/PDFs never overwhelm the browser
        rect = page.rect
        scale = min(RENDER_SCALE, MAX_DIM / max(1.0, rect.width, rect.height))
        scale = max(scale, 0.5)
        pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False, colorspace=fitz.csRGB)
        png = pix.tobytes("png")

        tscale = THUMB_WIDTH / max(1.0, rect.width)
        tpix = page.get_pixmap(matrix=fitz.Matrix(tscale, tscale), alpha=False, colorspace=fitz.csRGB)
        thumb = tpix.tobytes("png")

        boxes, meta = [], []
        for run in extract_number_runs(page):       # tight, char-level number boxes
            x0, y0, x1, y1 = run["rect"]
            pad = max(0.4, (y1 - y0) * 0.05)         # hug the glyphs, just a hair of margin
            x0 -= pad; y0 -= pad; x1 += pad; y1 += pad
            boxes.append({"id": bid, "x": x0 * scale, "y": y0 * scale,
                          "w": (x1 - x0) * scale, "h": (y1 - y0) * scale,
                          "text": run["text"], "kind": "number"})
            meta.append({"id": bid, "rect": [x0, y0, x1, y1]})
            bid += 1

        scanned = len(page.get_text("words")) == 0
        if scanned and HAS_OCR:
            bid = _ocr_page(png, scale, boxes, meta, bid)

        pages_store.append({"png": png, "thumb": thumb, "boxes": meta, "scale": scale})
        pages_out.append({"index": pno, "width": pix.width, "height": pix.height,
                          "scanned": scanned, "boxes": boxes})

    doc.close()
    SESSIONS[sid] = {"pdf": pdf_bytes, "pages": pages_store, "created": time.time()}
    cleanup_sessions()
    return {"session": sid, "ocrAvailable": HAS_OCR, "pages": pages_out}


def _ocr_page(png_bytes, scale, boxes, meta, bid):
    """Detect numbers via Tesseract on a cleaned-up image. Coords map back to page px."""
    pil, up = scan.preprocess_for_ocr(png_bytes)
    data = pytesseract.image_to_data(pil, config="--oem 3 --psm 3",
                                     output_type=pytesseract.Output.DICT)
    for i, word in enumerate(data["text"]):
        kind = classify(word)
        if not kind:
            continue
        try:
            conf = float(data["conf"][i])
        except (ValueError, TypeError):
            conf = 0
        if conf < 30:
            continue
        # OCR coords are in the upscaled image → divide by `up` to get page px
        x = data["left"][i] / up
        y = data["top"][i] / up
        w = data["width"][i] / up
        h = data["height"][i] / up
        boxes.append({"id": bid, "x": x, "y": y, "w": w, "h": h, "text": word.strip(), "kind": kind})
        meta.append({"id": bid, "rect": [x / scale, y / scale, (x + w) / scale, (y + h) / scale]})
        bid += 1
    return bid


# ── Page / thumbnail streaming ──────────────────────────────────────────────
def _png(data: bytes):
    return Response(content=data, media_type="image/png", headers={"Cache-Control": "no-store"})


@app.get("/api/page/{sid}/{idx}")
async def get_page(sid: str, idx: int):
    sess = _get_session(sid)
    if not 0 <= idx < len(sess["pages"]):
        raise HTTPException(404, "No such page")
    return _png(sess["pages"][idx]["png"])


@app.get("/api/thumb/{sid}/{idx}")
async def get_thumb(sid: str, idx: int):
    sess = _get_session(sid)
    if not 0 <= idx < len(sess["pages"]):
        raise HTTPException(404, "No such page")
    return _png(sess["pages"][idx]["thumb"])


# ── /api/inpaint (seamless removal) ─────────────────────────────────────────
def _hex_to_rgb(hex_str: str):
    h = (hex_str or "").lstrip("#")
    if len(h) != 6:
        return (255, 255, 255)
    try:
        return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))
    except ValueError:
        return (255, 255, 255)


@app.post("/api/inpaint")
async def inpaint_ep(file: UploadFile = File(...), rects: str = Form("[]"),
                     fillMode: str = Form("auto"), color: str = Form("#ffffff")):
    data = await file.read()
    if not data:
        raise HTTPException(400, "No image")
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, f"Image too large (max {MAX_UPLOAD_BYTES // (1024 * 1024)} MB).")
    try:
        rs = json.loads(rects)
    except Exception:
        rs = []
    fixed_rgb = _hex_to_rgb(color) if fillMode == "fixed" else None
    try:
        out = scan.inpaint(data, rs, fixed_rgb=fixed_rgb)
    except Exception as e:
        raise HTTPException(500, f"Inpaint failed: {e}")
    return _png(out)


# ── /api/export (assemble edited page images into a PDF) ─────────────────────
# The exported pages are already flattened to images by the client, so the PDF
# carries no recoverable text layer — the erased numbers are truly gone.
@app.post("/api/export")
async def export(files: list[UploadFile] = File(...)):
    if not files:
        raise HTTPException(400, "No pages to export.")
    if len(files) > MAX_PAGES:
        raise HTTPException(413, f"Too many pages ({len(files)}); the limit is {MAX_PAGES}.")
    doc = fitz.open()
    try:
        for f in files:
            b = await f.read()
            imgdoc = fitz.open(stream=b, filetype="png")
            pdfb = imgdoc.convert_to_pdf(); imgdoc.close()
            src = fitz.open("pdf", pdfb)
            doc.insert_pdf(src); src.close()
        out = doc.tobytes(garbage=3, deflate=True)
    finally:
        doc.close()
    return Response(content=out, media_type="application/pdf",
                    headers={"Content-Disposition": 'attachment; filename="bol-edited.pdf"'})


@app.get("/api/health")
async def health():
    return JSONResponse({"ok": True, "ocr": HAS_OCR, "sessions": len(SESSIONS)})


# ── Static frontend (mounted last so /api/* wins) ───────────────────────────
# Serve the built React app (web/dist) when present; otherwise the legacy root.
_WEB_DIST = ROOT / "web" / "dist"
_STATIC_DIR = _WEB_DIST if (_WEB_DIST / "index.html").exists() else ROOT
app.mount("/", StaticFiles(directory=str(_STATIC_DIR), html=True), name="static")
