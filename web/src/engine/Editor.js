/* ============================================================================
 * Editor — imperative canvas engine (framework-agnostic).
 *
 * React owns the chrome (topbar, panels, loader, toasts) and reads a snapshot
 * of this engine's state via onState(). The engine owns the canvas stage and
 * thumbnails (mounted into refs React provides).
 *
 * Per page, layered canvases:
 *   cleanCanvas → original render (untouched)
 *   baseCanvas  → clean + erasures (patched region-by-region from the server)
 *   annoCanvas  → replacement text / annotations
 *   canvas      → on-screen composite
 *
 * Editing model: every detected text run is an overlay box. Clicking one opens
 * an inline editor; committing erases the original pixels (seamless, server-
 * side) and draws the replacement text on the anno layer.
 * ========================================================================== */

import { GlyphAtlas, measureScanLook, drawSoft } from "./glyphs.js";

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const newCanvas = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
const ctx2d = (c) => c.getContext("2d", { willReadFrequently: true });
const loadImage = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
const canvasBlob = (c) => new Promise((res) => c.toBlob(res, "image/png"));

/* Load a Google Font on demand so replacements can use a font the document was
   authored in but the machine doesn't have installed (from AI "Find fonts").
   Resolves once the face is ready; failures degrade to the web-safe fallback. */
