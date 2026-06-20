"""
BOL Editor — backend.

  /api/analyze        — PDF *or* image upload → renders pages, detects numbers
                        (text layer + Tesseract OCR), returns lightweight metadata.
  /api/page/{s}/{i}   — streams a full-resolution page PNG (lazy-loaded).
  /api/thumb/{s}/{i}  — streams a thumbnail PNG.
  /api/enhance        — CamScanner-style filters: auto/magic/gray/B&W, brightness,
                        contrast, sharpen, deskew, auto edge-detect & crop.
  /api/process        — true PyMuPDF redaction (text removed + background fill).
  /api/export         — assembles edited page images into a downloadable PDF.

Also serves the static frontend, so one `uvicorn` command runs everything.
"""

from __future__ import annotations

import io
import json
import re
import time
import uuid
from collections import defaultdict
from pathlib import Path

import fitz  # PyMuPDF
from fastapi import Body, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from PIL import Image as PILImage
from pydantic import BaseModel

import scan  # local image-enhancement engine

# ── Optional OCR (used when a page has no text layer) ───────────────────────
try:
    import pytesseract
    pytesseract.get_tesseract_version()
    HAS_OCR = True
except Exception:
    HAS_OCR = False

ROOT = Path(__file__).resolve().parent.parent          # the bol-editor/ folder
RENDER_SCALE = 2.0                                     # points → pixels (digital PDFs)
MAX_DIM = 2200                                         # cap longest page side (px)
THUMB_WIDTH = 220
SESSION_TTL = 3600
SESSIONS: dict[str, dict] = {}

app = FastAPI(title="BOL Editor API")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.middleware("http")
async def no_cache_static(request, call_next):
    """Always revalidate HTML/JS/CSS so the browser never runs stale code."""
    resp = await call_next(request)
    p = request.url.path
    if p == "/" or p.endswith((".html", ".js", ".css")):
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


def hex_to_unit(hex_str: str):
    h = hex_str.lstrip("#")
    if len(h) != 6:
        return (1.0, 1.0, 1.0)
    return (int(h[0:2], 16) / 255, int(h[2:4], 16) / 255, int(h[4:6], 16) / 255)


def sample_background(pix, x0, y0, x1, y1):
    W, H, n, stride, buf = pix.width, pix.height, pix.n, pix.stride, pix.samples
    pad = max(4, int((y1 - y0) * 0.5))
    ex0, ey0 = max(0, int(x0 - pad)), max(0, int(y0 - pad))
    ex1, ey1 = min(W, int(x1 + pad)), min(H, int(y1 + pad))
    ix0, iy0, ix1, iy1 = int(x0), int(y0), int(x1), int(y1)
    counts: dict[tuple, list] = {}
    for py in range(ey0, ey1):
        inside_y = iy0 <= py < iy1
        row = py * stride
        for px in range(ex0, ex1):
            if inside_y and ix0 <= px < ix1:
                continue
            off = row + px * n
            r, g, b = buf[off], buf[off + 1], buf[off + 2]
            key = (r & 0xF8, g & 0xF8, b & 0xF8)
            c = counts.get(key)
            if c is None:
                counts[key] = c = [0, 0, 0, 0]
            c[0] += 1; c[1] += r; c[2] += g; c[3] += b
    if not counts:
        return (1.0, 1.0, 1.0)
    best = max(counts.values(), key=lambda c: c[0])
    return (best[1] / best[0] / 255, best[2] / best[0] / 255, best[3] / best[0] / 255)


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
    try:
        doc, pdf_bytes = _open_document(data, file.filename, file.content_type or "")
    except Exception:
        raise HTTPException(400, "Could not open that file (PDF or image expected).")
    if doc.page_count == 0:
        raise HTTPException(400, "Document has no pages")

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


# ── /api/enhance (CamScanner-style) ─────────────────────────────────────────
class EnhanceReq(BaseModel):
    session: str
    page: int
    mode: str = "original"        # original | auto | magic | gray | bw
    brightness: float = 0.0       # -100..100
    contrast: float = 1.0         # 0.4..2.5
    sharpen: float = 0.0          # 0..1.5
    deskew: bool = False
    autocrop: bool = False


@app.post("/api/enhance")
async def enhance(req: EnhanceReq = Body(...)):
    sess = _get_session(req.session)
    if not 0 <= req.page < len(sess["pages"]):
        raise HTTPException(404, "No such page")
    src = sess["pages"][req.page]["png"]
    try:
        out = scan.process(src, mode=req.mode, brightness=req.brightness,
                           contrast=req.contrast, sharpen=req.sharpen,
                           do_deskew=req.deskew, do_autocrop=req.autocrop)
    except Exception as e:
        raise HTTPException(500, f"Enhance failed: {e}")
    return _png(out)


# ── /api/inpaint (seamless removal) ─────────────────────────────────────────
@app.post("/api/inpaint")
async def inpaint_ep(file: UploadFile = File(...), rects: str = Form("[]")):
    data = await file.read()
    if not data:
        raise HTTPException(400, "No image")
    try:
        rs = json.loads(rects)
    except Exception:
        rs = []
    try:
        out = scan.inpaint(data, rs)
    except Exception as e:
        raise HTTPException(500, f"Inpaint failed: {e}")
    return _png(out)


# ── /api/process (true redaction) ───────────────────────────────────────────
class Removal(BaseModel):
    boxId: int


class Manual(BaseModel):
    page: int
    x: float
    y: float
    w: float
    h: float


class ProcessReq(BaseModel):
    session: str
    removals: list[Removal] = []
    manuals: list[Manual] = []
    fillMode: str = "auto"
    color: str = "#ffffff"


@app.post("/api/process")
async def process(req: ProcessReq = Body(...)):
    sess = _get_session(req.session)
    pages = sess["pages"]

    id_map: dict[int, tuple[int, list]] = {}
    for pidx, pm in enumerate(pages):
        for b in pm["boxes"]:
            id_map[b["id"]] = (pidx, b["rect"])

    rects_by_page: dict[int, list] = defaultdict(list)
    for r in req.removals:
        hit = id_map.get(r.boxId)
        if hit:
            rects_by_page[hit[0]].append(hit[1])
    for m in req.manuals:
        s = pages[m.page]["scale"]
        rects_by_page[m.page].append([m.x / s, m.y / s, (m.x + m.w) / s, (m.y + m.h) / s])

    if not rects_by_page:
        raise HTTPException(400, "Nothing selected to remove.")

    doc = fitz.open(stream=sess["pdf"], filetype="pdf")
    fixed_rgb = hex_to_unit(req.color)
    for pidx, rects in rects_by_page.items():
        page = doc[pidx]
        s = pages[pidx]["scale"]
        pix = page.get_pixmap(matrix=fitz.Matrix(s, s), alpha=False, colorspace=fitz.csRGB) \
            if req.fillMode == "auto" else None
        for x0, y0, x1, y1 in rects:
            color = sample_background(pix, x0 * s, y0 * s, x1 * s, y1 * s) \
                if req.fillMode == "auto" else fixed_rgb
            page.add_redact_annot(fitz.Rect(x0, y0, x1, y1), fill=color)
        page.apply_redactions()

    out = doc.tobytes(garbage=3, deflate=True)
    doc.close()
    return Response(content=out, media_type="application/pdf",
                    headers={"Content-Disposition": 'attachment; filename="bol-cleaned.pdf"'})


# ── /api/export (assemble edited page images into a PDF) ─────────────────────
@app.post("/api/export")
async def export(files: list[UploadFile] = File(...)):
    if not files:
        raise HTTPException(400, "No pages to export.")
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
