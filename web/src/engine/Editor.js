/* ============================================================================
 * Editor — imperative canvas engine (framework-agnostic).
 *
 * React owns the chrome (topbar, rail, inspector, toasts, loader) and reads a
 * snapshot of this engine's state via onState(). The engine owns the canvas
 * stage, number overlays and thumbnails (mounted into refs React provides).
 *
 * Per page, layered canvases:
 *   cleanCanvas → original image (no removals)
 *   baseCanvas  → clean + removals inpainted (regenerated on change)
 *   annoCanvas  → brush strokes
 *   canvas      → composite shown on screen
 * Number/area removal is done by SERVER-SIDE INPAINTING for a seamless result.
 * ========================================================================== */
import gsap from "gsap";

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const hexToRgb = (h) => { const m = h.replace("#", ""); return [parseInt(m.slice(0, 2), 16), parseInt(m.slice(2, 4), 16), parseInt(m.slice(4, 6), 16)]; };
const rgbToHex = (r, g, b) => "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
const newCanvas = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
const cloneCanvas = (c) => { const n = newCanvas(c.width, c.height); n.getContext("2d").drawImage(c, 0, 0); return n; };
const ctx2d = (c) => c.getContext("2d", { willReadFrequently: true });
const loadImage = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
const canvasBlob = (c) => new Promise((res) => c.toBlob(res, "image/png"));

