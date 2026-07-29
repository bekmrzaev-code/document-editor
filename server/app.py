"""
DocEdit — AI-assisted document text editor. Backend.

  POST /api/analyze       — PDF *or* image upload → renders pages, detects every
                            text run (word-level, with style metadata).
  GET  /api/page/{s}/{i}  — streams a full-resolution page PNG (lazy-loaded).
  GET  /api/thumb/{s}/{i} — streams a thumbnail PNG.
  POST /api/erase         — seamless removal of rectangles (auto background or fixed fill).
  POST /api/export        — flattens edited page images into a downloadable PDF.
  GET  /api/health        — liveness + capability flags.

Also serves the built frontend (web/dist), so one `uvicorn` command runs everything.
"""

from __future__ import annotations

import asyncio
import io
import json
import os
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from typing import Optional
from pathlib import Path

import fitz  # PyMuPDF
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from PIL import Image as PILImage

import notify
import scan
from extract import extract_text_runs
from store import SessionStore


def _load_env(path: Path):
    """Tiny .env loader (KEY=VALUE lines); real env vars win over the file."""
    try:
        for line in path.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())
    except FileNotFoundError:
        pass


_load_env(Path(__file__).resolve().parent / ".env")

import ai_edit  # noqa: E402  (needs the .env loaded first for its MODEL default)

# ── Optional OCR (used when a page has no text layer) ───────────────────────
try:
    import pytesseract
    pytesseract.get_tesseract_version()
    HAS_OCR = True
except Exception:
    HAS_OCR = False


def _ocr_languages() -> list[str]:
    """Language packs installed alongside Tesseract ("eng", "rus", "uzb", …).

    Without a language the engine assumes English, which reads Cyrillic and the
    Uzbek o'/g' digraphs badly — the UI offers this list so the user can pick.
    """
    if not HAS_OCR:
        return []
    # osd/snum/equ are helper models (orientation, serial numbers, equations),
    # not languages — offering them in the picker would just confuse.
    helpers = {"osd", "snum", "equ"}
    try:
        langs = [x for x in pytesseract.get_languages(config="") if x not in helpers]
    except Exception:
        return ["eng"]
    return sorted(langs) or ["eng"]


OCR_LANGS = _ocr_languages()
DEFAULT_OCR_LANG = os.environ.get("OCR_LANG", "eng")


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


ROOT = Path(__file__).resolve().parent.parent          # the repo root
RENDER_SCALE = 2.0                                     # PDF points → pixels
MAX_DIM = 2200                                         # cap longest page side (px)
THUMB_WIDTH = 220
SESSION_TTL = _env_int("SESSION_TTL", 3600)            # idle session lifetime (s)
# Tesseract runs as a subprocess and OpenCV releases the GIL, so scanned pages
# OCR in parallel. Capped low — each worker holds a full page image in memory.
OCR_WORKERS = _env_int("OCR_WORKERS", min(4, os.cpu_count() or 2))

# ── Abuse guards (keep the app open to everyone — these only stop DoS) ───────
MAX_UPLOAD_BYTES = _env_int("MAX_UPLOAD_BYTES", 30 * 1024 * 1024)
MAX_PAGES = _env_int("MAX_PAGES", 60)
PILImage.MAX_IMAGE_PIXELS = _env_int("MAX_IMAGE_PIXELS", 40_000_000)

STORE = SessionStore(
    root=Path(os.environ.get("SESSION_DIR", str(Path(__file__).resolve().parent / "sessions"))),
    ttl=SESSION_TTL,
    persist=os.environ.get("SESSION_PERSIST", "1") not in ("0", "false", "no"),
)

app = FastAPI(title="DocEdit API")

# Same-origin (the backend serves the UI) needs no CORS. Set
# ALLOWED_ORIGINS="https://a.com,https://b.com" if the UI is hosted elsewhere.
_origins = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "").split(",") if o.strip()]
if _origins:
    app.add_middleware(CORSMiddleware, allow_origins=_origins,
                       allow_methods=["*"], allow_headers=["*"])