const _loadedFonts = new Set();
function ensureWebFont(name, { bold, italic } = {}) {
  if (!name || _loadedFonts.has(name)) return;
  _loadedFonts.add(name);
  try {
    const id = "gf-" + name.replace(/\s+/g, "-");
    if (!document.getElementById(id)) {
      const link = document.createElement("link");
      link.id = id; link.rel = "stylesheet";
      link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(name)}:ital,wght@0,400;0,700;1,400;1,700&display=swap`;
      document.head.appendChild(link);
    }
    if (document.fonts) {
      const w = bold ? 700 : 400, s = italic ? "italic" : "normal";
      document.fonts.load(`${s} ${w} 20px "${name}"`).catch(() => {});
    }
  } catch { /* offline / CSP — fallback stack still renders */ }
}

const FAMILIES = {
  sans: "Helvetica, Arial, system-ui, sans-serif",
  serif: "'Times New Roman', Georgia, serif",
  mono: "'Courier New', ui-monospace, monospace",
};

/* Try the document's real font first (works when it's installed locally, e.g.
   Arial/Calibri/Times), falling back to the family's web-safe stack. PDF font
   names carry subset prefixes ("ABCDEF+Arial-Bold") and style suffixes that
   must be stripped to match an installed family name. */
const fontStack = ({ fontName, family }) => {
  const fam = FAMILIES[family] || FAMILIES.sans;
  if (!fontName) return fam;
  const clean = fontName.split("+").pop()
    .replace(/[-,_ ]?(Bold|Italic|Oblique|Regular|Roman|Light|Medium|Semibold|Black|Condensed)+$/i, "")
    .replace(/(MT|PS|PSMT)$/, "").trim();
  return clean ? `"${clean}", ${fam}` : fam;
};

export default class Editor {
  constructor({ api = "", onState = () => {}, onToast = () => {} } = {}) {
    this.api = api;
    this.onState = onState;
    this.onToast = onToast;

    this.session = null;
    this.ocrAvailable = false;
    this.aiAvailable = false;
    this.aiProposals = [];
    this.aiEditLoading = false;
    this.pages = [];
    this.current = -1;
    this.zoom = 1;
    this.tool = "edit";            // "edit" (click words) | "erase" | "copy"
    this._paste = null;            // { page, clip, w, h, x, y, el } while placing a copy
    this._space = false;           // space held → pan
    this.showOverlays = true;
    this._edit = null;             // { page, box, el } while an inline editor is open

    this.undoStack = [];
    this.redoStack = [];
    this.navSeq = 0;
    this.loading = false;
    this.loadingText = "";
    this.progress = 0;
    this.status = "Ready — open a PDF or image to begin.";
    this._loaderTimer = null;
  }

  mount({ stageEl, hostEl, thumbsEl }) {
    this.stageEl = stageEl;
    this.hostEl = hostEl;
    this.thumbsEl = thumbsEl;
    this._onResize = () => { clearTimeout(this._rt); this._rt = setTimeout(() => { if (this.current >= 0) this.layoutCanvas(this.pages[this.current]); }, 120); };
    window.addEventListener("resize", this._onResize);
    this._onSpaceDown = (e) => { if (e.code === "Space" && e.target.tagName !== "INPUT" && e.target.tagName !== "TEXTAREA") { this._space = true; e.preventDefault(); } };
    this._onSpaceUp = (e) => { if (e.code === "Space") this._space = false; };
    window.addEventListener("keydown", this._onSpaceDown);
    window.addEventListener("keyup", this._onSpaceUp);
    this.emit();
  }
  destroy() { window.removeEventListener("resize", this._onResize); window.removeEventListener("keydown", this._onSpaceDown); window.removeEventListener("keyup", this._onSpaceUp); }

  /* ── state snapshot for React ───────────────────────────────────────── */
  snapshot() {
    const p = this.pages[this.current];
    return {
      hasDoc: this.pages.length > 0,
      loading: this.loading, loadingText: this.loadingText, progress: this.progress,
      current: this.current, pageCount: this.pages.length, zoom: this.zoom,
      scanned: p ? p.scanned : false, ocrAvailable: this.ocrAvailable,
      aiAvailable: this.aiAvailable,
      aiProposals: this.aiProposals, aiEditLoading: this.aiEditLoading,
      count: p ? p.boxes.filter((b) => !b.erased).length : 0,
      showOverlays: this.showOverlays, tool: this.tool, pasteActive: !!this._paste,
      canUndo: this.undoStack.length > 0, canRedo: this.redoStack.length > 0,
      status: this.status,
    };
  }
  emit() { this.onState(this.snapshot()); }
  toast(m, k) { this.onToast(m, k); }

  // `timeout` is a safety net so a wedged request can't trap the UI forever.
  setLoading(text, timeout = 45000) { this.loading = true; this.loadingText = text; this.progress = 0; clearTimeout(this._loaderTimer); this._loaderTimer = setTimeout(() => { this.loading = false; this.emit(); this.toast("That took too long — please retry.", "error"); }, timeout); this.emit(); }
  setProgress(f) { this.progress = f; this.emit(); }
  hideLoader() { clearTimeout(this._loaderTimer); this.loading = false; this.emit(); }
  setStatus(s) { this.status = s; this.emit(); }

  /* ── upload with real progress (fetch can't observe request bodies) ──── */
  _upload(url, formData, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", url);
      xhr.responseType = "blob";
      xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
      xhr.onload = () => resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, blob: xhr.response });
      xhr.onerror = () => reject(new Error("Network error"));
      xhr.send(formData);
    });
  }

  /* While the server is busy after the upload finished, creep the bar toward
     95% so the user still sees motion (browser-style fake progress). */
  _creep(label) {
    return setInterval(() => {
      if (this.progress < 0.95) {
        this.progress += (0.95 - this.progress) * 0.05;
        this.loadingText = `${label} ${Math.round(this.progress * 100)}%`;
        this.emit();
      }
    }, 300);
  }

  async _readJson(blob) { try { return JSON.parse(await blob.text()); } catch { return {}; } }

  /* ── load + analyze ─────────────────────────────────────────────────── */
  async open(file) {
    let ticker = null;
    try {
      this.setLoading("Uploading… 0%", 300000);
      const fd = new FormData(); fd.append("file", file);
      const res = await this._upload(this.api + "/api/analyze", fd, (f) => {
        this.progress = f * 0.6;                      // upload = first 60% of the bar
        this.loadingText = `Uploading… ${Math.round(f * 100)}%`;
        this.emit();
        if (f >= 1 && !ticker) ticker = this._creep("Analyzing document…");
      });
      clearInterval(ticker); ticker = null;
      if (!res.ok) { const e = await this._readJson(res.blob); throw new Error(e.detail || `Server error ${res.status}`); }
      const json = await this._readJson(res.blob);

      this.session = json.session; this.ocrAvailable = !!json.ocrAvailable;
      this.aiAvailable = !!json.aiAvailable;
      this.aiProposals = []; this.aiEditLoading = false;
      this.current = -1; this.undoStack = []; this.redoStack = []; this._edit = null;
      this.pages = json.pages.map((p) => ({
        w: p.width, h: p.height, scanned: p.scanned, index: p.index,
        boxes: p.boxes.map((b) => ({ ...b, erased: false })),
        src: `${this.api}/api/page/${json.session}/${p.index}`,
        thumbSrc: `${this.api}/api/thumb/${json.session}/${p.index}`,
        loaded: false,
      }));

      this.buildThumbs();
      this.setProgress(1);
      await this.showPage(0);
      this.hideLoader();
      const total = this.pages.length, words = this.pages.reduce((n, p) => n + p.boxes.length, 0);
      this.toast(`Loaded ${total} page${total > 1 ? "s" : ""} · ${words} text runs`, "success");
    } catch (err) { clearInterval(ticker); console.error(err); this.hideLoader(); this.toast(err.message || "Could not analyze that file", "error"); this.setStatus("Failed — " + (err.message || err)); }
  }

  /* ── layered page model ─────────────────────────────────────────────── */
  composite(page) {
    page.ctx.clearRect(0, 0, page.w, page.h);
    page.ctx.drawImage(page.baseCanvas, 0, 0);
    page.ctx.drawImage(page.annoCanvas, 0, 0);
  }
  buildLayers(page, img) {
    page.w = img.naturalWidth; page.h = img.naturalHeight;
    page.cleanCanvas = newCanvas(page.w, page.h); page.cleanCtx = ctx2d(page.cleanCanvas); page.cleanCtx.drawImage(img, 0, 0);
    page.baseCanvas = newCanvas(page.w, page.h); page.baseCtx = ctx2d(page.baseCanvas); page.baseCtx.drawImage(img, 0, 0);
    page.annoCanvas = newCanvas(page.w, page.h); page.annoCtx = ctx2d(page.annoCanvas);
    page.canvas = newCanvas(page.w, page.h); page.ctx = ctx2d(page.canvas);
    // the document is its own font: index every real glyph for reuse in edits
    page.atlas = new GlyphAtlas().build(page);
    this.composite(page);
  }
  async ensurePageLoaded(page) { if (page.loaded) return; this.buildLayers(page, await loadImage(page.src)); page.loaded = true; }

  async showPage(index) {
    if (index < 0 || index >= this.pages.length) return;
    this.commitReplace();                            // bake any open editor before leaving
    const myNav = ++this.navSeq;
    const page = this.pages[index];
    if (!page.loaded) {
      this.setLoading("Loading page…");
      try { await this.ensurePageLoaded(page); }
      catch (e) { if (myNav === this.navSeq) { this.hideLoader(); this.toast("Couldn't load page — re-upload.", "error"); } return; }
    }
    if (myNav !== this.navSeq) return;
    this.hideLoader();
    this.current = index;
    this.mountPage(page);
    this.setStatus(page.scanned
      ? (this.ocrAvailable ? "Scanned page — text found via OCR (styling estimated)." : "Scanned page — OCR is not installed on the server.")
      : "Click any text to edit it — Enter saves, Esc cancels.");
    this.emit();
  }

  mountPage(page) {
    this.cancelPaste();
    this.hostEl.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.className = "canvas-wrap";
    wrap.appendChild(page.canvas);
    const overlay = document.createElement("div");
    overlay.className = "overlay-layer" + (this.showOverlays ? "" : " hidden");
    wrap.appendChild(overlay);
    page._overlay = overlay; page._wrap = wrap;
    const marqueeTool = this.tool === "erase" || this.tool === "copy";
    overlay.classList.toggle("no-hit", marqueeTool);
    wrap.classList.toggle("erase-tool", marqueeTool);
    this.hostEl.appendChild(wrap);
    this.layoutCanvas(page);
    // re-measure on the next frame: React may still be swapping the dropzone
    // for the canvas host, which changes the stage size mid-mount
    requestAnimationFrame(() => this.layoutCanvas(page));
    this.attachPan(page);
    this.renderOverlays(page);
    this.updateThumbActive();
  }

  layoutCanvas(page) {
    if (!page || !page.canvas) return;
    const fit = Math.min((this.stageEl.clientWidth - 64) / page.w, (this.stageEl.clientHeight - 64) / page.h, 1);
    const dispW = page.w * fit * this.zoom;
    page.canvas.style.width = dispW + "px";
    page.canvas.style.height = dispW * (page.h / page.w) + "px";
  }

  /* ── text overlays ──────────────────────────────────────────────────── */
  renderOverlays(page) {
    const overlay = page._overlay; if (!overlay) return;
    overlay.innerHTML = "";
    for (const box of page.boxes) {
      if (box.erased) continue;
      const d = document.createElement("div");
      d.className = "text-box" + (box.kind === "ocr" ? " ocr" : "");
      d.dataset.id = box.id;
      d.style.left = (box.x / page.w) * 100 + "%"; d.style.top = (box.y / page.h) * 100 + "%";
      d.style.width = (box.w / page.w) * 100 + "%"; d.style.height = (box.h / page.h) * 100 + "%";
      d.title = box.text;
      d.addEventListener("pointerdown", (e) => e.stopPropagation());   // don't start a pan
      d.addEventListener("click", (e) => { e.stopPropagation(); this.openReplaceEditor(page, box); });
      // right-click = instant erase, no editor round trip
      d.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); this.commitReplace(); this.applyReplace(page, box, ""); });
      overlay.appendChild(d);
    }
    this.emit();
  }
  toggleOverlays(on) { this.showOverlays = on; this.pages[this.current]?._overlay?.classList.toggle("hidden", !on); this.emit(); }

  setTool(tool) {
    if (tool !== "copy") this.cancelPaste();
    this.tool = tool;
    const marqueeTool = tool === "erase" || tool === "copy";
    const page = this.pages[this.current];
    if (page) {
      page._overlay?.classList.toggle("no-hit", marqueeTool);        // marquee starts anywhere
      page._wrap?.classList.toggle("erase-tool", marqueeTool);       // crosshair cursor
    }
    this.setStatus(
      tool === "erase" ? "Drag over anything — a stamp, mark or leftover text — to remove it seamlessly."
      : tool === "copy" ? "Drag a box around anything to copy it, then drag the copy where you want it and Place."
      : "Click any text to edit it — Enter saves, Esc cancels.");
    this.emit();
  }

  /* ── inline replace editor ──────────────────────────────────────────── */
  openReplaceEditor(page, box) {
    this.commitReplace();                            // bake any editor already open
    const sc = (page.canvas.clientWidth || page.canvas.width) / page.canvas.width;   // display px per canvas px
    const ta = document.createElement("textarea");
    ta.className = "replace-edit"; ta.rows = 1; ta.spellcheck = false;
    ta.value = box.text;
    ta.style.left = (box.x / page.w) * 100 + "%";
    ta.style.top = (box.y / page.h) * 100 + "%";
    ta.style.minWidth = Math.max(box.w * sc + 24, 80) + "px";
    ta.style.height = box.h * sc + 8 + "px";
    ta.style.fontSize = box.fontSize * sc + "px";
    ta.style.color = box.color;
    ta.style.fontWeight = box.bold ? "700" : "400";
    ta.style.fontStyle = box.italic ? "italic" : "normal";
    ta.style.fontFamily = fontStack(box);
    page._wrap.appendChild(ta);
    this._edit = { page, box, el: ta };
    const autosize = () => { ta.style.width = "auto"; ta.style.width = Math.min(ta.scrollWidth + 12, page.canvas.clientWidth) + "px"; };
    ta.addEventListener("input", autosize);
    ta.addEventListener("keydown", (ev) => {
      ev.stopPropagation();                          // don't fire global shortcuts while typing
      if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); this.commitReplace(); }
      else if (ev.key === "Escape") { ev.preventDefault(); this.cancelReplace(); }
    });
    ta.addEventListener("blur", () => this.commitReplace());
    setTimeout(() => { ta.focus({ preventScroll: true }); ta.select(); autosize(); }, 0);
    this.emit();
  }

  commitReplace() {
    const ed = this._edit; if (!ed) return;
    this._edit = null;
    const { page, box, el } = ed;
    const newText = el.value.replace(/\s+$/, "");
    el.remove();
    if (newText === box.text) { this.emit(); return; }          // unchanged → no-op
    this.applyReplace(page, box, newText);
  }

  cancelReplace() { const ed = this._edit; if (!ed) return; this._edit = null; ed.el.remove(); this.emit(); }

  /* ── replace = erase original pixels + draw new text ────────────────── */

  /* Free horizontal room for a replacement: from the box start to the next
     surviving box on the same line (or the page edge). Longer replacements
     only shrink when they truly wouldn't fit — not just because they're wider
     than the word they replace. */
  lineSpace(page, box) {
    const base = box.base ?? (box.y + box.h * 0.8);
    let limit = page.w - box.x - 6;
    for (const b of page.boxes) {
      if (b.id === box.id || b.erased) continue;
      const bBase = b.base ?? (b.y + b.h * 0.8);
      if (Math.abs(bBase - base) > Math.max(box.h, b.h) * 0.7) continue;   // other line
      if (b.x >= box.x + box.w - 1) limit = Math.min(limit, b.x - box.x - 4);
    }
    return Math.max(box.w * 1.02, limit);
  }

  /* OCR boxes can miss a faint edge glyph (it then survives the erase, e.g.
     "H14629"→"H99999" leaving "HH99999"). Grow the erase rect sideways over
     any ink columns that belong to no other box, stopping at a clean 3-column
     gap or the neighbouring word. Digital-PDF boxes are exact — no growing. */
  _eraseRect(page, box) {
    if (box.kind !== "ocr") return box;
    const size = box.fontSize || box.h;
    const reach = Math.ceil(size * 0.9);
    const base = box.base ?? (box.y + box.h * 0.8);
    let leftGuard = 0, rightGuard = page.w;
    for (const b of page.boxes) {
      if (b.id === box.id || b.erased) continue;
      const bBase = b.base ?? (b.y + b.h * 0.8);
      if (Math.abs(bBase - base) > Math.max(box.h, b.h) * 0.7) continue;
      if (b.x + b.w <= box.x + 1) leftGuard = Math.max(leftGuard, b.x + b.w + 2);
      if (b.x >= box.x + box.w - 1) rightGuard = Math.min(rightGuard, b.x - 2);
    }
    const minX = Math.max(0, Math.floor(Math.max(leftGuard, box.x - reach)));
    const maxX = Math.min(page.w, Math.ceil(Math.min(rightGuard, box.x + box.w + reach)));
    const y0 = Math.max(0, Math.floor(box.y)), y1 = Math.min(page.h, Math.ceil(box.y + box.h));
    if (maxX <= minX || y1 <= y0) return box;
    const strip = page.cleanCtx.getImageData(minX, y0, maxX - minX, y1 - y0);
    const ww = maxX - minX, hh = y1 - y0;
    const colInk = (px) => {
      const cx = px - minX;
      if (cx < 0 || cx >= ww) return false;
      for (let yy = 0; yy < hh; yy++) {
        const i = (yy * ww + cx) * 4;
        if (strip.data[i] + strip.data[i + 1] + strip.data[i + 2] < 420) return true;
      }
      return false;
    };
    // a clean gap ends the growth — but inter-LETTER gaps (~0.15 em) must be
    // stepped over, only an inter-WORD gap (~0.3 em+) stops the search
    const gap = Math.max(4, Math.round(size * 0.3));
    let x0 = Math.floor(box.x), run = 0;
    for (let px = x0 - 1; px >= minX; px--) {
      if (colInk(px)) { x0 = px; run = 0; }
      else if (++run >= gap) break;
    }
    let x1 = Math.ceil(box.x + box.w); run = 0;
    for (let px = x1; px < maxX; px++) {
      if (colInk(px)) { x1 = px + 1; run = 0; }
      else if (++run >= gap) break;
    }
    return { x: x0, y: box.y, w: x1 - x0, h: box.h };
  }

  applyReplace(page, box, newText) {
    box.erased = true;
    const base = this._eraseRegion(page, this._eraseRect(page, box));
    let anno = null;
    if (newText.trim()) {
      anno = this.drawTextRun(page, {
        text: newText, x: box.x, y: box.y, w: box.w, h: box.h, base: box.base,
        size: box.fontSize, color: box.color, bold: box.bold, italic: box.italic, family: box.family,
        fontName: box.fontName, origLen: box.text.length, kind: box.kind,
        maxW: this.lineSpace(page, box),
      });
    }
    const idx = this.pages.indexOf(page);
    this.undoStack.push({ type: "replace", page: idx, boxId: box.id, base, anno });
    this.redoStack = [];
    this.renderOverlays(page);
    this.updateThumb(idx);
    this.setStatus(newText.trim() ? `Replaced "${box.text}" → "${newText}"` : `Erased "${box.text}"`);
    this.emit();
  }

  /* Draw a text run onto the anno layer at the original size, shrinking only
     when it wouldn't fit the free space on its line (maxW). The glyphs are
     horizontally scaled so the replacement occupies a width proportional to
     the original word — the substitute font's metrics then blend in with the
     surrounding text. Returns { rect, before, after } for undo history. */
  /* Estimate the baseline slant of the line `box` sits on, from its neighbours
     (scans are often 0.3–1° skewed; drawing text dead-horizontal would stand
     out against the tilted line around it). Returns radians. */
  lineSlant(page, box) {
    const base = box.base ?? (box.y + box.h * 0.8);
    const pts = [];
    for (const b of page.boxes) {
      if (b.erased) continue;
      const bb = b.base ?? (b.y + b.h * 0.8);
      if (Math.abs(bb - base) < Math.max(box.h, b.h) * 2.2 && Math.abs(b.x - box.x) < page.w * 0.6)
        pts.push([b.x + b.w / 2, bb]);
    }
    if (pts.length < 4) return 0;
    const n = pts.length; let sx = 0, sy = 0, sxy = 0, sxx = 0;
    for (const [px, py] of pts) { sx += px; sy += py; sxy += px * py; sxx += px * px; }
    const denom = n * sxx - sx * sx; if (Math.abs(denom) < 1e-3) return 0;
    return clamp(Math.atan((n * sxy - sx * sy) / denom), -0.035, 0.035);
  }

  drawTextRun(page, { text, x, y, w, h, base, size, color, bold, italic, family, fontName, origLen, maxW, kind }) {
    const ctx = page.annoCtx;
    const weight = bold ? "700" : "400";
    const fstyle = italic ? "italic " : "";
    ensureWebFont(fontName, { bold, italic });
    const fam = fontStack({ fontName, family });
    const fontStr = (px) => `${fstyle}${weight} ${px}px ${fam}`;
    const baseY = base != null ? base : y + h * 0.8;
    const room = maxW ?? w * 1.06;
    const scanned = kind === "ocr";

    // font fallback callbacks for characters the atlas can't supply
    const meas = document.createElement("canvas").getContext("2d");
    const fontFn = {
      measure: (ch, px) => { meas.font = fontStr(px); return meas.measureText(ch).width; },
      draw: (cx, ch, px, baselineY, px2, col) => { cx.font = fontStr(px2); cx.textBaseline = "alphabetic"; cx.fillStyle = col; cx.fillText(ch, px, baselineY); },
    };

    // 1) typeset from the document's own glyphs (falls back to font per-char)
    const atlas = page.atlas;
    const cov = atlas ? atlas.coverage(text) : 0;
    let fit = size;
    const minSize = Math.max(7, size * 0.5);
    let master = atlas && atlas.typeset(text, fit, { color: color || "#111", fontFn, minCoverage: 0.6 });
    while (master && fit > minSize && master.width > room * 1.02) {   // shrink to fit the slot
      fit -= 0.5; master = atlas.typeset(text, fit, { color: color || "#111", fontFn, minCoverage: 0.6 });
    }

    let tw;
    const pad = 6;
    let sx = 1;
    if (master) {
      sx = clamp(room / Math.max(1, master.width), 0.8, 1.2);       // gentle width match
      tw = master.width * sx;
    } else {
      // pure font fallback
      meas.font = fontStr(fit);
      let nw = meas.measureText(text).width;
      const slot = origLen ? w * (text.length / Math.max(1, origLen)) : nw;
      sx = clamp(slot / Math.max(1, nw), 0.8, 1.25);
      while (fit > minSize && nw * sx > room) { fit -= 0.5; meas.font = fontStr(fit); nw = meas.measureText(text).width; }
      tw = nw * sx;
    }

    const slant = this.lineSlant(page, { x, base: baseY, h, w });
    const extra = Math.ceil(Math.abs(slant) * tw) + 3;
    const ix = clamp(Math.floor(x - pad), 0, page.w), iy = clamp(Math.floor(baseY - size - pad), 0, page.h);
    const iw = clamp(Math.ceil(Math.max(w, tw) + pad * 2), 1, page.w - ix);
    const ih = clamp(Math.ceil(size * 1.5 + pad * 2 + extra), 1, page.h - iy);
    const before = ctx.getImageData(ix, iy, iw, ih);

    if (master) {
      const dw = master.width * sx, dh = master.height, dx = x, dy = baseY - master.baseline;
      // all-donor ink already matches the scan exactly → draw crisp; mixed or
      // font-drawn ink on a scan gets softened to match the page's blur/noise
      if (scanned && cov < 0.999) {
        const look = measureScanLook(page, { x, y: iy, w: tw, h: size });
        const tmp = newCanvas(Math.ceil(dw) + 2, Math.ceil(dh) + 2);
        tmp.getContext("2d").drawImage(master.canvas, 0, 0, master.width, master.height, 0, 0, dw, dh);
        drawSoft(ctx, tmp, dx, dy, dw, dh, { blur: look.blur, slant, noise: look.noise });
      } else {
        ctx.save();
        if (slant) { ctx.translate(dx, baseY); ctx.rotate(slant); ctx.translate(-dx, -baseY); }
        ctx.drawImage(master.canvas, 0, 0, master.width, master.height, dx, dy, dw, dh);
        ctx.restore();
      }
    } else {
      // font-only: render to a temp alpha canvas, then composite (soft on scans)
      const tw2 = Math.ceil(tw) + pad * 2, th2 = Math.ceil(size * 1.6);
      const tmp = newCanvas(tw2, th2), tctx = tmp.getContext("2d");
      tctx.textBaseline = "alphabetic"; tctx.font = fontStr(fit); tctx.fillStyle = color || "#111";
      tctx.save(); tctx.translate(pad, size); tctx.scale(sx, 1); tctx.fillText(text, 0, 0); tctx.restore();
      const dx = x - pad, dy = baseY - size;
      if (scanned) {
        const look = measureScanLook(page, { x, y: iy, w: tw, h: size });
        drawSoft(ctx, tmp, dx, dy, tw2, th2, { blur: look.blur, slant, noise: look.noise });
      } else {
        ctx.save();
        if (slant) { ctx.translate(x, baseY); ctx.rotate(slant); ctx.translate(-x, -baseY); }
        ctx.drawImage(tmp, dx, dy);
        ctx.restore();
      }
    }
    const after = ctx.getImageData(ix, iy, iw, ih);
    this.composite(page);
    return { rect: { x: ix, y: iy, w: iw, h: ih }, before, after };
  }

  /* ── seamless erase (region patches) ────────────────────────────────── */
  sampleBackground(ctx, x, y, w, h) {
    const pad = Math.max(4, Math.round(h * 0.5));
    const ex = Math.max(0, Math.floor(x - pad)), ey = Math.max(0, Math.floor(y - pad));
    const ew = Math.min(ctx.canvas.width - ex, Math.ceil(w + pad * 2)), eh = Math.min(ctx.canvas.height - ey, Math.ceil(h + pad * 2));
    if (ew <= 0 || eh <= 0) return [255, 255, 255];
    const data = ctx.getImageData(ex, ey, ew, eh).data;
    const ix0 = x - ex, iy0 = y - ey, ix1 = ix0 + w, iy1 = iy0 + h;
    const counts = new Map();
    for (let py = 0; py < eh; py++) for (let px = 0; px < ew; px++) {
      if (px >= ix0 && px < ix1 && py >= iy0 && py < iy1) continue;
      const i = (py * ew + px) * 4; if (data[i + 3] < 200) continue;
      const key = ((data[i] & 0xf8) << 16) | ((data[i + 1] & 0xf8) << 8) | (data[i + 2] & 0xf8);
      let c = counts.get(key); if (!c) counts.set(key, (c = { n: 0, r: 0, g: 0, b: 0 }));
      c.n++; c.r += data[i]; c.g += data[i + 1]; c.b += data[i + 2];
    }
    let best = null; for (const c of counts.values()) if (!best || c.n > best.n) best = c;
    return best ? [Math.round(best.r / best.n), Math.round(best.g / best.n), Math.round(best.b / best.n)] : [255, 255, 255];
  }

  previewFill(page, rect) {
    const color = this.sampleBackground(page.ctx, rect.x, rect.y, rect.w, rect.h);
    page.baseCtx.fillStyle = `rgb(${color[0]},${color[1]},${color[2]})`;
    page.baseCtx.fillRect(rect.x - 2, rect.y - 2, rect.w + 4, rect.h + 4);
    this.composite(page);
  }

  /* Erase one rect through a small REGION round-trip instead of re-erasing
     the whole page: the server only ever sees a crop a couple of hundred
     pixels wide, so each edit costs a few KB instead of a multi-MB upload.
     Returns a region record { x, y, w, h, before, after } for undo/redo. */
  _eraseRegion(page, rect, mode = "auto") {
    // paste-back pad: object mode heals strokes spilling up to `grow` (24px)
    // outside the rect, so its undo window must cover them too
    const d = mode === "object" ? 32 : 4;
    const x = clamp(Math.floor(rect.x - d), 0, page.w), y = clamp(Math.floor(rect.y - d), 0, page.h);
    const w = clamp(Math.ceil(rect.w + d * 2), 1, page.w - x), h = clamp(Math.ceil(rect.h + d * 2), 1, page.h - y);
    const region = { x, y, w, h, mode, rect: { x: rect.x, y: rect.y, w: rect.w, h: rect.h },
                     before: page.baseCtx.getImageData(x, y, w, h), after: null, cancelled: false };
    if (mode !== "object") this.previewFill(page, rect);   // flat preview suits text erases only
    this._patchErase(page, region);                  // seamless server patch follows
    return region;
  }

  async _patchErase(page, region) {
    const rect = region.rect;
    // crop with enough margin for the server's background sampling (ring/interp);
    // capped so a big manual selection doesn't balloon into a whole-page upload
    const m = region.mode === "object" ? 72 : Math.ceil(clamp(rect.h * 1.5, 24, 64));
    const cx = clamp(Math.floor(rect.x - m), 0, page.w), cy = clamp(Math.floor(rect.y - m), 0, page.h);
    const cw = clamp(Math.ceil(rect.w + m * 2), 1, page.w - cx), ch = clamp(Math.ceil(rect.h + m * 2), 1, page.h - cy);
    const crop = newCanvas(cw, ch);
    crop.getContext("2d").drawImage(page.cleanCanvas, cx, cy, cw, ch, 0, 0, cw, ch);
    try {
      const fd = new FormData();
      fd.append("file", await canvasBlob(crop), "crop.png");
      fd.append("rects", JSON.stringify([{ x: rect.x - cx, y: rect.y - cy, w: rect.w, h: rect.h }]));
      fd.append("fillMode", region.mode === "object" ? "object" : "auto");
      const res = await fetch(this.api + "/api/erase", { method: "POST", body: fd });
      if (!res.ok) throw new Error("erase");
      const img = await loadImage(URL.createObjectURL(await res.blob()));
      if (region.cancelled) return;                  // undone before the patch landed
      const ctx = page.baseCtx;
      ctx.save();
      ctx.beginPath(); ctx.rect(region.x, region.y, region.w, region.h); ctx.clip();
      ctx.drawImage(img, cx, cy);                    // only the paste-back window changes
      ctx.restore();
      region.after = ctx.getImageData(region.x, region.y, region.w, region.h);
      this.composite(page);
      this.updateThumb(this.pages.indexOf(page));
    } catch (e) { console.error(e); }
  }

  /* ── undo / redo ────────────────────────────────────────────────────── */
  applyHistory(entry, useBefore) {
    const page = this.pages[entry.page];
    if (entry.type === "replace") {
      const b = page.boxes.find((x) => x.id === entry.boxId);
      const hidden = (entry.hiddenBoxes || []).map((id) => page.boxes.find((x) => x.id === id)).filter(Boolean);
      if (useBefore) {
        if (b) b.erased = false;
        hidden.forEach((x) => { x.erased = false; });
        if (entry.base) { entry.base.cancelled = true; page.baseCtx.putImageData(entry.base.before, entry.base.x, entry.base.y); }
        if (entry.anno) page.annoCtx.putImageData(entry.anno.before, entry.anno.rect.x, entry.anno.rect.y);
      } else {
        if (b) b.erased = true;
        hidden.forEach((x) => { x.erased = true; });
        if (entry.base) {
          entry.base.cancelled = false;
          if (entry.base.after) page.baseCtx.putImageData(entry.base.after, entry.base.x, entry.base.y);
          else { this.previewFill(page, entry.base.rect); this._patchErase(page, entry.base); }
        }
        if (entry.anno) page.annoCtx.putImageData(entry.anno.after, entry.anno.rect.x, entry.anno.rect.y);
      }
      this.composite(page);
      if (entry.page === this.current) this.renderOverlays(page);
      this.updateThumb(entry.page);
    }
  }
  async undo() { const e = this.undoStack.pop(); if (!e) return; if (e.page !== this.current) await this.showPage(e.page); this.applyHistory(e, true); this.redoStack.push(e); this.emit(); }
  async redo() { const e = this.redoStack.pop(); if (!e) return; if (e.page !== this.current) await this.showPage(e.page); this.applyHistory(e, false); this.undoStack.push(e); this.emit(); }

  async resetPage() {
    const page = this.pages[this.current]; if (!page) return;
    this.setLoading("Resetting…");
    try {
      this.buildLayers(page, await loadImage(page.src));
      page.boxes.forEach((b) => { b.erased = false; });
      this.undoStack = this.undoStack.filter((e) => e.page !== this.current);
      this.redoStack = this.redoStack.filter((e) => e.page !== this.current);
      this.mountPage(page); this.hideLoader(); this.toast("Page reset");
    } catch (e) { this.hideLoader(); this.toast("Reset failed", "error"); }
  }

  /* ── pointer: pan (default) / marquee (erase tool) ──────────────────── */
  attachPan(page) {
    const canvas = page.canvas, wrap = page._wrap;
    let pan = null, marquee = null;
    const toCanvas = (e) => {
      const r = canvas.getBoundingClientRect();
      return { x: clamp((e.clientX - r.left) * (page.w / r.width), 0, page.w),
               y: clamp((e.clientY - r.top) * (page.h / r.height), 0, page.h) };
    };
    const marqueeRect = (a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
                                     w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) });
    canvas.addEventListener("pointerdown", (e) => {
      if ((this.tool === "erase" || this.tool === "copy") && e.button === 0 && !this._space && !this._paste) {
        try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic/pen events */ }
        const el = document.createElement("div");
        el.className = "marquee";
        wrap.appendChild(el);
        marquee = { start: toCanvas(e), el };
        e.preventDefault();
        return;
      }
      if (e.button === 1 || this._space || e.button === 0) {
        try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic/pen events */ }
        pan = { x: e.clientX, y: e.clientY, sl: this.stageEl.scrollLeft, st: this.stageEl.scrollTop };
        wrap.style.cursor = "grabbing"; e.preventDefault();
      }
    });
    canvas.addEventListener("pointermove", (e) => {
      if (marquee) {
        const r = marqueeRect(marquee.start, toCanvas(e));
        marquee.el.style.left = (r.x / page.w) * 100 + "%";
        marquee.el.style.top = (r.y / page.h) * 100 + "%";
        marquee.el.style.width = (r.w / page.w) * 100 + "%";
        marquee.el.style.height = (r.h / page.h) * 100 + "%";
        return;
      }
      if (!pan) return;
      this.stageEl.scrollLeft = pan.sl - (e.clientX - pan.x);
      this.stageEl.scrollTop = pan.st - (e.clientY - pan.y);
    });
    canvas.addEventListener("pointerup", (e) => {
      if (marquee) {
        const r = marqueeRect(marquee.start, toCanvas(e));
        marquee.el.remove();
        marquee = null;
        if (this.tool === "copy") this.startPaste(page, r);
        else this.applyManualErase(page, r);
        return;
      }
      pan = null; wrap.style.cursor = "";
    });
  }

  /* ── copy & paste a region ──────────────────────────────────────────── */
  /* Grab the pixels under the marquee (base + anno, exactly as seen) into a
     floating, draggable copy. Place() bakes it onto the anno layer at its new
     spot — undoable like any edit. */
  startPaste(page, rect) {
    if (rect.w < 4 || rect.h < 4) return;
    this.cancelPaste();
    const sx = clamp(Math.floor(rect.x), 0, page.w), sy = clamp(Math.floor(rect.y), 0, page.h);
    const sw = clamp(Math.round(rect.w), 1, page.w - sx), sh = clamp(Math.round(rect.h), 1, page.h - sy);
    const clip = newCanvas(sw, sh);
    clip.getContext("2d").drawImage(page.canvas, sx, sy, sw, sh, 0, 0, sw, sh);
    // start the copy nudged down-right of the source so it's clearly grabbable
    const px = clamp(sx + Math.round(sh * 0.5), 0, page.w - sw);
    const py = clamp(sy + Math.round(sh * 0.5), 0, page.h - sh);
    const el = document.createElement("div");
    el.className = "paste-float";
    const view = document.createElement("canvas"); view.width = sw; view.height = sh;
    view.getContext("2d").drawImage(clip, 0, 0);
    view.style.width = "100%"; view.style.height = "100%"; view.style.display = "block";
    el.appendChild(view);
    // corner resize handles (drag to scale — keeps aspect, Shift for free)
    for (const corner of ["nw", "ne", "sw", "se"]) {
      const h = document.createElement("div");
      h.className = "paste-handle h-" + corner;
      el.appendChild(h);
      this._attachPasteResize(page, h, corner);
    }
    page._wrap.appendChild(el);
    this._paste = { page, clip, w: sw, h: sh, x: px, y: py, el };
    this._layoutPaste();
    this._attachPasteDrag(page, el);
    this.setStatus("Drag to move · drag a corner to resize (Shift = free) · Place (Enter) · Esc cancels.");
    this.emit();
  }

  _pasteToCanvas(page, e) {
    const r = page.canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) * (page.w / r.width), y: (e.clientY - r.top) * (page.h / r.height) };
  }

  _attachPasteResize(page, handle, corner) {
    let rz = null;
    handle.addEventListener("pointerdown", (e) => {
      if (!this._paste) return;
      handle.setPointerCapture(e.pointerId);
      const p = this._paste;
      const anchors = { se: [p.x, p.y], nw: [p.x + p.w, p.y + p.h],
                        ne: [p.x, p.y + p.h], sw: [p.x + p.w, p.y] };
      rz = { anchor: anchors[corner], aspect: p.w / p.h };
      e.preventDefault(); e.stopPropagation();
    });
    handle.addEventListener("pointermove", (e) => {
      if (!rz || !this._paste) return;
      const pt = this._pasteToCanvas(page, e);
      const [ax, ay] = rz.anchor;
      let W = Math.abs(pt.x - ax), H = Math.abs(pt.y - ay);
      if (!e.shiftKey) { if (W / rz.aspect > H) H = W / rz.aspect; else W = H * rz.aspect; }
      W = clamp(W, 10, page.w); H = clamp(H, 10, page.h);
      let nx = (corner === "se" || corner === "ne") ? ax : ax - W;
      let ny = (corner === "se" || corner === "sw") ? ay : ay - H;
      nx = clamp(nx, 0, page.w - W); ny = clamp(ny, 0, page.h - H);
      const p = this._paste; p.w = W; p.h = H; p.x = nx; p.y = ny;
      this._layoutPaste();
    });
    handle.addEventListener("pointerup", () => { rz = null; });
  }

  _layoutPaste() {
    const p = this._paste; if (!p) return;
    const { page } = p;
    p.el.style.left = (p.x / page.w) * 100 + "%";
    p.el.style.top = (p.y / page.h) * 100 + "%";
    p.el.style.width = (p.w / page.w) * 100 + "%";
    p.el.style.height = (p.h / page.h) * 100 + "%";
  }

  _attachPasteDrag(page, el) {
    const canvas = page.canvas;
    let drag = null;
    const toCanvas = (e) => {
      const r = canvas.getBoundingClientRect();
      return { x: (e.clientX - r.left) * (page.w / r.width), y: (e.clientY - r.top) * (page.h / r.height) };
    };
    el.addEventListener("pointerdown", (e) => {
      if (!this._paste) return;
      el.setPointerCapture(e.pointerId);
      const pt = toCanvas(e);
      drag = { dx: pt.x - this._paste.x, dy: pt.y - this._paste.y };
      e.preventDefault(); e.stopPropagation();
    });
    el.addEventListener("pointermove", (e) => {
      if (!drag || !this._paste) return;
      const pt = toCanvas(e);
      this._paste.x = clamp(pt.x - drag.dx, 0, page.w - this._paste.w);
      this._paste.y = clamp(pt.y - drag.dy, 0, page.h - this._paste.h);
      this._layoutPaste();
    });
    el.addEventListener("pointerup", () => { drag = null; });
  }

  commitPaste() {
    const p = this._paste; if (!p) return;
    const { page, clip } = p;
    const x = clamp(Math.round(p.x), 0, page.w - 1), y = clamp(Math.round(p.y), 0, page.h - 1);
    const w = clamp(Math.round(p.w), 1, page.w - x), h = clamp(Math.round(p.h), 1, page.h - y);
    const before = page.annoCtx.getImageData(x, y, w, h);
    page.annoCtx.imageSmoothingEnabled = true; page.annoCtx.imageSmoothingQuality = "high";
    page.annoCtx.drawImage(clip, x, y, w, h);            // scaled to the resized box
    const after = page.annoCtx.getImageData(x, y, w, h);
    p.el.remove(); this._paste = null;
    const idx = this.pages.indexOf(page);
    this.undoStack.push({ type: "replace", page: idx, boxId: null, base: null,
                          anno: { rect: { x, y, w, h }, before, after }, hiddenBoxes: [] });
    this.redoStack = [];
    this.composite(page);
    this.updateThumb(idx);
    this.setStatus("Pasted — ⌘Z to undo.");
    this.emit();
  }

  cancelPaste() {
    if (!this._paste) return;
    this._paste.el.remove();
    this._paste = null;
    this.emit();
  }

  /* Magic erase: seamlessly remove EVERYTHING in the dragged area — original
     pixels (stamps, marks, objects) AND any replacement text previously typed
     there (the anno layer), through the same undoable region pipeline. */
  applyManualErase(page, rect) {
    if (rect.w < 5 || rect.h < 5) return;              // ignore accidental clicks
    const base = this._eraseRegion(page, rect, "object");
    // wipe typed/replacement text inside the selection — magic erase must
    // never leave (or appear to add) any text
    const annoBefore = page.annoCtx.getImageData(base.x, base.y, base.w, base.h);
    page.annoCtx.clearRect(base.x, base.y, base.w, base.h);
    const annoAfter = page.annoCtx.getImageData(base.x, base.y, base.w, base.h);
    const anno = { rect: { x: base.x, y: base.y, w: base.w, h: base.h }, before: annoBefore, after: annoAfter };
    const hidden = [];
    for (const b of page.boxes) {                       // words whose center the area swallows
      const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
      if (!b.erased && cx >= rect.x && cx <= rect.x + rect.w && cy >= rect.y && cy <= rect.y + rect.h) {
        b.erased = true;
        hidden.push(b.id);
      }
    }
    const idx = this.pages.indexOf(page);
    this.undoStack.push({ type: "replace", page: idx, boxId: null, base, anno, hiddenBoxes: hidden });
    this.redoStack = [];
    this.composite(page);
    this.renderOverlays(page);
    this.updateThumb(idx);
    this.setStatus("Area erased — ⌘Z to undo.");
    this.emit();
  }

  /* ── thumbnails ─────────────────────────────────────────────────────── */
  buildThumbs() {
    if (!this.thumbsEl) return;
    this.thumbsEl.innerHTML = "";
    this.pages.forEach((page, i) => {
      const t = document.createElement("div"); t.className = "thumb";
      const tc = newCanvas(180, Math.round(180 * (page.h / page.w)));
      loadImage(page.thumbSrc).then((img) => tc.getContext("2d").drawImage(img, 0, 0, tc.width, tc.height)).catch(() => {});
      const label = document.createElement("span"); label.className = "thumb-num"; label.textContent = i + 1;
      t.append(tc, label);
      t.addEventListener("click", () => this.showPage(i));
      page._thumbCanvas = tc;
      this.thumbsEl.appendChild(t);
    });
    this.updateThumbActive();
  }
  updateThumbActive() { if (this.thumbsEl) [...this.thumbsEl.children].forEach((t, i) => t.classList.toggle("active", i === this.current)); }
  updateThumb(i) {
    const page = this.pages[i];
    if (page && page.canvas && page._thumbCanvas) {
      const tc = page._thumbCanvas; tc.height = Math.round(tc.width * (page.h / page.w));
      tc.getContext("2d").drawImage(page.canvas, 0, 0, tc.width, tc.height);
    }
  }

  /* ── AI editing (natural-language instructions → proposals) ─────────── */
  _findBox(id) {
    for (const page of this.pages) {
      const box = page.boxes.find((b) => b.id === id);
      if (box) return { page, box };
    }
    return null;
  }

  async proposeEdits(instruction) {
    if (!this.session || this.aiEditLoading) return;
    this.aiEditLoading = true; this.aiProposals = []; this.emit();
    try {
      const fd = new FormData();
      fd.append("session", this.session);
      fd.append("instruction", instruction);
      const res = await fetch(this.api + "/api/ai-edit", { method: "POST", body: fd });
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.detail || `AI error ${res.status}`); }
      const { edits } = await res.json();
      this.aiProposals = edits
        .filter((e) => { const f = this._findBox(e.id); return f && !f.box.erased; })
        .map((e) => ({ ...e, checked: true }));
      if (!this.aiProposals.length) this.toast("AI found nothing to change");
    } catch (e) { console.error(e); this.toast(e.message || "AI edit failed", "error"); }
    this.aiEditLoading = false; this.emit();
  }

  toggleProposal(id) { this.aiProposals = this.aiProposals.map((p) => (p.id === id ? { ...p, checked: !p.checked } : p)); this.emit(); }
  discardProposals() { this.aiProposals = []; this.emit(); }

  async gotoProposal(id) {
    const f = this._findBox(id); if (!f) return;
    const idx = this.pages.indexOf(f.page);
    if (idx !== this.current) await this.showPage(idx);
    const el = f.page._overlay?.querySelector(`[data-id="${id}"]`);
    if (el) { el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash"); setTimeout(() => el.classList.remove("flash"), 1300); }
  }

  /* Apply the checked proposals through the same erase+draw path as manual
     edits, so undo/redo and export behave identically. */
  async applyProposals() {
    const sel = this.aiProposals.filter((p) => p.checked);
    if (!sel.length) return;
    this.setLoading("Applying AI edits…", 90000);
    let n = 0;
    try {
      for (const pr of sel) {
        const f = this._findBox(pr.id);
        if (!f || f.box.erased) continue;
        await this.ensurePageLoaded(f.page);
        this.applyReplace(f.page, f.box, pr.newText);
        n++;
      }
    } finally {
      this.aiProposals = [];
      this.hideLoader();
    }
    this.toast(`${n} AI edit${n === 1 ? "" : "s"} applied`, "success");
    this.setStatus(`${n} AI edit${n === 1 ? "" : "s"} applied — undo steps back one edit at a time.`);
  }

  /* ── support (report a problem) ─────────────────────────────────────── */
  /* Snapshot the current page as it looks now (with edits) — the user's
     "screenshot of the problem" without leaving the app. */
  async snapshotView() {
    const page = this.pages[this.current];
    if (!page || !page.canvas) return null;
    return canvasBlob(page.canvas);
  }

  async submitSupport({ message, email, screenshot, document }) {
    const fd = new FormData();
    fd.append("message", message);
    if (email) fd.append("email", email);
    if (this.session) fd.append("session", this.session);   // attaches the open doc server-side
    if (screenshot) fd.append("screenshot", screenshot, "screenshot.png");
    if (document) fd.append("document", document, document.name || "document");
    const res = await fetch(this.api + "/api/support", { method: "POST", body: fd });
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.detail || `Failed (${res.status})`); }
    return (await res.json()).ticket;
  }

  /* ── export ─────────────────────────────────────────────────────────── */
  download(blob, name) { const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
  async exportPng() { const page = this.pages[this.current]; if (!page) return; this.download(await canvasBlob(page.canvas), `page-${this.current + 1}.png`); this.toast("PNG downloaded", "success"); }
  async exportPdf() {
    this.commitReplace();
    this.setLoading("Preparing pages… 0%", Math.max(120000, this.pages.length * 10000));
    let ticker = null;
    try {
      const fd = new FormData();
      for (let i = 0; i < this.pages.length; i++) {
        this.progress = (i / this.pages.length) * 0.3;   // page rendering = first 30%
        this.loadingText = `Preparing pages… ${Math.round(this.progress * 100)}%`;
        this.emit();
        const page = this.pages[i];
        let blob;
        if (page.loaded) blob = await canvasBlob(page.canvas);
        else blob = await (await fetch(page.src)).blob();
        fd.append("files", blob, `p${i}.png`);
      }
      const res = await this._upload(this.api + "/api/export", fd, (f) => {
        this.progress = 0.3 + f * 0.6;                   // upload = next 60%
        this.loadingText = `Uploading… ${Math.round(f * 100)}%`;
        this.emit();
        if (f >= 1 && !ticker) ticker = this._creep("Building PDF…");
      });
      clearInterval(ticker); ticker = null;
      if (!res.ok) throw new Error("export failed");
      this.setProgress(1);
      this.download(res.blob, "document-edited.pdf");
      this.hideLoader(); this.toast("PDF exported", "success");
    } catch (e) { clearInterval(ticker); console.error(e); this.hideLoader(); this.toast("Export failed", "error"); }
  }

  /* ── zoom ───────────────────────────────────────────────────────────── */
  zoomBy(mult, cx, cy) {
    const page = this.pages[this.current]; if (!page) return;
    const stage = this.stageEl, srect = stage.getBoundingClientRect();
    const prev = page.canvas.getBoundingClientRect();
    const ax = cx ?? (srect.left + stage.clientWidth / 2);   // anchor point to keep stable
    const ay = cy ?? (srect.top + stage.clientHeight / 2);
    const fx = prev.width ? (ax - prev.left) / prev.width : 0.5;
    const fy = prev.height ? (ay - prev.top) / prev.height : 0.5;
    this.zoom = clamp(this.zoom * mult, 0.2, 8);
    this.layoutCanvas(page);
    const next = page.canvas.getBoundingClientRect();
    stage.scrollLeft += (next.left + fx * next.width) - ax;   // keep the anchor under the cursor
    stage.scrollTop += (next.top + fy * next.height) - ay;
    this.emit();
  }
  zoomFit() { this.zoom = 1; this.layoutCanvas(this.pages[this.current]); if (this.stageEl) { this.stageEl.scrollLeft = 0; this.stageEl.scrollTop = 0; } this.emit(); }
}
