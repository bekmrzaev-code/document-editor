"""
Image-processing engine (OpenCV + Pillow) backing seamless text removal.

Pure functions over PNG bytes so the API layer stays thin:
  - erase()               remove rectangles (flat fill or inpaint reconstruction)
  - preprocess_for_ocr()  clean an image so Tesseract reads text more reliably
  - sample_ink_color()    guess the text (foreground) color inside a rect
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
def page_background(img, step: int = 4) -> float:
    """Paper tone of the whole image as a summed-RGB luminance (0…765).

    Subsampled: a full-resolution median of an 11-megapixel page costs ~40 ms,
    and the rule detector needs this value for every erased rect. Across a
    document the median is stable far inside the 150-level margin the rule test
    uses, so every 4th pixel is plenty.
    """
    return float(np.median(img[::step, ::step].astype(np.int32).sum(axis=2)))


def _redraw_rules(img, x0, y0, x1, y1, bg: float, reach: int = 4):
    """Table lines crossing an erased rect get filled over and vanish, leaving a
    telltale gap in the grid. Detect straight rules entering the rect from its
    borders and paint them back across the gap in their own ink color.

    A horizontal rule enters at the same row from BOTH the left and right
    borders; a vertical rule enters at the same column from top and bottom.
    Requiring both sides avoids mistaking glyph strokes for rules.

    ``bg`` comes from page_background() and is computed once per erase() call.
    Recomputing a whole-page luminance map here, as this used to, cost ~37 ms
    per rect — 22 s of the 23 s it took to digitize a 600-word page."""
    h, w = img.shape[:2]
    dark = bg - 150                                        # clearly-ink threshold
    lx, rx = max(0, x0 - reach), min(w - 1, x1 + reach - 1)
    ty, by = max(0, y0 - reach), min(h - 1, y1 + reach - 1)
    # read all four border strips before writing anything: at the very top of
    # an image the top strip can coincide with the first filled row
    left, right = img[y0:y1, lx].astype(np.int32), img[y0:y1, rx].astype(np.int32)
    top, bottom = img[ty, x0:x1].astype(np.int32), img[by, x0:x1].astype(np.int32)
    ll, rl = left.sum(axis=1), right.sum(axis=1)
    tl, bl = top.sum(axis=1), bottom.sum(axis=1)

    rows = np.flatnonzero((ll < dark) & (rl < dark))       # horizontal rules
    if rows.size:
        colour = np.where((ll <= rl)[:, None], left, right).astype(np.uint8)
        img[y0 + rows, x0:x1] = colour[rows][:, None, :]

    cols = np.flatnonzero((tl < dark) & (bl < dark))       # vertical rules
    if cols.size:
        colour = np.where((tl <= bl)[:, None], top, bottom).astype(np.uint8)
        img[y0:y1, x0 + cols] = colour[cols][None, :, :]


def _grain(img, x0, y0, x1, y1, pad: int = 16) -> float:
    """High-frequency noise level of the background around a rect (paper grain,
    JPEG noise). Measured as the residual after a small blur, so gradients and
    edges don't inflate it. A filled patch with zero grain stands out as an
    obvious clean rectangle on a noisy scan — the fill must get matching noise."""
    h, w = img.shape[:2]
    ex0, ey0 = max(0, x0 - pad), max(0, y0 - pad)
    ex1, ey1 = min(w, x1 + pad), min(h, y1 + pad)
    region = img[ey0:ey1, ex0:ex1].astype(np.float32)
    if region.size < 300:
        return 0.0
    resid = region - cv2.blur(region, (3, 3))
    # measure on background pixels only, and stay ≥2px away from any ink:
    # the 3px blur smears glyph edges into adjacent background pixels, which
    # inflated the estimate and left visible speckle behind edits on clean docs
    lum = region.sum(axis=2)
    bg = (np.abs(lum - np.median(lum)) < 90).astype(np.uint8)
    bg = cv2.erode(bg, np.ones((5, 5), np.uint8))
    mask = bg > 0
    if mask.sum() < 100:
        return 0.0
    return float(np.clip(resid[mask].std() * 1.2, 0.0, 9.0))


def _add_grain(img, x0, y0, x1, y1, std: float):
    if std < 2.0:
        return                     # clean paper stays perfectly clean
    region = img[y0:y1, x0:x1].astype(np.float32)
    # luminance-only noise: paper grain is monochrome — independent per-channel
    # noise reads as colored speckle and gives the patch away under zoom
    region += np.random.normal(0.0, std * 0.8, region.shape[:2])[..., None]
    img[y0:y1, x0:x1] = np.clip(region, 0, 255).astype(np.uint8)
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
    # median, not mean: antialias remnants in the ring pull a mean slightly
    # darker, leaving a faint gray patch on white paper
    fill = np.median(px[close], axis=0) if close.any() else dom
    return fill, frac


def _interp_fill(img, x0, y0, x1, y1, band: int = 8) -> bool:
    """Crisp reconstruction for non-uniform backgrounds: each row is linearly
    interpolated between the pixels just left and right of the rect. Gradients
    and paper tone are preserved with zero blur (unlike inpainting, which
    smudges). Returns False when the rect spans the full image width.

    Per-row MEDIAN over a wide band, so a thin table rule or scan shadow next
    to the rect can't drag whole rows dark (which showed up as black smears)."""
    h, w = img.shape[:2]
    left = img[y0:y1, max(0, x0 - band):x0].astype(np.float32)
    right = img[y0:y1, x1:min(w, x1 + band)].astype(np.float32)
    if left.size == 0 and right.size == 0:
        return False
    if left.size == 0:
        left = right
    if right.size == 0:
        right = left
    lcol = np.median(left, axis=1)                          # (rows, 3)
    rcol = np.median(right, axis=1)
    t = np.linspace(0.0, 1.0, x1 - x0, dtype=np.float32)[None, :, None]
    img[y0:y1, x0:x1] = (lcol[:, None, :] * (1 - t) + rcol[:, None, :] * t).astype(np.uint8)
    return True