# ── Lightweight per-IP rate limiting for the heavy endpoints ────────────────
RATE_LIMITS = {                                        # path → (max requests, window s)
    "/api/analyze": (_env_int("RL_ANALYZE", 40), 60),
    "/api/erase": (_env_int("RL_ERASE", 200), 60),
    "/api/export": (_env_int("RL_EXPORT", 40), 60),
    "/api/ai-chat": (_env_int("RL_AI", 15), 60),
    "/api/ai-edit": (_env_int("RL_AI", 15), 60),
    "/api/ai-ocr": (_env_int("RL_AI", 15), 60),
    "/api/ai-fonts": (_env_int("RL_AI", 15), 60),
    "/api/digitize": (_env_int("RL_DIGITIZE", 10), 60),
    "/api/rotate": (_env_int("RL_ROTATE", 60), 60),
    "/api/support": (_env_int("RL_SUPPORT", 6), 60),
}
_hits: dict[tuple, list] = {}

# ── Support inbox (user problem reports) ────────────────────────────────────
SUPPORT_DIR = Path(os.environ.get("SUPPORT_DIR", str(Path(__file__).resolve().parent / "support")))


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


# ── Sessions ─────────────────────────────────────────────────────────────────
def _get_session(sid: str) -> dict:
    sess = STORE.get(sid)
    if not sess:
        raise HTTPException(404, "Session expired — please re-upload.")
    return sess


def _open_document(data: bytes, filename: str, content_type: str):
    """Open a PDF, or convert an uploaded image into a 1-page PDF."""
    name = (filename or "").lower()
    is_pdf = content_type == "application/pdf" or name.endswith(".pdf") or data[:5] == b"%PDF-"
    if is_pdf:
        return fitz.open(stream=data, filetype="pdf"), data
    img = PILImage.open(io.BytesIO(data)).convert("RGB")
    buf = io.BytesIO(); img.save(buf, "PNG")
    imgdoc = fitz.open(stream=buf.getvalue(), filetype="png")
    pdfbytes = imgdoc.convert_to_pdf(); imgdoc.close()
    return fitz.open("pdf", pdfbytes), pdfbytes


# ── /api/analyze ─────────────────────────────────────────────────────────────
@app.post("/api/analyze")
async def analyze(file: UploadFile = File(...), lang: str = Form("")):
    lang = _clean_lang(lang)
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
    # Rasterize serially — a fitz.Document must not be touched from two threads.
    try:
        rendered = [_render_page(doc[p]) for p in range(n_pages)]
        rotations = [doc[p].rotation for p in range(n_pages)]
    finally:
        doc.close()

    # …then OCR the scanned pages concurrently. Tesseract runs as a subprocess
    # and OpenCV releases the GIL, so on a multi-page scan this is the whole
    # difference between waiting once and waiting once per page.
    scans = [i for i, r in enumerate(rendered) if r["scanned"]] if HAS_OCR else []
    ocr_by_page: dict[int, tuple] = {}
    if len(scans) > 1:
        with ThreadPoolExecutor(max_workers=min(OCR_WORKERS, len(scans))) as pool:
            futures = {i: pool.submit(_ocr_page, rendered[i]["png"], rendered[i]["scale"], lang)
                       for i in scans}
            ocr_by_page = {i: f.result() for i, f in futures.items()}
    elif scans:
        i = scans[0]
        ocr_by_page[i] = _ocr_page(rendered[i]["png"], rendered[i]["scale"], lang)

    pages_out, pages_store = [], []
    bid = 1
    for pno, r in enumerate(rendered):
        out_p, store_p, bid = _page_payload(r, bid, ocr_by_page.get(pno))
        store_p["src"] = pno                   # which PDF page this came from
        store_p["rot"] = rotations[pno]
        out_p["index"] = pno
        pages_store.append(store_p)
        pages_out.append(out_p)

    STORE.put(sid, {"pdf": pdf_bytes, "pages": pages_store, "created": time.time(),
                    "nextBid": bid, "lang": lang})
    return {"session": sid, "ocrAvailable": HAS_OCR, "aiAvailable": ai_edit.available(),
            "ocrLangs": OCR_LANGS, "lang": lang, "pages": pages_out}


def _render_page(page) -> dict:
    """Rasterize one page and pull its digital text layer off.

    Everything here needs the PyMuPDF document, which is not thread-safe — so
    this stays serial while the expensive OCR that follows does not.
    """
    rect = page.rect
    scale = min(RENDER_SCALE, MAX_DIM / max(1.0, rect.width, rect.height))
    scale = max(scale, 0.5)
    pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False, colorspace=fitz.csRGB)
    tscale = THUMB_WIDTH / max(1.0, rect.width)
    tpix = page.get_pixmap(matrix=fitz.Matrix(tscale, tscale), alpha=False, colorspace=fitz.csRGB)
    return {"png": pix.tobytes("png"), "thumb": tpix.tobytes("png"), "scale": scale,
            "ptw": rect.width, "pth": rect.height, "pw": pix.width, "ph": pix.height,
            "runs": extract_text_runs(page), "scanned": len(page.get_text("words")) == 0}


