/* ============================================================================
 * glyphs.js — make replacement text indistinguishable from the original.
 *
 * Two techniques, used together:
 *
 *   GlyphAtlas — the document is its own font. Every detected word on the clean
 *     page is segmented into individual glyphs; those real bitmaps are reused
 *     to typeset replacements. "169"→"770" is drawn from the page's own 7 and 0,
 *     so ink weight, blur, JPEG noise and paper tone match exactly — because
 *     they ARE the original pixels. Characters the page never shows fall back
 *     to font rendering.
 *
 *   scanLook — for anything font-rendered on a scanned page, soften the crisp
 *     vector edges to match the surrounding optical/JPEG blur, add matched ink
 *     noise and a sub-pixel baseline jitter, so it doesn't read as "typed on".
 * ========================================================================== */

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const mk = (w, h) => { const c = document.createElement("canvas"); c.width = Math.max(1, w); c.height = Math.max(1, h); return c; };

/* ── glyph atlas ─────────────────────────────────────────────────────────── */
export class GlyphAtlas {
  constructor() { this.map = new Map(); this.built = false; this.space = 0; }

  /* Build from the clean render + detected word boxes. Only words that segment
     cleanly (ink-run count === visible-char count) contribute donors, so a bad
     split never poisons the atlas. */
  build(page) {
    this.map = new Map();
    const ctx = page.cleanCtx;
    if (!ctx) return this;
    let spaceSum = 0, spaceN = 0;
    for (const b of page.boxes) {
      const chars = [...(b.text || "")].filter((c) => !/\s/.test(c));
      if (!chars.length || b.w < 3 || b.h < 4) continue;
      const pad = Math.max(1, Math.round(b.h * 0.15));
      const x0 = clamp(Math.floor(b.x - 1), 0, page.w - 1);
      const y0 = clamp(Math.floor(b.y - pad), 0, page.h - 1);
      const w = clamp(Math.ceil(b.w + 2), 1, page.w - x0);
      const h = clamp(Math.ceil(b.h + pad * 2), 1, page.h - y0);
      const img = ctx.getImageData(x0, y0, w, h);
      const runs = this._inkRuns(img);
      if (runs.length !== chars.length) continue;         // ambiguous → skip word
      // average inter-glyph gap → tracking estimate (normalized by em size)
      for (let i = 1; i < runs.length; i++) { spaceSum += (runs[i].x0 - runs[i - 1].x1) / b.fontSize; spaceN++; }
      runs.forEach((run, i) => this._store(chars[i], img, run, b, y0));
    }
    this.space = spaceN ? clamp(spaceSum / spaceN, 0, 0.25) : 0.04;
    this.built = true;
    return this;
  }

  /* Columns with ink, grouped into contiguous runs separated by clear gaps. */
  _inkRuns(img) {
    const { width: w, height: h, data } = img;
    const lum = new Float32Array(w * h);
    for (let i = 0, p = 0; i < data.length; i += 4, p++) lum[p] = (data[i] + data[i + 1] + data[i + 2]) / 3;
    const bg = this._percentile(lum, 0.85);
    const thr = bg - Math.max(28, (bg - this._percentile(lum, 0.02)) * 0.35);
    const colInk = new Uint8Array(w);
    for (let x = 0; x < w; x++) { let n = 0; for (let y = 0; y < h; y++) if (lum[y * w + x] < thr) n++; colInk[x] = n >= 1 ? 1 : 0; }
    const runs = []; let s = -1;
    for (let x = 0; x <= w; x++) {
      if (x < w && colInk[x]) { if (s < 0) s = x; }
      else if (s >= 0) { if (x - s >= 1) runs.push({ x0: s, x1: x }); s = -1; }
    }
    return runs.map((r) => this._tightV(lum, w, h, r, thr));
  }