def erase(png_bytes: bytes, rects: list, dilate: int = 3,
          flat_threshold: float = 0.7, fixed_rgb: tuple | None = None) -> bytes:
    """Remove each rect, rebuilding the background behind it — never blurred.

    When ``fixed_rgb`` is given (r, g, b), every rect is painted with that exact
    color. Otherwise ("auto"): where the surrounding background is uniform (e.g.
    a white page), fill with that clean background color; where it isn't,
    reconstruct it by interpolating the surrounding pixels row by row. No
    inpainting — inpainting leaves a smudged/blurry patch behind edits.
    """
    img = _to_cv(png_bytes)
    h, w = img.shape[:2]
    fixed_bgr = None
    if fixed_rgb is not None:
        r, g, b = (int(v) for v in fixed_rgb)
        fixed_bgr = np.array([b, g, r], dtype=np.uint8)     # OpenCV is BGR
    touched = False
    bg_lum = None                                          # computed once, lazily
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
        grain = _grain(img, x0, y0, x1, y1)
        fill, frac = _ring_fill(img, x0, y0, x1, y1)
        if frac >= flat_threshold:
            img[y0:y1, x0:x1] = fill.astype(np.uint8)       # clean flat background
        elif not _interp_fill(img, x0, y0, x1, y1):
            img[y0:y1, x0:x1] = fill.astype(np.uint8)
        if bg_lum is None:
            bg_lum = page_background(img)
        _redraw_rules(img, x0, y0, x1, y1, bg_lum)          # keep table grid intact
        _add_grain(img, x0, y0, x1, y1, grain)              # blend into the paper texture
    if not touched:
        return png_bytes
    return _to_png(img)