def _page_payload(r: dict, bid: int, ocr=None):
    """Turn a rendered page into ``(page_out, page_store, next_bid)`` — the
    client payload (render pixels) and the server-side record (PDF points, used
    by the AI endpoints and digitize).

    ``ocr`` is a precomputed ``(boxes, meta)`` pair for a scanned page, so the
    OCR can have run concurrently; ids are handed out here instead, keeping
    them sequential in page order regardless.
    """
    scale = r["scale"]
    boxes, meta = [], []
    for run in r["runs"]:
        x0, y0, x1, y1 = run["rect"]
        boxes.append({"id": bid, "x": x0 * scale, "y": y0 * scale,
                      "w": (x1 - x0) * scale, "h": (y1 - y0) * scale,
                      "text": run["text"], "kind": "text",
                      "base": run["base"] * scale, "fontSize": run["fontSize"] * scale,
                      "color": run["color"], "bold": run["bold"],
                      "italic": run["italic"], "family": run["family"],
                      "fontName": run["font"]})
        meta.append({"id": bid, "rect": [x0, y0, x1, y1], "text": run["text"],
                     "base": run["base"],
                     "fontSize": run["fontSize"], "color": run["color"],
                     "bold": run["bold"], "italic": run["italic"],
                     "family": run["family"], "block": run["block"], "line": run["line"]})
        bid += 1

    if ocr:
        for box, mt in zip(*ocr):
            box["id"] = mt["id"] = bid
            boxes.append(box)
            meta.append(mt)
            bid += 1

    store = {"png": r["png"], "thumb": r["thumb"], "scale": scale, "boxes": meta,
             "ptw": r["ptw"], "pth": r["pth"], "scanned": r["scanned"]}
    out = {"width": r["pw"], "height": r["ph"], "scanned": r["scanned"], "boxes": boxes}
    return out, store, bid


def _analyze_page(page, bid: int, lang: str):
    """Render and fully detect a single page — the /api/rotate path, where
    there is nothing to run concurrently."""
    r = _render_page(page)
    ocr = _ocr_page(r["png"], r["scale"], lang) if r["scanned"] and HAS_OCR else None
    return _page_payload(r, bid, ocr)


# ── Page operations (rotate / reorder / delete) ──────────────────────────────
@app.post("/api/rotate")
async def rotate(session: str = Form(...), page: int = Form(...), deg: int = Form(90)):
    """Rotate one page and RE-DETECT its text.

    Rotating the client's canvases alone would leave every text box pointing at
    the wrong pixels — worse, a sideways scan would keep its sideways boxes. So
    the page is re-rendered from the stored PDF at its new rotation and run
    through the same detection path as a fresh upload; the client reloads it.
    """
    sess = _get_session(session)
    if not 0 <= page < len(sess["pages"]):
        raise HTTPException(404, "No such page")
    if deg % 90 != 0:
        raise HTTPException(400, "Rotation must be a multiple of 90°.")
    p = sess["pages"][page]
    doc = fitz.open(stream=sess["pdf"], filetype="pdf")
    try:
        src = p.get("src", page)
        if not 0 <= src < doc.page_count:
            raise HTTPException(404, "Page is no longer in the document")
        pg = doc[src]
        rot = (p.get("rot", pg.rotation) + int(deg)) % 360
        pg.set_rotation(rot)
        bid = sess.get("nextBid", 1)
        out_p, store_p, bid = _analyze_page(pg, bid, sess.get("lang", ""))
    finally:
        doc.close()
    store_p["src"] = src
    store_p["rot"] = rot
    sess["pages"][page] = store_p
    sess["nextBid"] = bid
    STORE.save_page(session, page)             # only this page's pixels changed
    out_p["index"] = page
    out_p["rotation"] = rot
    return {"page": out_p}