  _tightV(lum, w, h, run, thr) {
    let y0 = h, y1 = 0;
    for (let x = run.x0; x < run.x1; x++) for (let y = 0; y < h; y++) if (lum[y * w + x] < thr) { if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (y0 > y1) { y0 = 0; y1 = h - 1; }
    return { x0: run.x0, x1: run.x1, y0, y1: y1 + 1 };
  }

  _percentile(arr, p) { const a = Float32Array.prototype.slice.call(arr).sort(); return a[clamp(Math.floor(p * a.length), 0, a.length - 1)]; }

  /* Store a glyph as an alpha mask (ink opacity), decoupled from paper tone so
     it recolors cleanly onto any reconstructed background. */
  _store(ch, img, run, box, cropY0) {
    const gw = run.x1 - run.x0, gh = run.y1 - run.y0;
    if (gw < 1 || gh < 2) return;
    const { width: iw, data } = img;
    const lum = (x, y) => { const i = (y * iw + x) * 4; return (data[i] + data[i + 1] + data[i + 2]) / 3; };
    let bg = 0, n = 0;                                     // local background = bright pixels
    for (let y = run.y0; y < run.y1; y++) for (let x = run.x0; x < run.x1; x++) { const l = lum(x, y); if (l > 150) { bg += l; n++; } }
    bg = n ? bg / n : 245;
    let ink = 255; for (let y = run.y0; y < run.y1; y++) for (let x = run.x0; x < run.x1; x++) ink = Math.min(ink, lum(x, y));
    const span = Math.max(20, bg - ink);
    const cv = mk(gw, gh), cx = cv.getContext("2d");
    const out = cx.createImageData(gw, gh), od = out.data;
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
      const a = clamp((bg - lum(run.x0 + x, run.y0 + y)) / span, 0, 1);
      const o = (y * gw + x) * 4; od[o] = od[o + 1] = od[o + 2] = 0; od[o + 3] = Math.round(a * 255);
    }
    cx.putImageData(out, 0, 0);
    const entry = { cv, w: gw, h: gh, srcSize: box.fontSize || gh,
                    // glyph top relative to the text baseline, in em units
                    topEm: (cropY0 + run.y0 - (box.base ?? (box.y + box.h * 0.8))) / (box.fontSize || box.h) };
    const list = this.map.get(ch) || []; list.push(entry); this.map.set(ch, list);
  }

  has(ch) { return this.map.has(ch); }
  coverage(text) { const c = [...text].filter((x) => !/\s/.test(x)); return c.length ? c.filter((x) => this.has(x)).length / c.length : 0; }

  _pick(ch, size) {
    const list = this.map.get(ch); if (!list) return null;
    let best = list[0], bd = Infinity;                    // closest source size
    for (const e of list) { const d = Math.abs(e.srcSize - size); if (d < bd) { bd = d; best = e; } }
    return best;
  }

  /* Typeset `text` from donor glyphs into a fresh alpha canvas. Returns
     { canvas, width, height, baseline } in target pixels, or null if too few
     glyphs are available. `missing` chars are rendered with `fontFn`. */
  typeset(text, size, { color, fontFn, minCoverage = 0.6 } = {}) {
    if (this.coverage(text) < minCoverage) return null;
    const gap = this.space * size;
    const asc = Math.ceil(size * 1.0), desc = Math.ceil(size * 0.4);
    const H = asc + desc, baseline = asc;
    let pen = 1;                                           // start ink at the left edge
    const cells = [];
    for (const ch of text) {
      if (/\s/.test(ch)) { pen += size * 0.32; continue; }
      const e = this._pick(ch, size);
      if (e) {
        const sc = size / e.srcSize;
        const gw = e.w * sc, gh = e.h * sc, top = baseline + e.topEm * size;
        cells.push({ type: "donor", e, x: pen, y: top, w: gw, h: gh });
        pen += gw + gap;
      } else if (fontFn) {
        const m = fontFn.measure(ch, size);
        cells.push({ type: "font", ch, x: pen, y: baseline, w: m });
        pen += m + gap * 0.5;
      }
    }
    const W = Math.ceil(pen + size * 0.12);
    const cv = mk(W, H), cx = cv.getContext("2d");
    // 1) lay down an alpha master (ink opacity), donors + font glyphs together
    for (const c of cells) {
      if (c.type === "donor") cx.drawImage(c.e.cv, c.x, c.y, c.w, c.h);
      else fontFn.draw(cx, c.ch, c.x, c.y, size, "#000");
    }
    // 2) recolor: multiply the alpha master by the ink color
    cx.globalCompositeOperation = "source-in";
    cx.fillStyle = color || "#111"; cx.fillRect(0, 0, W, H);
    cx.globalCompositeOperation = "source-over";
    return { canvas: cv, width: W, height: H, baseline };
  }
}