def erase_object(png_bytes: bytes, rect: dict, grow: int = 24) -> bytes:
    """Phone-gallery-style object removal. The user's rectangle SEEDS the
    selection: every ink stroke touching it (including parts that spill a
    little outside the rectangle) is masked, and ONLY those pixels are
    inpainted — the background in between is left untouched, so there is no
    filled-patch outline at all. Matched grain is added over the healed
    strokes. Falls back to a plain rect erase when the area holds no ink."""
    img = _to_cv(png_bytes)
    h, w = img.shape[:2]
    try:
        x, y, rw, rh = float(rect["x"]), float(rect["y"]), float(rect["w"]), float(rect["h"])
    except (KeyError, TypeError, ValueError):
        return png_bytes
    x0, y0 = max(0, int(x)), max(0, int(y))
    x1, y1 = min(w, int(x + rw)), min(h, int(y + rh))
    if x1 <= x0 or y1 <= y0:
        return png_bytes
    wx0, wy0 = max(0, x0 - grow), max(0, y0 - grow)
    wx1, wy1 = min(w, x1 + grow), min(h, y1 + grow)
    window = img[wy0:wy1, wx0:wx1]
    lum = window.astype(np.int32).sum(axis=2)
    # Sensitive threshold: soft scans (CamScanner) leave pale antialiased stroke
    # edges far above the dark core — a strict cut heals only the core and a
    # ghost outline survives.
    ink = (lum < np.median(lum) - 60).astype(np.uint8)
    n_labels, labels = cv2.connectedComponents(ink)
    seed = np.unique(labels[y0 - wy0:y1 - wy0, x0 - wx0:x1 - wx0])
    seed = seed[seed != 0]
    if len(seed) == 0:                                     # no ink → plain fill
        return erase(png_bytes, [rect])
    mask = np.isin(labels, seed).astype(np.uint8)
    # wide dilation swallows the faint antialias halo around each stroke
    mask = cv2.dilate(mask, np.ones((5, 5), np.uint8), iterations=3)
    # …and a zone pass catches DISCONNECTED pale remnants near the strokes
    # (sharpening halos, JPEG dust) that sit above the ink threshold. Truly
    # dark pixels (real content like table rules) are excluded.
    bg_lum = float(np.median(lum))
    zone = cv2.dilate(mask, np.ones((13, 13), np.uint8)) > 0
    halo = zone & (mask == 0) & (lum < bg_lum - 10) & (lum > bg_lum - 220)
    mask = (mask | halo).astype(np.uint8)
    # Fill the mask from CLEAN background only. Inpainting interpolates from
    # the mask boundary — where pale halo remnants live — which tinted the
    # healed area with a ghost of the stroke. Instead, sample per-row medians
    # of pixels far enough from any stroke (outside an extra exclusion band).
    exclusion = cv2.dilate(mask, np.ones((9, 9), np.uint8))
    bg_ok = exclusion == 0
    glob = (np.median(window[bg_ok], axis=0) if bg_ok.any()
            else np.array([255.0, 255.0, 255.0]))
    healed = window.copy()
    for row in np.unique(np.where(mask > 0)[0]):
        bgpx = window[row][bg_ok[row]]
        fill = np.median(bgpx, axis=0) if len(bgpx) >= 8 else glob
        healed[row][mask[row] > 0] = fill.astype(np.uint8)
    grain = _grain(img, x0, y0, x1, y1)
    if grain >= 2.0:                                       # re-grain the healed strokes
        noise = np.random.normal(0.0, grain * 0.8, healed.shape[:2])[..., None]
        noisy = np.clip(healed.astype(np.float32) + noise, 0, 255).astype(np.uint8)
        healed = np.where(mask[..., None] > 0, noisy, healed)
    img[wy0:wy1, wx0:wx1] = healed
    _redraw_rules(img, x0, y0, x1, y1, page_background(img))   # keep table grid intact
    return _to_png(img)


# ── OCR support ─────────────────────────────────────────────────────────────
def _ink_mask(region: np.ndarray):
    """Binary ink mask for a word region. The background reference comes from
    a high percentile (NOT the median — in a tight word box the glyphs can
    dominate, which made a median-based threshold keep only the darkest core
    and halve the measured glyph height on low-contrast scans). The threshold
    then sits a quarter of the way from background to the darkest pixel, so
    antialiased glyph edges still count as ink. Returns None when the region
    has no meaningful contrast."""
    lum = region.astype(np.int32).sum(axis=2)              # 0 … 765
    bg = float(np.percentile(lum, 90))
    lo = float(lum.min())
    if bg - lo < 150:
        return None
    return (lum < bg - 0.25 * (bg - lo)).astype(np.uint8)