@app.post("/api/pages")
async def reorder_pages(session: str = Form(...), order: str = Form(...)):
    """Reorder and/or drop pages. ``order`` is a JSON array of the CURRENT page
    indices to keep, in their new order — omitting an index deletes that page.

    The server has to follow along: digitize, AI edit and AI chat all read the
    session's page list, and they would otherwise still see pages the user
    deleted minutes ago.
    """
    sess = _get_session(session)
    n = len(sess["pages"])
    try:
        idx = json.loads(order)
    except ValueError:
        raise HTTPException(400, "Malformed page order")
    if (not isinstance(idx, list) or not idx
            or not all(isinstance(i, int) and 0 <= i < n for i in idx)
            or len(set(idx)) != len(idx)):
        raise HTTPException(400, "Page order must be distinct indices of existing pages.")
    sess["pages"] = [sess["pages"][i] for i in idx]
    STORE.put(session, sess)
    return {"pages": len(sess["pages"])}


_ASCENDERS = set("bdfhklt!?$&@#%/\\()[]{}\"'`|0123456789")
_DESCENDERS = set("gjpqy")


def _ocr_metrics(text: str, y: float, h: float):
    """Estimate the em size and baseline of an OCR word from its tight bbox.

    Tesseract's box hugs the glyphs, so its height depends on WHICH letters the
    word contains (caps reach ~0.72 em, x-height letters only ~0.52 em,
    descenders add ~0.21 em below the baseline). Using the height directly
    made replacements render visibly smaller than their neighbours.

    Oversized boxes (whole table cells) are handled upstream by the ink refit
    (scan.tighten_box) and downstream by the page-median size cap — an extra
    width-based ceiling here misfired on condensed fonts."""
    has_asc = any(c.isupper() or c in _ASCENDERS for c in text)
    has_desc = any(c in _DESCENDERS for c in text)
    if has_asc and has_desc:
        ratio, desc = 0.92, True
    elif has_asc:
        ratio, desc = 0.72, False
    elif has_desc:
        ratio, desc = 0.73, True
    else:
        ratio, desc = 0.52, False
    size = h / ratio
    base = y + h - (0.21 * size if desc else 0)
    return size, base


def _styled_word(cv_img, text, rx, ry, rw, rh, scale, bid, block=0, line=0):
    """Build a client box + server meta for one raw word rect, estimating its
    style from the pixels. Shared by the Tesseract path and AI Sync.

    Tesseract/Gemini sometimes box a whole table cell — refit to the ink pixels
    for the STYLE estimate (size/baseline/weight), but keep the full raw
    horizontal span for the click/erase geometry: blur can drop a faint edge
    glyph from the ink mask, and a glyph left outside the box survives the
    erase ("H14629"→"H99999" gave "HH99999")."""
    tx0, ty0, tx1, ty1 = scan.tighten_box(cv_img, (rx, ry, rx + rw, ry + rh))
    x = min(rx, tx0)
    w = max(rx + rw, tx1) - x
    y, h = ty0, max(1.0, ty1 - ty0)
    size, base = _ocr_metrics(text, y, h)
    rgb = scan.sample_ink_color(cv_img, (x, y, x + w, y + h))
    color = "#{:02x}{:02x}{:02x}".format(*rgb)
    stroke = scan.stroke_width(cv_img, (x, y, x + w, y + h))
    box = {"id": bid, "x": x, "y": y, "w": w, "h": h,
           "text": text, "kind": "ocr", "base": base,
           "fontSize": size, "color": color, "_stroke": stroke,
           "bold": False, "italic": False, "family": "sans"}
    mt = {"id": bid, "rect": [x / scale, y / scale, (x + w) / scale, (y + h) / scale],
          "text": text, "base": base / scale, "fontSize": size / scale, "color": color,
          "bold": False, "italic": False, "family": "sans",
          "block": block, "line": line}
    return box, mt


