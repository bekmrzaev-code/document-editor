"""
Scan / image-enhancement engine (CamScanner-style) built on OpenCV + Pillow.

Pure functions over PNG bytes so the API layer stays thin:
  - process()             apply a scan filter + brightness/contrast/sharpen/deskew/crop
  - auto_crop()           detect a document's borders and warp it flat (perspective)
  - deskew()              straighten a tilted page
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


# ── geometry helpers (document detection + perspective) ─────────────────────
def _order_points(pts: np.ndarray) -> np.ndarray:
    rect = np.zeros((4, 2), dtype="float32")
    s = pts.sum(axis=1)
    rect[0] = pts[np.argmin(s)]      # top-left
    rect[2] = pts[np.argmax(s)]      # bottom-right
    d = np.diff(pts, axis=1)
    rect[1] = pts[np.argmin(d)]      # top-right
    rect[3] = pts[np.argmax(d)]      # bottom-left
    return rect


def _four_point_transform(image: np.ndarray, pts: np.ndarray) -> np.ndarray:
    rect = _order_points(pts)
    (tl, tr, br, bl) = rect
    wA = np.linalg.norm(br - bl)
    wB = np.linalg.norm(tr - tl)
    hA = np.linalg.norm(tr - br)
    hB = np.linalg.norm(tl - bl)
    maxW = max(int(wA), int(wB))
    maxH = max(int(hA), int(hB))
    if maxW < 10 or maxH < 10:
        return image
    dst = np.array([[0, 0], [maxW - 1, 0], [maxW - 1, maxH - 1], [0, maxH - 1]], dtype="float32")
    M = cv2.getPerspectiveTransform(rect, dst)
    return cv2.warpPerspective(image, M, (maxW, maxH))


def _find_document(cv_img: np.ndarray):
    """Return a 4-point contour of the largest document-like quad, or None."""
    h = cv_img.shape[0]
    ratio = h / 500.0
    small = cv2.resize(cv_img, (int(cv_img.shape[1] / ratio), 500))
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (5, 5), 0)
    edged = cv2.Canny(gray, 75, 200)
    edged = cv2.dilate(edged, np.ones((3, 3), np.uint8), iterations=1)
    cnts, _ = cv2.findContours(edged, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    cnts = sorted(cnts, key=cv2.contourArea, reverse=True)[:5]
    frame_area = small.shape[0] * small.shape[1]
    for c in cnts:
        peri = cv2.arcLength(c, True)
        approx = cv2.approxPolyDP(c, 0.02 * peri, True)
        if len(approx) == 4 and cv2.contourArea(approx) > 0.2 * frame_area:
            return approx.reshape(4, 2) * ratio
    return None


def auto_crop(cv_img: np.ndarray) -> np.ndarray:
    quad = _find_document(cv_img)
    if quad is None:
        return cv_img
    return _four_point_transform(cv_img, quad.astype("float32"))


def deskew(cv_img: np.ndarray) -> np.ndarray:
    gray = cv2.cvtColor(cv_img, cv2.COLOR_BGR2GRAY)
    thr = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV | cv2.THRESH_OTSU)[1]
    coords = np.column_stack(np.where(thr > 0))
    if len(coords) < 50:
        return cv_img
    angle = cv2.minAreaRect(coords)[-1]
    if angle > 45:
        angle -= 90
    elif angle < -45:
        angle += 90
    if abs(angle) < 0.3:
        return cv_img
    (h, w) = cv_img.shape[:2]
    M = cv2.getRotationMatrix2D((w / 2, h / 2), angle, 1.0)
    return cv2.warpAffine(cv_img, M, (w, h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)


# ── tone / colour filters ───────────────────────────────────────────────────
def _white_balance(img: np.ndarray) -> np.ndarray:
    result = cv2.cvtColor(img, cv2.COLOR_BGR2LAB).astype("float32")
    avg_a = np.average(result[:, :, 1])
    avg_b = np.average(result[:, :, 2])
    result[:, :, 1] -= (avg_a - 128) * (result[:, :, 0] / 255.0) * 1.1
    result[:, :, 2] -= (avg_b - 128) * (result[:, :, 0] / 255.0) * 1.1
    result = np.clip(result, 0, 255).astype("uint8")
    return cv2.cvtColor(result, cv2.COLOR_LAB2BGR)


def _sharpen(img: np.ndarray, amount: float) -> np.ndarray:
    if amount <= 0:
        return img
    blur = cv2.GaussianBlur(img, (0, 0), 3)
    return cv2.addWeighted(img, 1 + amount, blur, -amount, 0)


def _bw(img: np.ndarray) -> np.ndarray:
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    gray = cv2.medianBlur(gray, 3)
    return cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                 cv2.THRESH_BINARY, 21, 10)


def _apply_mode(img: np.ndarray, mode: str) -> np.ndarray:
    if mode == "gray":
        return cv2.cvtColor(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY), cv2.COLOR_GRAY2BGR)
    if mode == "bw":
        return cv2.cvtColor(_bw(img), cv2.COLOR_GRAY2BGR)
    if mode == "auto":
        # gentle: normalize contrast per the L channel
        lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB)
        l, a, b = cv2.split(lab)
        l = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(l)
        out = cv2.cvtColor(cv2.merge((l, a, b)), cv2.COLOR_LAB2BGR)
        return _sharpen(out, 0.4)
    if mode == "magic":
        out = _white_balance(img)
        lab = cv2.cvtColor(out, cv2.COLOR_BGR2LAB)
        l, a, b = cv2.split(lab)
        l = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8)).apply(l)
        out = cv2.cvtColor(cv2.merge((l, a, b)), cv2.COLOR_LAB2BGR)
        hsv = cv2.cvtColor(out, cv2.COLOR_BGR2HSV).astype("float32")
        hsv[:, :, 1] = np.clip(hsv[:, :, 1] * 1.25, 0, 255)  # saturation pop
        out = cv2.cvtColor(hsv.astype("uint8"), cv2.COLOR_HSV2BGR)
        return _sharpen(out, 0.6)
    return img  # "original"


def process(png_bytes: bytes, mode: str = "original", brightness: float = 0.0,
            contrast: float = 1.0, sharpen: float = 0.0,
            do_deskew: bool = False, do_autocrop: bool = False) -> bytes:
    img = _to_cv(png_bytes)
    if do_autocrop:
        img = auto_crop(img)
    if do_deskew:
        img = deskew(img)
    img = _apply_mode(img, mode)
    if brightness != 0 or contrast != 1.0:
        img = cv2.convertScaleAbs(img, alpha=float(contrast), beta=float(brightness))
    img = _sharpen(img, float(sharpen))
    return _to_png(img)


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