def tighten_box(img: np.ndarray, rect: tuple, margin: int = 3) -> tuple:
    """Shrink an OCR word rect to the tight bbox of its ink pixels.

    Tesseract sometimes returns a whole-cell box for an isolated word, which
    wrecks any size estimate derived from the box. The ink bbox restores the
    true glyph extent. A small inner margin is ignored so cell border lines
    touching the box edges don't count as ink. Returns the rect unchanged when
    no ink is found."""
    x0, y0, x1, y1 = (int(v) for v in rect)
    h, w = img.shape[:2]
    x0, y0 = max(0, x0), max(0, y0); x1, y1 = min(w, x1), min(h, y1)
    # margin scales with the box — a fixed 3px eats half of a small word's
    # height on low-resolution scans
    mx = max(1, min(margin, (x1 - x0) // 8))
    my = max(1, min(margin, (y1 - y0) // 8))
    if x1 - x0 <= 2 * mx or y1 - y0 <= 2 * my:
        return (x0, y0, x1, y1)
    ink = _ink_mask(img[y0 + my:y1 - my, x0 + mx:x1 - mx])
    if ink is None:
        return (x0, y0, x1, y1)
    rows = np.where(ink.any(axis=1))[0]
    cols = np.where(ink.any(axis=0))[0]
    if len(rows) == 0 or len(cols) == 0:
        return (x0, y0, x1, y1)
    rh, rw = ink.shape
    # ink touching the shaved edge continues into the margin — restore that side
    tx0 = x0 if cols[0] == 0 else x0 + mx + int(cols[0])
    ty0 = y0 if rows[0] == 0 else y0 + my + int(rows[0])
    tx1 = x1 if cols[-1] == rw - 1 else x0 + mx + int(cols[-1]) + 1
    ty1 = y1 if rows[-1] == rh - 1 else y0 + my + int(rows[-1]) + 1
    return (tx0, ty0, tx1, ty1)
def noise_level(gray: np.ndarray) -> float:
    """High-frequency residual of the PAPER in a grayscale page — grain, JPEG
    dust — ignoring the text.

    Measured on background pixels only, and ≥2px away from any ink: glyph edges
    dominate a plain residual, which makes a crisp PDF render score *higher*
    than a grainy phone photo and inverts the whole test. (Same reason _grain
    erodes its background mask.) Near 0 straight out of a PDF, 8+ on a photo.
    """
    resid = gray.astype(np.float32) - cv2.blur(gray, (3, 3))
    bg = (np.abs(gray.astype(np.int16) - int(np.median(gray))) < 40).astype(np.uint8)
    bg = cv2.erode(bg, np.ones((5, 5), np.uint8))
    mask = bg > 0
    if mask.sum() < 500:
        return 0.0
    return float(resid[mask].std())


def preprocess_for_ocr(png_bytes: bytes, denoise_above: float = 6.0):
    """Grayscale + upscale + (conditional) denoise + Otsu threshold → crisp
    input for Tesseract.

    Returns (PIL.Image, upscale_factor) so callers can map OCR boxes back to the
    original page-pixel coordinates.

    Denoising used to run unconditionally at ~350 ms a page — by far the most
    expensive step in analyzing a scan — and measured OCR accuracy was the same
    with and without it (98.6% either way on a clean page, 57.7% vs 56.7% on a
    grainy one). It now runs only when the page really is noisy, and with a
    search window of 11 instead of the default 21: same measured accuracy for a
    third of the cost.
    """
    img = _to_cv(png_bytes)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    up = 1.0
    if gray.shape[1] < 1600:  # upscale small scans so glyphs are legible
        up = 1600 / gray.shape[1]
        gray = cv2.resize(gray, None, fx=up, fy=up, interpolation=cv2.INTER_CUBIC)
    if noise_level(gray) > denoise_above:
        gray = cv2.fastNlMeansDenoising(gray, None, 10, 7, 11)
    thr = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY | cv2.THRESH_OTSU)[1]
    return Image.fromarray(thr), up


def stroke_width(img: np.ndarray, rect: tuple) -> float:
    """Median stroke thickness (px) of the ink inside a rect, via the distance
    transform. Lets the OCR path tell bold text from regular: bold strokes run
    ~0.14 em wide vs ~0.09 em for regular weights."""
    x0, y0, x1, y1 = (int(v) for v in rect)
    h, w = img.shape[:2]
    x0, y0 = max(0, x0), max(0, y0); x1, y1 = min(w, x1), min(h, y1)
    region = img[y0:y1, x0:x1]
    if region.size == 0:
        return 0.0
    ink = _ink_mask(region)
    if ink is None or ink.sum() < 8:
        return 0.0
    dist = cv2.distanceTransform(ink, cv2.DIST_L2, 3)
    vals = dist[dist > 0]
    if len(vals) == 0:
        return 0.0
    return float(2.0 * np.percentile(vals, 75))


def sample_ink_color(img: np.ndarray, rect: tuple) -> tuple:
    """Ink (foreground) color inside a rect: the median of the darkest ~12% of
    pixels. On real scans, antialiased glyph edges and JPEG noise form a pale
    halo that can outnumber the ink core — picking the 'most common
    non-background cluster' returns that washed-out halo tone, so replacements
    rendered nearly invisible. The darkest-percentile core is what the eye
    actually reads as the text color. Returns (r, g, b)."""
    x0, y0, x1, y1 = (int(v) for v in rect)
    h, w = img.shape[:2]
    x0, y0 = max(0, x0), max(0, y0); x1, y1 = min(w, x1), min(h, y1)
    region = img[y0:y1, x0:x1]
    if region.size == 0:
        return (0, 0, 0)
    px = region.reshape(-1, 3).astype(np.int32)
    lum = px.sum(axis=1)                                   # 0 … 765
    darkest = np.percentile(lum, 2)                        # robust minimum
    ink = px[lum <= darkest + 90]                          # ± ~30 per channel around it
    if len(ink) == 0:
        ink = px
    b, g, r = np.median(ink, axis=0)
    return (int(r), int(g), int(b))