def _calibrate_page_boxes(added, added_meta, scale):
    """Page-level statistical passes over freshly detected word boxes.

    Size cap: catches merged boxes that even the ink refit couldn't shrink (a
    scan border or cell rule crossing the box keeps its ink extent tall) —
    body sizes cluster tightly, so anything far above the page median is a box
    artifact, not a real giant word.

    Bold is RELATIVE within a page: blur inflates every measured stroke, so an
    absolute em-ratio threshold misfires on soft scans."""
    ref = sorted(b["fontSize"] for b in added if len(b["text"]) >= 3)
    if ref:
        med = ref[len(ref) // 2]
        for bx, mt in zip(added, added_meta):
            cap = 1.6 * med if len(bx["text"]) <= 2 else 2.5 * med
            if bx["fontSize"] > cap:
                bx["fontSize"] = cap
                bx["base"] = bx["y"] + (bx["h"] + 0.72 * cap) / 2
                mt["fontSize"] = cap / scale
                mt["base"] = bx["base"] / scale
    ratios = sorted(b["_stroke"] / b["fontSize"] for b in added
                    if b["_stroke"] > 0 and len(b["text"]) >= 3)
    if ratios:
        rmed = ratios[len(ratios) // 2]
        for bx, mt in zip(added, added_meta):
            bold = rmed > 0 and bx["_stroke"] / bx["fontSize"] > rmed * 1.3
            bx["bold"] = bold
            mt["bold"] = bold
    for bx in added:
        bx.pop("_stroke", None)


def _clean_lang(lang: str) -> str:
    """Validate a requested OCR language against what Tesseract actually has.

    Accepts Tesseract's multi-language form ("uzb+eng"): unknown codes are
    dropped rather than rejected, because a missing pack must not turn a
    perfectly analyzable upload into an error.
    """
    codes = [c for c in (lang or "").replace(" ", "").split("+") if c]
    keep = [c for c in codes if c in OCR_LANGS] if OCR_LANGS else []
    return "+".join(dict.fromkeys(keep)) or DEFAULT_OCR_LANG


def _ocr_page(png_bytes, scale, lang: str = ""):
    """Detect ALL words via Tesseract on a cleaned-up image. Style is estimated:
    em size + baseline from the glyph box (see _ocr_metrics), color sampled from
    the pixels. Coords map back to page px via the upscale factor.

    Returns ``(boxes, meta)`` carrying placeholder ids — this runs in a worker
    thread, so the caller numbers the runs afterwards to keep ids sequential in
    page order. Touches nothing but its own arguments.
    """
    boxes, meta = [], []
    pil, up = scan.preprocess_for_ocr(png_bytes)
    cv_img = scan._to_cv(png_bytes)                    # color image for ink sampling
    data = pytesseract.image_to_data(pil, lang=lang or DEFAULT_OCR_LANG,
                                     config="--oem 3 --psm 3",
                                     output_type=pytesseract.Output.DICT)
    for i, word in enumerate(data["text"]):
        text = (word or "").strip()
        if not text:
            continue
        try:
            conf = float(data["conf"][i])
        except (ValueError, TypeError):
            conf = 0
        if conf < 30:
            continue
        box, mt = _styled_word(cv_img, text,
                               data["left"][i] / up, data["top"][i] / up,
                               data["width"][i] / up, data["height"][i] / up,
                               scale, 0,
                               block=int(data["block_num"][i]), line=int(data["line_num"][i]))
        boxes.append(box)
        meta.append(mt)
    _calibrate_page_boxes(boxes, meta, scale)
    return boxes, meta


# ── Page / thumbnail streaming ───────────────────────────────────────────────
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


# ── AI assistant ─────────────────────────────────────────────────────────────
def _doc_text(sess: dict, max_chars: int = 100_000) -> str:
    """Assemble the document text from the stored word runs, page by page."""
    parts = []
    for pno, p in enumerate(sess["pages"]):
        words = " ".join(b["text"] for b in p["boxes"])
        parts.append(f"[Page {pno + 1}]\n{words}")
    return "\n\n".join(parts)[:max_chars]


@app.post("/api/ai-chat")
async def ai_chat(session: str = Form(...), question: str = Form(...)):
    sess = _get_session(session)
    q = question.strip()
    if not q:
        raise HTTPException(400, "Empty question")
    if len(q) > 4000:
        raise HTTPException(413, "Question too long")
    try:
        answer = ai_edit.chat(q, _doc_text(sess))
    except ai_edit.AiUnavailable as e:
        raise HTTPException(503, str(e))
    except ai_edit.AiError as e:
        raise HTTPException(502, str(e))
    return {"answer": answer}


@app.post("/api/ai-edit")
async def ai_edit_ep(session: str = Form(...), instruction: str = Form(...)):
    sess = _get_session(session)
    ins = instruction.strip()
    if not ins:
        raise HTTPException(400, "Empty instruction")
    if len(ins) > 4000:
        raise HTTPException(413, "Instruction too long")
    runs, by_id = [], {}
    for pno, p in enumerate(sess["pages"]):
        for b in p["boxes"]:
            run = {"id": b["id"], "page": pno, "text": b["text"]}
            runs.append(run)
            by_id[b["id"]] = run
    if not runs:
        return {"edits": []}
    try:
        proposals = ai_edit.propose_edits(ins, runs)
    except ai_edit.AiUnavailable as e:
        raise HTTPException(503, str(e))
    except ai_edit.AiError as e:
        raise HTTPException(502, str(e))
    # Hallucination filter: drop edits whose id/oldText don't match the document.
    edits, seen = [], set()
    for e in proposals:
        try:
            rid = int(e.get("id"))
        except (TypeError, ValueError):
            continue
        run = by_id.get(rid)
        if not run or rid in seen:
            continue
        if (e.get("oldText") or "").strip() != run["text"].strip():
            continue
        new = str(e.get("newText") or "")
        if new == run["text"]:
            continue
        seen.add(rid)
        edits.append({"id": rid, "page": run["page"], "oldText": run["text"], "newText": new})
    return {"edits": edits}


def _apply_ocr_fixes(p: dict, fixes: list) -> list[dict]:
    """Validate Gemini's OCR fixes against a stored page and apply them to the
    server-side metadata. Returns the accepted fixes."""
    by_id = {b["id"]: b for b in p["boxes"]}
    out = []
    for f in fixes:
        try:
            fid = int(f.get("id"))
        except (TypeError, ValueError):
            continue
        b = by_id.get(fid)
        text = str(f.get("text") or "").strip()
        if not b or not text or text == b["text"]:
            continue
        b["text"] = text
        out.append({"id": fid, "text": text})
    return out


@app.post("/api/ai-ocr")
async def ai_ocr(session: str = Form(...), page: int = Form(...)):
    """Gemini vision pass over a scanned page: corrects OCR misreads in place."""
    sess = _get_session(session)
    if not 0 <= page < len(sess["pages"]):
        raise HTTPException(404, "No such page")
    p = sess["pages"][page]
    if not p.get("scanned"):
        raise HTTPException(400, "This page already has a digital text layer.")
    words = [{"id": b["id"], "text": b["text"]} for b in p["boxes"]]
    if not words:
        return {"fixes": []}
    try:
        fixes = ai_edit.fix_ocr(p["png"], words)
    except ai_edit.AiUnavailable as e:
        raise HTTPException(503, str(e))
    except ai_edit.AiError as e:
        raise HTTPException(502, str(e))
    applied = _apply_ocr_fixes(p, fixes)
    STORE.save_meta(session)               # corrected text must survive a restart
    return {"fixes": applied}


@app.post("/api/ai-fonts")
async def ai_fonts(session: str = Form(...), page: int = Form(...)):
    """Gemini vision pass: identify the fonts used on a page image."""
    sess = _get_session(session)
    if not 0 <= page < len(sess["pages"]):
        raise HTTPException(404, "No such page")
    try:
        fonts = ai_edit.identify_fonts(sess["pages"][page]["png"])
    except ai_edit.AiUnavailable as e:
        raise HTTPException(503, str(e))
    except ai_edit.AiError as e:
        raise HTTPException(502, str(e))
    return {"fonts": fonts}


# ── /api/digitize (rebuild the scan as a REAL-text PDF) ──────────────────────
_PDF_FONTS = {  # (family, bold, italic) → PDF base-14 shortcut
    "sans": {(False, False): "helv", (True, False): "hebo", (False, True): "heit", (True, True): "hebi"},
    "serif": {(False, False): "tiro", (True, False): "tibo", (False, True): "tiit", (True, True): "tibi"},
    "mono": {(False, False): "cour", (True, False): "cobo", (False, True): "coit", (True, True): "cobi"},
}


def _unicode_font_file() -> Optional[str]:
    """A TTF with Cyrillic / Latin-Extended coverage, for digitize.

    The base-14 PDF fonts above are WinAnsi-encoded, so Cyrillic and the Uzbek
    oʻ/gʻ characters come out blank or garbled. Any word with a non-ASCII
    character is written with this font instead. Set UNICODE_FONT to override
    the search; the Docker image installs DejaVu for the first path.
    """
    candidates = [os.environ.get("UNICODE_FONT", "").strip(),
                  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
                  "/usr/share/fonts/dejavu/DejaVuSans.ttf",
                  "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
                  "/Library/Fonts/Arial Unicode.ttf",
                  "C:/Windows/Fonts/arial.ttf"]
    for c in candidates:
        if c and Path(c).exists():
            return c
    return None


UNICODE_FONT = _unicode_font_file()


@app.post("/api/digitize")
async def digitize(session: str = Form(...), useAi: str = Form("0")):
    """Rebuild the open document as a new PDF that LOOKS like the original but
    carries a real text layer: the background keeps every graphic (lines,
    stamps, barcodes) with the detected text seamlessly erased, and each word
    is re-inserted as genuine PDF text at its original position/size/color.
    The result is fully searchable and much easier to edit on re-upload."""
    sess = _get_session(session)
    use_ai = useAi in ("1", "true", "yes") and ai_edit.available()
    out = fitz.open()
    try:
        for p in sess["pages"]:
            if use_ai and p.get("scanned") and p["boxes"]:
                try:  # best effort — digitize proceeds with raw OCR text on failure
                    _apply_ocr_fixes(p, ai_edit.fix_ocr(
                        p["png"], [{"id": b["id"], "text": b["text"]} for b in p["boxes"]]))
                except (ai_edit.AiUnavailable, ai_edit.AiError):
                    pass
            scale = p["scale"]
            rects = [{"x": b["rect"][0] * scale, "y": b["rect"][1] * scale,
                      "w": (b["rect"][2] - b["rect"][0]) * scale,
                      "h": (b["rect"][3] - b["rect"][1]) * scale} for b in p["boxes"]]
            background = scan.erase(p["png"], rects) if rects else p["png"]
            page = out.new_page(width=p["ptw"], height=p["pth"])
            page.insert_image(page.rect, stream=background)
            has_uni = False                     # the Unicode face, embedded on demand
            for b in p["boxes"]:
                x0, _, _, y1 = b["rect"]
                text = b["text"]
                if text.isascii():
                    fonts = _PDF_FONTS.get(b.get("family", "sans"), _PDF_FONTS["sans"])
                    fontname = fonts[(bool(b.get("bold")), bool(b.get("italic")))]
                    fontfile = None
                elif UNICODE_FONT:
                    # one embedded weight for every non-ASCII run: bold/italic are
                    # lost, which beats the blank boxes base-14 would produce
                    fontname, fontfile = "uni", (None if has_uni else UNICODE_FONT)
                    has_uni = True
                else:
                    continue                    # no Unicode face → leave it as image
                r, g, bl = _hex_to_rgb(b.get("color", "#000000"))
                try:
                    page.insert_text((x0, b.get("base", y1)), text,
                                     fontsize=b["fontSize"], fontname=fontname,
                                     fontfile=fontfile,
                                     color=(r / 255, g / 255, bl / 255))
                except Exception:
                    pass                        # unmappable glyph — keep the raster
        data = out.tobytes(garbage=3, deflate=True)
    finally:
        out.close()
    return Response(content=data, media_type="application/pdf",
                    headers={"Content-Disposition": 'attachment; filename="document-digitized.pdf"'})


# ── /api/erase (seamless removal) ────────────────────────────────────────────
def _hex_to_rgb(hex_str: str):
    h = (hex_str or "").lstrip("#")
    if len(h) != 6:
        return (255, 255, 255)
    try:
        return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))
    except ValueError:
        return (255, 255, 255)