export default class Editor {
  constructor({ api = "", onState = () => {}, onToast = () => {} } = {}) {
    this.api = api;
    this.onState = onState;
    this.onToast = onToast;

    this.session = null;
    this.ocrAvailable = false;
    this.pages = [];
    this.current = -1;
    this.tool = "erase";
    this.brushColor = "#e23744";
    this.brushSize = 14;
    this.brushOpacity = 1;
    this.brushStyle = "pen";       // pen | marker | highlighter
    this._space = false;           // space held → pan in any tool
    this.pickMode = null;          // "brush" | "fill" while sampling a color
    this._stroke = null; this._strokePage = null; this._strokeCtx = null;
    this.fillMode = "auto";
    this.fixedColor = "#ffffff";
    this.showOverlays = true;
    this.zoom = 1;
    this.undoStack = [];
    this.redoStack = [];

    this.navSeq = 0;
    this.removalSeq = 1;
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
    // Hold SPACE to pan in any tool.
    this._onSpaceDown = (e) => { if (e.code === "Space" && e.target.tagName !== "INPUT") { this._space = true; e.preventDefault(); } };
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
      tool: this.tool, fillMode: this.fillMode, fixedColor: this.fixedColor,
      brushColor: this.brushColor, brushSize: this.brushSize, brushOpacity: this.brushOpacity, brushStyle: this.brushStyle,
      showOverlays: this.showOverlays, picking: !!this.pickMode,
      current: this.current, pageCount: this.pages.length, zoom: this.zoom,
      count: p ? p.boxes.filter((b) => !b.erased).length : 0,
      mode: p ? p.mode : "original",
      scanned: p ? p.scanned : false, ocrAvailable: this.ocrAvailable,
      canUndo: this.undoStack.length > 0, canRedo: this.redoStack.length > 0,
      status: this.status,
    };
  }
  emit() { this.onState(this.snapshot()); }
  toast(m, k) { this.onToast(m, k); }

  setLoading(text) { this.loading = true; this.loadingText = text; this.progress = 0; clearTimeout(this._loaderTimer); this._loaderTimer = setTimeout(() => { this.loading = false; this.emit(); this.toast("That took too long — please retry.", "error"); }, 30000); this.emit(); }
  setProgress(f) { this.progress = f; this.emit(); }
  hideLoader() { clearTimeout(this._loaderTimer); this.loading = false; this.emit(); }
  setStatus(s) { this.status = s; this.emit(); }

  /* ── load + analyze ─────────────────────────────────────────────────── */
  async open(file) {
    try {
      this.setLoading("Uploading & analyzing…");
      const fd = new FormData(); fd.append("file", file);
      const res = await fetch(this.api + "/api/analyze", { method: "POST", body: fd });
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.detail || `Server error ${res.status}`); }
      const json = await res.json();

      this.session = json.session; this.ocrAvailable = json.ocrAvailable;
      this.current = -1; this.undoStack = []; this.redoStack = [];
      this.pages = json.pages.map((p) => ({
        w: p.width, h: p.height, scanned: p.scanned, index: p.index, mode: "original",
        boxes: p.boxes.map((b) => ({ ...b, erased: false })),
        boxes0: p.boxes.map((b) => ({ ...b, erased: false })),
        removals: [],
        src: `${this.api}/api/page/${json.session}/${p.index}`,
        thumbSrc: `${this.api}/api/thumb/${json.session}/${p.index}`,
        loaded: false,
      }));

      this.buildThumbs();
      this.setProgress(1);
      await this.showPage(0);
      this.hideLoader();
      gsap.from(".canvas-wrap", { y: 22, opacity: 0, duration: 0.45, ease: "power3.out" });

      const total = this.pages.length, nums = this.pages.reduce((n, p) => n + p.boxes.length, 0);
      this.toast(`Loaded ${total} page${total > 1 ? "s" : ""} · ${nums} numbers found`, "success");
    } catch (err) { console.error(err); this.hideLoader(); this.toast("Could not analyze that file", "error"); this.setStatus("Failed — " + (err.message || err)); }
  }

  /* ── layered page model ─────────────────────────────────────────────── */
  composite(page) {
    page.ctx.clearRect(0, 0, page.w, page.h);
    page.ctx.drawImage(page.baseCanvas, 0, 0);
    page.ctx.drawImage(page.annoCanvas, 0, 0);
    if (this._stroke && this._strokePage === page) {       // live brush stroke at its opacity
      page.ctx.globalAlpha = this._stroke.opacity;
      page.ctx.drawImage(this._stroke.canvas, 0, 0);
      page.ctx.globalAlpha = 1;
    }
  }
  buildLayers(page, img) {
    page.w = img.naturalWidth; page.h = img.naturalHeight;
    page.cleanCanvas = newCanvas(page.w, page.h); page.cleanCtx = ctx2d(page.cleanCanvas); page.cleanCtx.drawImage(img, 0, 0);
    page.baseCanvas = newCanvas(page.w, page.h); page.baseCtx = ctx2d(page.baseCanvas); page.baseCtx.drawImage(img, 0, 0);
    page.annoCanvas = newCanvas(page.w, page.h); page.annoCtx = ctx2d(page.annoCanvas);
    page.canvas = newCanvas(page.w, page.h); page.ctx = ctx2d(page.canvas);
    this.composite(page);
  }
  async ensurePageLoaded(page) { if (page.loaded) return; this.buildLayers(page, await loadImage(page.src)); page.loaded = true; }

  async showPage(index) {
    if (index < 0 || index >= this.pages.length) return;
    const myNav = ++this.navSeq;
    const page = this.pages[index];
    if (!page.loaded) {
      this.setLoading("Loading page…");
      try { await this.ensurePageLoaded(page); }
      catch (e) { if (myNav === this.navSeq) { this.hideLoader(); this.toast("Couldn’t load page — re-upload.", "error"); } return; }
    }
    if (myNav !== this.navSeq) return;
    this.hideLoader();
    this.current = index;
    this.mountPage(page);
    this.setStatus(page.scanned ? (this.ocrAvailable ? "Scanned — numbers found via OCR." : "Scanned — use Cover or Brush.") : "Click a number to erase it.");
    this.emit();
  }

  mountPage(page) {
    this.hostEl.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.className = "canvas-wrap tool-" + this.tool;
    wrap.appendChild(page.canvas);
    const overlay = document.createElement("div");
    overlay.className = "overlay-layer" + (this.showOverlays ? "" : " hidden");
    wrap.appendChild(overlay);
    const cursor = document.createElement("div");
    cursor.className = "brush-cursor"; cursor.hidden = true;
    wrap.appendChild(cursor);
    page._overlay = overlay; page._wrap = wrap; page._brushCursor = cursor;
    this.hostEl.appendChild(wrap);
    this.layoutCanvas(page);
    this.attachCanvasTools(page);
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

  renderOverlays(page) {
    const overlay = page._overlay; if (!overlay) return;
    overlay.innerHTML = "";
    for (const box of page.boxes) {
      if (box.erased) continue;
      const d = document.createElement("div");
      d.className = "num-box" + (box.kind === "mixed" ? " mixed" : "");
      d.style.left = (box.x / page.w) * 100 + "%"; d.style.top = (box.y / page.h) * 100 + "%";
      d.style.width = (box.w / page.w) * 100 + "%"; d.style.height = (box.h / page.h) * 100 + "%";
      d.title = box.text;
      d.addEventListener("click", (e) => { e.stopPropagation(); if (this.tool === "erase") this.eraseBox(page, box, d); });
      overlay.appendChild(d);
    }
    gsap.fromTo(overlay.children, { opacity: 0, scale: 0.85 }, { opacity: 1, scale: 1, duration: 0.3, stagger: 0.004, ease: "power2.out" });
    this.emit();
  }

  updateThumbActive() { if (this.thumbsEl) [...this.thumbsEl.children].forEach((t, i) => t.classList.toggle("active", i === this.current)); }

  /* ── removals → inpaint ─────────────────────────────────────────────── */
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
    const color = this.fillMode === "fixed" ? hexToRgb(this.fixedColor) : this.sampleBackground(page.ctx, rect.x, rect.y, rect.w, rect.h);
    page.baseCtx.fillStyle = `rgb(${color[0]},${color[1]},${color[2]})`;
    page.baseCtx.fillRect(rect.x, rect.y, rect.w, rect.h);
    this.composite(page);
  }

  addRemoval(page, rect, { boxId = null } = {}) {
    const x = clamp(Math.floor(rect.x), 0, page.w), y = clamp(Math.floor(rect.y), 0, page.h);
    const w = clamp(Math.ceil(rect.w), 1, page.w - x), h = clamp(Math.ceil(rect.h), 1, page.h - y);
    const rm = { id: this.removalSeq++, x, y, w, h, boxId };
    page.removals.push(rm);
    this.previewFill(page, rm);
    this.scheduleRefresh(page);
    this.undoStack.push({ type: "removal", page: this.pages.indexOf(page), removal: rm });
    this.redoStack = []; this.emit();
  }

  scheduleRefresh(page) { clearTimeout(page._rtimer); page._rtimer = setTimeout(() => this.doRefresh(page), 220); }

  async doRefresh(page) {
    const myseq = (page._rseq = (page._rseq || 0) + 1);
    const idx = this.pages.indexOf(page);
    if (!page.removals.length) { page.baseCtx.clearRect(0, 0, page.w, page.h); page.baseCtx.drawImage(page.cleanCanvas, 0, 0); this.composite(page); this.updateThumb(idx); return; }
    try {
      const fd = new FormData();
      fd.append("file", await canvasBlob(page.cleanCanvas), "clean.png");
      fd.append("rects", JSON.stringify(page.removals.map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h }))));
      const res = await fetch(this.api + "/api/inpaint", { method: "POST", body: fd });
      if (!res.ok) throw new Error("inpaint");
      const img = await loadImage(URL.createObjectURL(await res.blob()));
      if (myseq !== page._rseq) return;
      page.baseCtx.clearRect(0, 0, page.w, page.h); page.baseCtx.drawImage(img, 0, 0); this.composite(page); this.updateThumb(idx);
    } catch (e) { console.error(e); }
  }

  eraseBox(page, box, domEl) {
    box.erased = true;
    this.addRemoval(page, box, { boxId: box.id });
    if (domEl) gsap.to(domEl, { scale: 1.25, opacity: 0, duration: 0.28, ease: "power2.out", onComplete: () => domEl.remove() });
    this.emit();
  }

  eraseAll() {
    const page = this.pages[this.current]; if (!page) return;
    const pending = page.boxes.filter((b) => !b.erased);
    if (!pending.length) return this.toast("No numbers left to erase");
    pending.forEach((b) => { b.erased = true; this.addRemoval(page, b, { boxId: b.id }); });
    this.renderOverlays(page);
    this.toast(`Erased ${pending.length} number${pending.length > 1 ? "s" : ""}`, "success");
  }

  /* ── brush (anno layer) ─────────────────────────────────────────────── */
  pushAnno(pageIndex, rect, before, after) { this.undoStack.push({ type: "anno", page: pageIndex, rect, before, after }); this.redoStack = []; this.updateThumb(pageIndex); this.emit(); }
  commitStroke(page, snap, bbox) {
    if (!bbox) return;
    const m = this.brushSize + 4;
    const x = clamp(Math.floor(bbox.x0 - m), 0, page.w), y = clamp(Math.floor(bbox.y0 - m), 0, page.h);
    const w = clamp(Math.ceil(bbox.x1 - bbox.x0 + m * 2), 1, page.w - x), h = clamp(Math.ceil(bbox.y1 - bbox.y0 + m * 2), 1, page.h - y);
    this.pushAnno(this.current, { x, y, w, h }, snap.getContext("2d").getImageData(x, y, w, h), page.annoCtx.getImageData(x, y, w, h));
  }

  /* ── undo / redo / reset ────────────────────────────────────────────── */
  snapshotFull(page) { return { clean: cloneCanvas(page.cleanCanvas), anno: cloneCanvas(page.annoCanvas), removals: page.removals.map((r) => ({ ...r })), boxes: page.boxes.map((b) => ({ ...b })), w: page.w, h: page.h, mode: page.mode }; }
  restoreFull(page, snap) {
    page.w = snap.w; page.h = snap.h; page.mode = snap.mode;
    page.cleanCanvas = cloneCanvas(snap.clean); page.cleanCtx = ctx2d(page.cleanCanvas);
    page.annoCanvas = cloneCanvas(snap.anno); page.annoCtx = ctx2d(page.annoCanvas);
    page.baseCanvas = cloneCanvas(snap.clean); page.baseCtx = ctx2d(page.baseCanvas);
    page.canvas = newCanvas(page.w, page.h); page.ctx = ctx2d(page.canvas);
    page.removals = snap.removals.map((r) => ({ ...r })); page.boxes = snap.boxes.map((b) => ({ ...b }));
    this.composite(page); this.scheduleRefresh(page);
  }
  pushFull(pageIndex, before, after) { this.undoStack.push({ type: "full", page: pageIndex, before, after }); this.redoStack = []; this.updateThumb(pageIndex); this.emit(); }

  applyHistory(entry, useBefore) {
    const page = this.pages[entry.page];
    if (entry.type === "removal") {
      const rm = entry.removal;
      if (useBefore) { page.removals = page.removals.filter((r) => r.id !== rm.id); if (rm.boxId != null) { const b = page.boxes.find((x) => x.id === rm.boxId); if (b) b.erased = false; } }
      else { page.removals.push(rm); if (rm.boxId != null) { const b = page.boxes.find((x) => x.id === rm.boxId); if (b) b.erased = true; } }
      this.scheduleRefresh(page);
      if (entry.page === this.current) this.renderOverlays(page);
    } else if (entry.type === "anno") {
      page.annoCtx.putImageData(useBefore ? entry.before : entry.after, entry.rect.x, entry.rect.y);
      this.composite(page); this.updateThumb(entry.page);
    } else {
      this.restoreFull(page, useBefore ? entry.before : entry.after);
      if (entry.page === this.current) this.mountPage(page); else this.updateThumb(entry.page);
    }
  }
  async undo() { const e = this.undoStack.pop(); if (!e) return; if (e.page !== this.current) await this.showPage(e.page); this.applyHistory(e, true); this.redoStack.push(e); this.emit(); }
  async redo() { const e = this.redoStack.pop(); if (!e) return; if (e.page !== this.current) await this.showPage(e.page); this.applyHistory(e, false); this.undoStack.push(e); this.emit(); }

  async resetPage() {
    const page = this.pages[this.current];
    this.setLoading("Resetting…");
    try {
      this.buildLayers(page, await loadImage(page.src));
      page.boxes = page.boxes0.map((b) => ({ ...b })); page.removals = []; page.mode = "original";
      this.undoStack = this.undoStack.filter((e) => e.page !== this.current);
      this.redoStack = this.redoStack.filter((e) => e.page !== this.current);
      this.mountPage(page); this.hideLoader(); this.toast("Page reset");
    } catch (e) { this.hideLoader(); this.toast("Reset failed", "error"); }
  }

  /* ── pointer tools ──────────────────────────────────────────────────── */
  canvasPoint(canvas, e) { const r = canvas.getBoundingClientRect(); return { x: (e.clientX - r.left) * (canvas.width / r.width), y: (e.clientY - r.top) * (canvas.height / r.height) }; }
  attachCanvasTools(page) {
    const canvas = page.canvas, wrap = page._wrap, cur = page._brushCursor;
    let mode = null, pan = null, drag = null, snap = null, marquee = null, bbox = null;
    const expand = (p) => { if (!bbox) bbox = { x0: p.x, y0: p.y, x1: p.x, y1: p.y }; bbox.x0 = Math.min(bbox.x0, p.x); bbox.y0 = Math.min(bbox.y0, p.y); bbox.x1 = Math.max(bbox.x1, p.x); bbox.y1 = Math.max(bbox.y1, p.y); };
    const dispScale = () => (canvas.clientWidth || canvas.width) / canvas.width;

    const moveCursor = (e) => {
      if (!cur) return;
      if (this.tool !== "brush" || mode === "pan") { cur.hidden = true; return; }
      const r = wrap.getBoundingClientRect(), d = this.brushSize * dispScale();
      cur.style.width = cur.style.height = d + "px";
      cur.style.left = (e.clientX - r.left) + "px"; cur.style.top = (e.clientY - r.top) + "px";
      cur.style.borderColor = this.brushColor; cur.hidden = false;
    };
    canvas.addEventListener("pointermove", moveCursor);
    canvas.addEventListener("pointerleave", () => { if (cur) cur.hidden = true; });

    canvas.addEventListener("pointerdown", (e) => {
      // Eyedropper (fallback): sample the pixel under the cursor.
      if (this.pickMode) {
        const p = this.canvasPoint(canvas, e);
        const d = page.ctx.getImageData(clamp(Math.floor(p.x), 0, page.w - 1), clamp(Math.floor(p.y), 0, page.h - 1), 1, 1).data;
        this.applyPicked(rgbToHex(d[0], d[1], d[2]), this.pickMode);
        this.pickMode = null; wrap.classList.remove("pick"); this.emit();
        e.preventDefault(); return;
      }
      // Pan: middle-button, SPACE held, or the Erase tool (which only clicks number boxes).
      if (e.button === 1 || this._space || (this.tool === "erase" && e.button === 0)) {
        mode = "pan"; canvas.setPointerCapture(e.pointerId);
        pan = { x: e.clientX, y: e.clientY, sl: this.stageEl.scrollLeft, st: this.stageEl.scrollTop };
        wrap.style.cursor = "grabbing"; if (cur) cur.hidden = true; e.preventDefault(); return;
      }
      const p = this.canvasPoint(canvas, e);
      if (this.tool === "brush") {
        mode = "brush"; canvas.setPointerCapture(e.pointerId);
        drag = p; bbox = null; expand(p); snap = cloneCanvas(page.annoCanvas);
        const sc = newCanvas(page.w, page.h);
        this._stroke = { canvas: sc, opacity: this.brushOpacity }; this._strokePage = page;
        this._strokeCtx = sc.getContext("2d");
        this._strokeCtx.strokeStyle = this.brushColor; this._strokeCtx.lineWidth = this.brushSize;
        this._strokeCtx.lineCap = this.brushStyle === "highlighter" ? "butt" : "round"; this._strokeCtx.lineJoin = "round";
        this._strokeCtx.beginPath(); this._strokeCtx.moveTo(p.x, p.y);
        this._strokeCtx.lineTo(p.x + 0.01, p.y); this._strokeCtx.stroke(); this.composite(page); // dot on click
      } else if (this.tool === "cover") {
        mode = "cover"; canvas.setPointerCapture(e.pointerId);
        drag = p; marquee = document.createElement("div"); marquee.className = "marquee"; wrap.appendChild(marquee);
      }
    });

    canvas.addEventListener("pointermove", (e) => {
      if (mode === "pan") { this.stageEl.scrollLeft = pan.sl - (e.clientX - pan.x); this.stageEl.scrollTop = pan.st - (e.clientY - pan.y); return; }
      if (!drag) return;
      const p = this.canvasPoint(canvas, e);
      if (mode === "brush") { expand(p); this._strokeCtx.lineTo(p.x, p.y); this._strokeCtx.stroke(); this.composite(page); }
      else if (marquee) {
        const x = Math.min(drag.x, p.x), y = Math.min(drag.y, p.y), w = Math.abs(p.x - drag.x), h = Math.abs(p.y - drag.y);
        marquee.style.left = (x / page.w) * 100 + "%"; marquee.style.top = (y / page.h) * 100 + "%";
        marquee.style.width = (w / page.w) * 100 + "%"; marquee.style.height = (h / page.h) * 100 + "%";
      }
    });

    canvas.addEventListener("pointerup", (e) => {
      if (mode === "pan") { mode = null; pan = null; wrap.style.cursor = ""; return; }
      if (!drag) { mode = null; return; }
      const p = this.canvasPoint(canvas, e), start = drag; drag = null;
      if (mode === "brush") {
        page.annoCtx.globalAlpha = this.brushOpacity;
        page.annoCtx.drawImage(this._stroke.canvas, 0, 0);
        page.annoCtx.globalAlpha = 1;
        this._stroke = null; this._strokePage = null; this._strokeCtx = null;
        this.composite(page);
        this.commitStroke(page, snap, bbox); snap = null;
      } else if (mode === "cover") {
        if (marquee) { marquee.remove(); marquee = null; }
        const rect = { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) };
        if (rect.w > 3 && rect.h > 3) { this.addRemoval(page, rect, {}); this.toast("Removed", "success"); }
      }
      mode = null;
    });
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
  updateThumb(i) {
    const page = this.pages[i];
    if (page && page.canvas && page._thumbCanvas) {
      const tc = page._thumbCanvas; tc.height = Math.round(tc.width * (page.h / page.w));
      tc.getContext("2d").drawImage(page.canvas, 0, 0, tc.width, tc.height);
    }
  }

  /* ── export ─────────────────────────────────────────────────────────── */
  download(blob, name) { const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
  async exportPng() { const page = this.pages[this.current]; if (!page) return; await this.doRefresh(page); this.download(await canvasBlob(page.canvas), `page-${this.current + 1}.png`); this.toast("PNG downloaded", "success"); }
  async exportPdf() {
    this.setLoading("Building HD PDF…");
    try {
      const fd = new FormData();
      for (let i = 0; i < this.pages.length; i++) {
        this.setProgress(i / this.pages.length);
        const page = this.pages[i];
        let blob;
        if (page.loaded) { if (page.removals.length) await this.doRefresh(page); blob = await canvasBlob(page.canvas); }
        else blob = await (await fetch(page.src)).blob();
        fd.append("files", blob, `p${i}.png`);
      }
      const res = await fetch(this.api + "/api/export", { method: "POST", body: fd });
      if (!res.ok) throw new Error("export failed");
      this.download(await res.blob(), "bol-edited.pdf");
      this.hideLoader(); this.toast("PDF exported", "success");
    } catch (e) { console.error(e); this.hideLoader(); this.toast("Export failed", "error"); }
  }

  /* ── tool + control setters (called by React) ───────────────────────── */
  setTool(tool) { this.tool = tool; const page = this.pages[this.current]; if (page?._wrap) page._wrap.className = "canvas-wrap tool-" + tool; if (page?._brushCursor) page._brushCursor.hidden = true; this.emit(); }
  setFillMode(mode) { this.fillMode = mode; this.emit(); }
  setFixedColor(hex) { this.fixedColor = hex; if (this.fillMode === "auto") this.fillMode = "fixed"; this.emit(); }
  setBrushColor(hex) { this.brushColor = hex; const c = this.pages[this.current]?._brushCursor; if (c) c.style.borderColor = hex; this.emit(); }
  setBrushSize(n) {
    this.brushSize = +n;
    const page = this.pages[this.current], c = page?._brushCursor;
    if (c && !c.hidden) { const d = this.brushSize * ((page.canvas.clientWidth || page.canvas.width) / page.canvas.width); c.style.width = c.style.height = d + "px"; }
    this.emit();
  }
  setBrushOpacity(o) { this.brushOpacity = Math.max(0.05, Math.min(1, +o)); this.emit(); }
  applyPicked(hex, target) { if (target === "fill") this.setFixedColor(hex); else this.setBrushColor(hex); this.toast("Picked " + hex.toUpperCase()); }
  async startPick(target = "brush") {
    if (window.EyeDropper) {                              // native screen eyedropper (Chrome/Edge)
      try { const r = await new window.EyeDropper().open(); if (r && r.sRGBHex) this.applyPicked(r.sRGBHex, target); }
      catch (e) { /* user cancelled */ }
      return;
    }
    this.pickMode = target;                               // fallback: click the canvas to sample
    const wrap = this.pages[this.current]?._wrap; if (wrap) wrap.classList.add("pick");
    this.toast("Click the document to pick a color"); this.emit();
  }
  setBrushStyle(style) {
    this.brushStyle = style;
    this.brushOpacity = style === "highlighter" ? 0.4 : style === "marker" ? 0.85 : 1;  // sensible default per style
    this.emit();
  }
  toggleOverlays(on) { this.showOverlays = on; this.pages[this.current]?._overlay?.classList.toggle("hidden", !on); this.emit(); }
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
