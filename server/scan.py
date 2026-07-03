"""
Image-processing engine (OpenCV + Pillow) backing the seamless number removal.

Pure functions over PNG bytes so the API layer stays thin:
  - inpaint()             remove rectangles (flat background fill or reconstruction)
  - preprocess_for_ocr()  clean an image so Tesseract reads numbers more reliably
"""
from __future__ import annotations

import io

import cv2
import numpy as np
from PIL import Image


# ── conversions ─────────────────────────────────────────────────────────────
def _to_cv(png_bytes: bytes) -> np.ndarray:
    img = Image.open(io.BytesIO(png_bytes)).convert("RGB")
    return cv2.cvtColor(np.array(img), cv2.COLOR_RGB2BGR)


def _to_png(cv_img: np.ndarray) -> bytes:
    if cv_img.ndim == 2:
        rgb = cv2.cvtColor(cv_img, cv2.COLOR_GRAY2RGB)
    else:
        rgb = cv2.cvtColor(cv_img, cv2.COLOR_BGR2RGB)
    out = io.BytesIO()
    Image.fromarray(rgb).save(out, format="PNG")
    return out.getvalue()


# ── Seamless removal ────────────────────────────────────────────────────────
def _ring_fill(img, x0, y0, x1, y1):
    """Inspect the band of pixels just outside the rect. If that background is
    fairly uniform, return (fill_color, fraction_uniform); else fraction is low."""
    h, w = img.shape[:2]
    pad = max(6, int((y1 - y0) * 0.6))
    ex0, ey0 = max(0, x0 - pad), max(0, y0 - pad)
    ex1, ey1 = min(w, x1 + pad), min(h, y1 + pad)
    region = img[ey0:ey1, ex0:ex1]
    if region.size == 0:
        return np.array([255, 255, 255]), 0.0
    band = np.ones(region.shape[:2], bool)                 # exclude the rect itself
    band[max(0, y0 - ey0):max(0, y1 - ey0), max(0, x0 - ex0):max(0, x1 - ex0)] = False
    px = region[band].astype(np.int32)
    if len(px) == 0:
        return np.array([255, 255, 255]), 0.0
    q = (px // 12) * 12                                    # quantize to find the dominant color
    colors, counts = np.unique(q, axis=0, return_counts=True)
    dom = colors[counts.argmax()]
    close = np.abs(px - dom).sum(axis=1) < 36
    frac = float(close.mean())
    fill = px[close].mean(axis=0) if close.any() else dom
    return fill, frac


def inpaint(png_bytes: bytes, rects: list, dilate: int = 3, radius: int = 4,
            flat_threshold: float = 0.7, fixed_rgb: tuple | None = None) -> bytes:
    """Remove each rect.

    When ``fixed_rgb`` is given (r, g, b), every rect is painted with that exact
    color — this backs the UI's "Fixed" fill mode and the eyedropper, so the
    user's chosen color actually persists in the result.

    Otherwise ("auto"): where the surrounding background is uniform (e.g. a white
    scan), fill it with that clean background color — no blur. Only where the
    background is textured/varied do we reconstruct it with inpainting.
    """
    img = _to_cv(png_bytes)
    h, w = img.shape[:2]
    mask = np.zeros((h, w), np.uint8)
    fixed_bgr = None
    if fixed_rgb is not None:
        r, g, b = (int(v) for v in fixed_rgb)
        fixed_bgr = np.array([b, g, r], dtype=np.uint8)     # OpenCV is BGR
    touched = False
    for r in rects:
        try:
            x, y, rw, rh = float(r["x"]), float(r["y"]), float(r["w"]), float(r["h"])
        except (KeyError, TypeError, ValueError):
            continue
        x0 = max(0, int(x) - dilate); y0 = max(0, int(y) - dilate)
        x1 = min(w, int(x + rw) + dilate); y1 = min(h, int(y + rh) + dilate)
        if x1 <= x0 or y1 <= y0:
            continue
        touched = True
        if fixed_bgr is not None:
            img[y0:y1, x0:x1] = fixed_bgr                    # exact user-chosen color
            continue
        fill, frac = _ring_fill(img, x0, y0, x1, y1)
        if frac >= flat_threshold:
            img[y0:y1, x0:x1] = fill.astype(np.uint8)      # clean flat background, no blur
        else:
            mask[y0:y1, x0:x1] = 255                        # textured → reconstruct
    if not touched:
        return png_bytes
    if mask.any():
        img = cv2.inpaint(img, mask, radius, cv2.INPAINT_TELEA)
    return _to_png(img)


# ── OCR preprocessing ───────────────────────────────────────────────────────
def preprocess_for_ocr(png_bytes: bytes):
    """Grayscale + upscale + denoise + Otsu threshold → crisp input for Tesseract.

    Returns (PIL.Image, upscale_factor) so callers can map OCR boxes back to the
    original page-pixel coordinates.
    """
    img = _to_cv(png_bytes)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    up = 1.0
    if gray.shape[1] < 1600:  # upscale small scans so digits are legible
        up = 1600 / gray.shape[1]
        gray = cv2.resize(gray, None, fx=up, fy=up, interpolation=cv2.INTER_CUBIC)
    gray = cv2.fastNlMeansDenoising(gray, h=10)
    thr = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY | cv2.THRESH_OTSU)[1]
    return Image.fromarray(thr), up