@app.post("/api/erase")
async def erase_ep(file: UploadFile = File(...), rects: str = Form("[]"),
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
        if fillMode == "object" and rs:
            # magic-erase: heal only the ink strokes seeded by the rect
            out = scan.erase_object(data, rs[0])
        else:
            out = scan.erase(data, rs, fixed_rgb=fixed_rgb)
    except Exception as e:
        raise HTTPException(500, f"Erase failed: {e}")
    return _png(out)


# ── /api/export (assemble edited page images into a PDF) ─────────────────────
# The exported pages are flattened to images by the client, so the PDF carries
# no recoverable text layer for the edited content. Each page is re-encoded as
# JPEG at ONE uniform quality and the document metadata is neutralized, so a
# forensic error-level-analysis (ELA) pass sees a consistent whole-page raster
# with no locally-recompressed patch betraying where an edit happened.
EXPORT_JPEG_Q = _env_int("EXPORT_JPEG_Q", 90)


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
            img = PILImage.open(io.BytesIO(b)).convert("RGB")
            jbuf = io.BytesIO()
            img.save(jbuf, "JPEG", quality=EXPORT_JPEG_Q, subsampling=2)  # uniform ELA
            imgdoc = fitz.open(stream=jbuf.getvalue(), filetype="jpg")
            pdfb = imgdoc.convert_to_pdf(); imgdoc.close()
            src = fitz.open("pdf", pdfb)
            doc.insert_pdf(src); src.close()
        # neutralize metadata (no "PyMuPDF / today's date" producer trail)
        doc.set_metadata({})
        doc.del_xml_metadata()
        out = doc.tobytes(garbage=4, deflate=True)
    finally:
        doc.close()
    return Response(content=out, media_type="application/pdf",
                    headers={"Content-Disposition": 'attachment; filename="document-edited.pdf"'})


# ── /api/support (users report a problem: message + screenshot + document) ──
@app.post("/api/support")
async def support(message: str = Form(...), session: str = Form(""),
                  email: str = Form(""),
                  screenshot: Optional[UploadFile] = File(None),
                  document: Optional[UploadFile] = File(None)):
    msg = (message or "").strip()
    if not msg:
        raise HTTPException(400, "Please describe the problem.")
    if len(msg) > 5000:
        raise HTTPException(413, "Message too long.")

    ticket = time.strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:6]
    tdir = SUPPORT_DIR / ticket
    tdir.mkdir(parents=True, exist_ok=True)

    # human-readable local time: e.g. "Saturday, 12 July 2026 · 09:51"
    when = time.strftime("%A, %d %B %Y · %H:%M")
    meta = [f"ticket: {ticket}", f"time: {when}"]
    if email.strip():
        meta.append(f"email: {email.strip()[:200]}")
    (tdir / "report.txt").write_text("\n".join(meta) + "\n\n" + msg, encoding="utf-8")

    async def _save(upload, name, kinds):
        if not upload:
            return
        data = await upload.read()
        if not data or len(data) > MAX_UPLOAD_BYTES:
            return
        ext = Path(upload.filename or "").suffix.lower()
        if kinds and ext and ext.lstrip(".") not in kinds:
            ext = ""
        (tdir / (name + ext)).write_bytes(data)

    await _save(screenshot, "screenshot", {"png", "jpg", "jpeg", "webp"})
    await _save(document, "document", {"pdf", "png", "jpg", "jpeg", "webp"})

    # attach the document the user is stuck on straight from its live session,
    # so they don't have to re-upload the file they already opened
    sess = STORE.get(session) if session else None
    if sess and not (tdir / "document.pdf").exists():
        try:
            (tdir / "session-document.pdf").write_bytes(sess["pdf"])
        except Exception:
            pass

    # forward to the support Telegram chat (best-effort, in the background)
    shot = next(iter(tdir.glob("screenshot.*")), None)
    doc = next(iter(tdir.glob("document.*")), None) or next(iter(tdir.glob("session-document.*")), None)
    asyncio.create_task(notify.send_support(ticket, "\n".join(meta) + "\n\n" + msg, shot, doc))

    return {"ticket": ticket}