/* ── scan-look post-processing ───────────────────────────────────────────── */

/* Measure how soft/noisy the paper is around a box on the clean render, so the
   softening we apply to font-drawn text matches this page rather than a guess. */
export function measureScanLook(page, box) {
  const ctx = page.cleanCtx;
  const pad = Math.max(6, Math.round(box.h * 0.6));
  const x = clamp(Math.floor(box.x - pad), 0, page.w - 1);
  const y = clamp(Math.floor(box.y - pad), 0, page.h - 1);
  const w = clamp(Math.ceil(box.w + pad * 2), 4, page.w - x);
  const h = clamp(Math.ceil(box.h + pad * 2), 4, page.h - y);
  const d = ctx.getImageData(x, y, w, h).data;
  const lum = new Float32Array(w * h);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) lum[p] = (d[i] + d[i + 1] + d[i + 2]) / 3;
  // edge softness: mean transition width across the sharpest horizontal steps
  let gradSum = 0, gradN = 0, bgSum = 0, bgN = 0;
  for (let yy = 1; yy < h - 1; yy++) for (let xx = 1; xx < w - 1; xx++) {
    const g = Math.abs(lum[yy * w + xx + 1] - lum[yy * w + xx - 1]);
    if (g > 40) { gradSum += g; gradN++; }
    else { bgSum += lum[yy * w + xx]; bgN++; }
  }
  const meanBg = bgN ? bgSum / bgN : 245;
  // residual std of background = paper/JPEG noise
  let noise = 0; for (let p = 0; p < lum.length; p++) { const dd = lum[p] - meanBg; if (Math.abs(dd) < 60) noise += dd * dd; }
  noise = Math.sqrt(noise / lum.length);
  // soft page → low mean gradient magnitude on edges → wider blur
  const sharp = gradN ? gradSum / gradN : 255;            // ~255 crisp, lower = softer
  const blur = clamp((255 - sharp) / 255 * 1.1, 0.15, 1.0);
  return { blur, noise: clamp(noise, 0, 8) };
}

/* Composite an alpha/ink canvas onto ctx at (dx, dy) with scan-like softening:
   a small multi-tap blur + optional slant, then matched ink noise. */
export function drawSoft(ctx, src, dx, dy, dw, dh, { blur = 0.4, slant = 0, noise = 0 } = {}) {
  ctx.save();
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
  if (slant) { ctx.translate(dx, dy + dh); ctx.rotate(slant); ctx.translate(-dx, -(dy + dh)); }
  // 5-tap blur: center full, 4 neighbors at reduced alpha, offset by ~blur px
  const o = blur;
  const taps = [[0, 0, 1], [o, 0, 0.35], [-o, 0, 0.35], [0, o, 0.35], [0, -o, 0.35]];
  for (const [ox, oy, a] of taps) { ctx.globalAlpha = a; ctx.drawImage(src, dx + ox, dy + oy, dw, dh); }
  ctx.globalAlpha = 1;
  ctx.restore();
  if (noise >= 1.2) _speckle(ctx, dx, dy, dw, dh, noise);
}

/* Add matched luminance noise, but only where ink was drawn (alpha > 0). */
function _speckle(ctx, dx, dy, dw, dh, std) {
  const x = Math.max(0, Math.floor(dx)), y = Math.max(0, Math.floor(dy));
  const w = Math.min(ctx.canvas.width - x, Math.ceil(dw)), h = Math.min(ctx.canvas.height - y, Math.ceil(dh));
  if (w <= 0 || h <= 0) return;
  const img = ctx.getImageData(x, y, w, h), p = img.data;
  for (let i = 0; i < p.length; i += 4) {
    if (p[i + 3] < 8) continue;
    const n = (Math.random() + Math.random() + Math.random() - 1.5) * std * 1.6;
    p[i] = clamp(p[i] + n, 0, 255); p[i + 1] = clamp(p[i + 1] + n, 0, 255); p[i + 2] = clamp(p[i + 2] + n, 0, 255);
  }
  ctx.putImageData(img, x, y);
}