@app.get("/api/langs")
async def langs():
    """OCR languages this server can use, so the UI can offer them at upload."""
    return {"langs": OCR_LANGS, "default": _clean_lang("")}


@app.get("/api/health")
async def health():
    return JSONResponse({"ok": True, "ocr": HAS_OCR, "ai": ai_edit.available(),
                         "langs": OCR_LANGS, "sessions": len(STORE)})


# ── Static frontend (mounted last so /api/* wins) ────────────────────────────
class _HashedStatic(StaticFiles):
    """Cache the build correctly.

    Vite fingerprints every file under assets/ (index-<hash>.js), so those can
    be cached forever — a new build is a new URL. index.html must NOT be: it is
    the file that names the current bundle, and without an explicit no-cache the
    browser's heuristic caching leaves users running the previous deploy until
    they think to hard-refresh.
    """

    async def get_response(self, path: str, scope):
        resp = await super().get_response(path, scope)
        resp.headers["Cache-Control"] = ("public, max-age=31536000, immutable"
                                         if path.startswith("assets/") else "no-cache")
        return resp


_WEB_DIST = ROOT / "web" / "dist"
if (_WEB_DIST / "index.html").exists():
    app.mount("/", _HashedStatic(directory=str(_WEB_DIST), html=True), name="static")
