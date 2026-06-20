/* ============================================================================
 * BOL Studio — Scan & Redact (frontend, minimal + seamless removal)
 *
 * Tools: Erase (click a number), Cover (drag a box), Brush.
 * Number/area removal is done by SERVER-SIDE INPAINTING — the spot is rebuilt
 * from surrounding pixels so nothing is left behind. Layers per page:
 *   cleanCanvas  → original page image (no removals)
 *   baseCanvas   → clean + removals inpainted (regenerated on change)
 *   annoCanvas   → brush strokes
 *   canvas       → composite (base + anno), shown on screen
 * ========================================================================== */
(() => {
  "use strict";

  const API = window.BOL_API || "";
  const G = window.gsap || { from() {}, to() {}, set() {}, fromTo() {} };
  let navSeq = 0, removalSeq = 1;

  const state = {
    session: null, ocrAvailable: false,
    pages: [], current: -1,
    tool: "erase",                 // erase | cover | brush
    brushColor: "#e23744", brushSize: 8,
    fillMode: "auto", fixedColor: "#ffffff",
    showOverlays: true, zoom: 1,
    undo: [], redo: [],
  };

  const $ = (id) => document.getElementById(id);
  const el = {
    fileInput: $("file-input"), dropzone: $("dropzone"), stage: $("stage"), host: $("canvas-host"),
    loader: $("loader"), loaderText: $("loader-text"), progressBar: $("progress-bar"),
    rail: $("rail"), btnUndo: $("btn-undo"), btnRedo: $("btn-redo"), btnReset: $("btn-reset"),
    btnPng: $("btn-png"), btnPdf: $("btn-pdf"),
    panelFill: $("panel-fill"), panelBrush: $("panel-brush"),
    scanModes: $("scan-modes"), btnAutofix: $("btn-autofix"),
    paintColor: $("paint-color"), slSize: $("sl-size"),
    fillMode: $("fill-mode"), fillColor: $("fill-color"), colorRow: $("color-row"), colorHex: $("color-hex"),
    toggleOverlays: $("toggle-overlays"), countPill: $("count-pill"), btnEraseAll: $("btn-erase-all"),
    pagePanel: $("page-panel"), thumbs: $("thumbs"),
    statusMsg: $("status-msg"), statusPage: $("status-page"), toasts: $("toasts"),
  };

  /* ───────────────────────────── helpers ───────────────────────────── */
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const hexToRgb = (h) => { const m = h.replace("#", ""); return [parseInt(m.slice(0, 2), 16), parseInt(m.slice(2, 4), 16), parseInt(m.slice(4, 6), 16)]; };
  const newCanvas = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
  const cloneCanvas = (c) => { const n = newCanvas(c.width, c.height); n.getContext("2d").drawImage(c, 0, 0); return n; };
  const ctx2d = (c) => c.getContext("2d", { willReadFrequently: true });
  const loadImage = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
  const canvasBlob = (c) => new Promise((res) => c.toBlob(res, "image/png"));
  const setStatus = (m) => (el.statusMsg.textContent = m);

  function toast(msg, kind = "") {
    const t = document.createElement("div");
    t.className = "toast " + kind;
    t.innerHTML = `<span class="dot"></span><span>${msg}</span>`;
    el.toasts.appendChild(t);
    G.fromTo(t, { y: 14, opacity: 0 }, { y: 0, opacity: 1, duration: 0.35, ease: "back.out(1.7)" });
    setTimeout(() => G.to(t, { y: 10, opacity: 0, duration: 0.3, onComplete: () => t.remove() }), 2600);
  }

  let loaderTimer = null;
  function showLoader(text) {
    el.loaderText.textContent = text; el.progressBar.style.width = "0%"; el.loader.hidden = false;
    clearTimeout(loaderTimer);
    loaderTimer = setTimeout(() => { el.loader.hidden = true; toast("That took too long — please retry.", "error"); }, 30000);
  }
  const setProgress = (f) => (el.progressBar.style.width = Math.round(f * 100) + "%");
  const hideLoader = () => { clearTimeout(loaderTimer); el.loader.hidden = true; };

  /* ───────────────────────────── load + analyze ───────────────────────────── */
  async function loadPdf(file) {
    try {
      showLoader("Uploading & analyzing…");
      const fd = new FormData(); fd.append("file", file);
      const res = await fetch(API + "/api/analyze", { method: "POST", body: fd });
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.detail || `Server error ${res.status}`); }
      const json = await res.json();

      state.session = json.session; state.ocrAvailable = json.ocrAvailable;
      state.current = -1; state.undo = []; state.redo = [];
      state.pages = json.pages.map((p) => ({
        w: p.width, h: p.height, scanned: p.scanned, index: p.index, mode: "original",
        boxes: p.boxes.map((b) => ({ ...b, erased: false })),
        boxes0: p.boxes.map((b) => ({ ...b, erased: false })),
        removals: [],
        src: `${API}/api/page/${json.session}/${p.index}`,
        thumbSrc: `${API}/api/thumb/${json.session}/${p.index}`,
        loaded: false,
      }));

      buildThumbs();
      el.dropzone.style.display = "none";
      el.host.hidden = false; el.pagePanel.hidden = false;
      [el.btnPng, el.btnPdf, el.btnAutofix].forEach((b) => (b.disabled = false));
      setProgress(1);
      await showPage(0);
      hideLoader();
      G.from(".canvas-wrap", { y: 22, opacity: 0, duration: 0.45, ease: "power3.out" });

      const total = state.pages.length, nums = state.pages.reduce((n, p) => n + p.boxes.length, 0);
      toast(`Loaded ${total} page${total > 1 ? "s" : ""} · ${nums} numbers found`, "success");
    } catch (err) {
      console.error(err); hideLoader(); toast("Could not analyze that file", "error"); setStatus("Failed — " + (err.message || err));
    }
  }

  /* ───────────────────────────── layered page model ───────────────────────────── */
  function composite(page) {
    page.ctx.clearRect(0, 0, page.w, page.h);
    page.ctx.drawImage(page.baseCanvas, 0, 0);
    page.ctx.drawImage(page.annoCanvas, 0, 0);
  }
  function buildLayers(page, img) {
    page.w = img.naturalWidth; page.h = img.naturalHeight;
    page.cleanCanvas = newCanvas(page.w, page.h); page.cleanCtx = ctx2d(page.cleanCanvas); page.cleanCtx.drawImage(img, 0, 0);
    page.baseCanvas = newCanvas(page.w, page.h); page.baseCtx = ctx2d(page.baseCanvas); page.baseCtx.drawImage(img, 0, 0);
    page.annoCanvas = newCanvas(page.w, page.h); page.annoCtx = ctx2d(page.annoCanvas);
    page.canvas = newCanvas(page.w, page.h); page.ctx = ctx2d(page.canvas);
    composite(page);
  }
  async function ensurePageLoaded(page) {
    if (page.loaded) return;
    buildLayers(page, await loadImage(page.src));
    page.loaded = true;
  }

  async function showPage(index) {
    if (index < 0 || index >= state.pages.length) return;
    const myNav = ++navSeq;
    const page = state.pages[index];
    if (!page.loaded) {
      showLoader("Loading page…");
      try { await ensurePageLoaded(page); }
      catch (e) { if (myNav === navSeq) { hideLoader(); toast("Couldn’t load page — re-upload.", "error"); } return; }
    }
    if (myNav !== navSeq) return;
    hideLoader();
    state.current = index;
    mountPage(page);
    syncScanUI(page);
    el.statusPage.textContent = `Page ${index + 1} / ${state.pages.length}`;
    el.btnReset.disabled = false; el.btnEraseAll.disabled = false;
    refreshHistoryButtons();
    setStatus(page.scanned ? (state.ocrAvailable ? "Scanned — numbers found via OCR." : "Scanned — use Cover or Brush.") : "Click a number to erase it.");
  }

  function mountPage(page) {
    el.host.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.className = "canvas-wrap tool-" + state.tool;
    wrap.appendChild(page.canvas);
    const overlay = document.createElement("div");
    overlay.className = "overlay-layer" + (state.showOverlays ? "" : " hidden");
    wrap.appendChild(overlay);
    page._overlay = overlay; page._wrap = wrap;
    el.host.appendChild(wrap);
    layoutCanvas(page);
    attachCanvasTools(page);
    renderOverlays(page);
    updateThumbActive();
  }

  function layoutCanvas(page) {
    const fit = Math.min((el.stage.clientWidth - 64) / page.w, (el.stage.clientHeight - 64) / page.h, 1);
    const dispW = page.w * fit * state.zoom;
    page.canvas.style.width = dispW + "px";
    page.canvas.style.height = dispW * (page.h / page.w) + "px";
  }

  function renderOverlays(page) {
    const overlay = page._overlay; if (!overlay) return;
    overlay.innerHTML = ""; let count = 0;
    for (const box of page.boxes) {
      if (box.erased) continue; count++;
      const d = document.createElement("div");
      d.className = "num-box" + (box.kind === "mixed" ? " mixed" : "");
      d.style.left = (box.x / page.w) * 100 + "%"; d.style.top = (box.y / page.h) * 100 + "%";
      d.style.width = (box.w / page.w) * 100 + "%"; d.style.height = (box.h / page.h) * 100 + "%";
      d.title = box.text;
      d.addEventListener("click", (e) => { e.stopPropagation(); if (state.tool === "erase") eraseBox(page, box, d); });
      overlay.appendChild(d);
    }
    el.countPill.textContent = count;
    G.fromTo(overlay.children, { opacity: 0, scale: 0.85 }, { opacity: 1, scale: 1, duration: 0.3, stagger: 0.004, ease: "power2.out" });
  }

  const updateThumbActive = () => [...el.thumbs.children].forEach((t, i) => t.classList.toggle("active", i === state.current));

  /* ───────────────────────────── removals → inpaint ───────────────────────────── */
  function sampleBackground(ctx, x, y, w, h) {
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

  // Instant preview: cover the spot on the base so it disappears immediately,
  // then the server inpaint result (seamless) replaces it.
  function previewFill(page, rect) {
    const color = state.fillMode === "fixed" ? hexToRgb(state.fixedColor) : sampleBackground(page.ctx, rect.x, rect.y, rect.w, rect.h);
    page.baseCtx.fillStyle = `rgb(${color[0]},${color[1]},${color[2]})`;
    page.baseCtx.fillRect(rect.x, rect.y, rect.w, rect.h);
    composite(page);
  }

  function addRemoval(page, rect, { boxId = null, record = true } = {}) {
    const x = clamp(Math.floor(rect.x), 0, page.w), y = clamp(Math.floor(rect.y), 0, page.h);
    const w = clamp(Math.ceil(rect.w), 1, page.w - x), h = clamp(Math.ceil(rect.h), 1, page.h - y);
    const rm = { id: removalSeq++, x, y, w, h, boxId };
    page.removals.push(rm);
    previewFill(page, rm);
    scheduleRefresh(page);
    if (record) {
      state.undo.push({ type: "removal", page: state.pages.indexOf(page), removal: rm });
      state.redo = []; refreshHistoryButtons();
    }
  }

  function scheduleRefresh(page) {
    clearTimeout(page._rtimer);
    page._rtimer = setTimeout(() => doRefresh(page), 220);
  }

  async function doRefresh(page) {
    const myseq = (page._rseq = (page._rseq || 0) + 1);
    const idx = state.pages.indexOf(page);
    if (!page.removals.length) {
      page.baseCtx.clearRect(0, 0, page.w, page.h); page.baseCtx.drawImage(page.cleanCanvas, 0, 0);
      composite(page); updateThumb(idx); return;
    }
    try {
      const fd = new FormData();
      fd.append("file", await canvasBlob(page.cleanCanvas), "clean.png");
      fd.append("rects", JSON.stringify(page.removals.map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h }))));
      const res = await fetch(API + "/api/inpaint", { method: "POST", body: fd });
      if (!res.ok) throw new Error("inpaint");
      const img = await loadImage(URL.createObjectURL(await res.blob()));
      if (myseq !== page._rseq) return;             // a newer change superseded this
      page.baseCtx.clearRect(0, 0, page.w, page.h); page.baseCtx.drawImage(img, 0, 0);
      composite(page); updateThumb(idx);
    } catch (e) { console.error(e); /* keep the flat preview if the server is unreachable */ }
  }

  function eraseBox(page, box, domEl) {
    box.erased = true;
    addRemoval(page, box, { boxId: box.id });
    if (domEl) G.to(domEl, { scale: 1.25, opacity: 0, duration: 0.28, ease: "power2.out", onComplete: () => domEl.remove() });
    el.countPill.textContent = page.boxes.filter((b) => !b.erased).length;
  }

  function eraseAll(page) {
    const pending = page.boxes.filter((b) => !b.erased);
    if (!pending.length) return toast("No numbers left to erase");
    pending.forEach((b) => { b.erased = true; addRemoval(page, b, { boxId: b.id }); });
    renderOverlays(page);
    toast(`Erased ${pending.length} number${pending.length > 1 ? "s" : ""}`, "success");
  }

  /* ───────────────────────────── brush (anno layer) ───────────────────────────── */
  function pushAnno(pageIndex, rect, before, after) {
    state.undo.push({ type: "anno", page: pageIndex, rect, before, after });
    state.redo = []; refreshHistoryButtons(); updateThumb(pageIndex);
  }
  function commitStroke(page, snap, bbox) {
    if (!bbox) return;
    const m = state.brushSize + 4;
    const x = clamp(Math.floor(bbox.x0 - m), 0, page.w), y = clamp(Math.floor(bbox.y0 - m), 0, page.h);
    const w = clamp(Math.ceil(bbox.x1 - bbox.x0 + m * 2), 1, page.w - x), h = clamp(Math.ceil(bbox.y1 - bbox.y0 + m * 2), 1, page.h - y);
    pushAnno(state.current, { x, y, w, h }, snap.getContext("2d").getImageData(x, y, w, h), page.annoCtx.getImageData(x, y, w, h));
  }

  /* ───────────────────────────── undo / redo / reset ───────────────────────────── */
  function snapshotFull(page) {
    return { clean: cloneCanvas(page.cleanCanvas), anno: cloneCanvas(page.annoCanvas),
             removals: page.removals.map((r) => ({ ...r })), boxes: page.boxes.map((b) => ({ ...b })),
             w: page.w, h: page.h, mode: page.mode };
  }
  function restoreFull(page, snap) {
    page.w = snap.w; page.h = snap.h; page.mode = snap.mode;
    page.cleanCanvas = cloneCanvas(snap.clean); page.cleanCtx = ctx2d(page.cleanCanvas);
    page.annoCanvas = cloneCanvas(snap.anno); page.annoCtx = ctx2d(page.annoCanvas);
    page.baseCanvas = cloneCanvas(snap.clean); page.baseCtx = ctx2d(page.baseCanvas);  // base re-derived
    page.canvas = newCanvas(page.w, page.h); page.ctx = ctx2d(page.canvas);
    page.removals = snap.removals.map((r) => ({ ...r })); page.boxes = snap.boxes.map((b) => ({ ...b }));
    composite(page); scheduleRefresh(page);
  }
  function pushFull(pageIndex, before, after) {
    state.undo.push({ type: "full", page: pageIndex, before, after });
    state.redo = []; refreshHistoryButtons(); updateThumb(pageIndex);
  }

  function applyHistory(entry, useBefore) {
    const page = state.pages[entry.page];
    if (entry.type === "removal") {
      const rm = entry.removal;
      if (useBefore) { page.removals = page.removals.filter((r) => r.id !== rm.id); if (rm.boxId != null) { const b = page.boxes.find((x) => x.id === rm.boxId); if (b) b.erased = false; } }
      else { page.removals.push(rm); if (rm.boxId != null) { const b = page.boxes.find((x) => x.id === rm.boxId); if (b) b.erased = true; } }
      scheduleRefresh(page);
      if (entry.page === state.current) renderOverlays(page);
    } else if (entry.type === "anno") {
      page.annoCtx.putImageData(useBefore ? entry.before : entry.after, entry.rect.x, entry.rect.y);
      composite(page); updateThumb(entry.page);
    } else { // full
      restoreFull(page, useBefore ? entry.before : entry.after);
      if (entry.page === state.current) { mountPage(page); syncScanUI(page); } else updateThumb(entry.page);
    }
  }

  async function undo() { const e = state.undo.pop(); if (!e) return; if (e.page !== state.current) await showPage(e.page); applyHistory(e, true); state.redo.push(e); refreshHistoryButtons(); }
  async function redo() { const e = state.redo.pop(); if (!e) return; if (e.page !== state.current) await showPage(e.page); applyHistory(e, false); state.undo.push(e); refreshHistoryButtons(); }

  async function resetPage() {
    const page = state.pages[state.current];
    showLoader("Resetting…");
    try {
      buildLayers(page, await loadImage(page.src));
      page.boxes = page.boxes0.map((b) => ({ ...b })); page.removals = []; page.mode = "original";
      state.undo = state.undo.filter((e) => e.page !== state.current);
      state.redo = state.redo.filter((e) => e.page !== state.current);
      mountPage(page); syncScanUI(page); refreshHistoryButtons();
      hideLoader(); toast("Page reset");
    } catch (e) { hideLoader(); toast("Reset failed", "error"); }
  }

  function refreshHistoryButtons() { el.btnUndo.disabled = !state.undo.length; el.btnRedo.disabled = !state.redo.length; }

  /* ───────────────────────────── enhance ───────────────────────────── */
  async function applyEnhance({ deskew = false, autocrop = false }) {
    const page = state.pages[state.current];
    const before = snapshotFull(page);
    showLoader(deskew || autocrop ? "Straightening & cropping…" : "Enhancing…");
    try {
      const res = await fetch(API + "/api/enhance", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session: state.session, page: page.index, mode: page.mode, deskew, autocrop }),
      });
      if (!res.ok) throw new Error("enhance failed");
      const img = await loadImage(URL.createObjectURL(await res.blob()));
      const dimsChanged = img.naturalWidth !== page.w || img.naturalHeight !== page.h;
      if (dimsChanged) {
        const removals = [];                          // geometry changed → detections/removals stale
        buildLayers(page, img); page.removals = removals; page.boxes = [];
      } else {
        page.cleanCtx.clearRect(0, 0, page.w, page.h); page.cleanCtx.drawImage(img, 0, 0);
        page.baseCtx.clearRect(0, 0, page.w, page.h); page.baseCtx.drawImage(img, 0, 0);
        composite(page); scheduleRefresh(page);       // re-apply existing removals on the new look
      }
      pushFull(state.current, before, snapshotFull(page));
      if (dimsChanged) mountPage(page);
      hideLoader();
      if (deskew || autocrop) toast("Straightened & cropped", "success");
    } catch (e) { console.error(e); hideLoader(); toast("Enhance failed", "error"); }
  }

  function syncScanUI(page) {
    [...el.scanModes.children].forEach((b) => b.classList.toggle("active", b.dataset.mode === page.mode));
  }

  /* ───────────────────────────── pointer tools ───────────────────────────── */
  function canvasPoint(canvas, e) {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) * (canvas.width / r.width), y: (e.clientY - r.top) * (canvas.height / r.height) };
  }

  function attachCanvasTools(page) {
    const canvas = page.canvas, wrap = page._wrap;
    let drag = null, snap = null, marquee = null, bbox = null;
    const expand = (p) => { if (!bbox) bbox = { x0: p.x, y0: p.y, x1: p.x, y1: p.y }; bbox.x0 = Math.min(bbox.x0, p.x); bbox.y0 = Math.min(bbox.y0, p.y); bbox.x1 = Math.max(bbox.x1, p.x); bbox.y1 = Math.max(bbox.y1, p.y); };

    canvas.addEventListener("pointerdown", (e) => {
      const p = canvasPoint(canvas, e);
      if (state.tool === "brush") {
        canvas.setPointerCapture(e.pointerId);
        drag = p; bbox = null; expand(p); snap = cloneCanvas(page.annoCanvas);
        page.annoCtx.strokeStyle = state.brushColor; page.annoCtx.lineWidth = state.brushSize;
        page.annoCtx.lineCap = "round"; page.annoCtx.lineJoin = "round";
        page.annoCtx.beginPath(); page.annoCtx.moveTo(p.x, p.y);
      } else if (state.tool === "cover") {
        canvas.setPointerCapture(e.pointerId);
        drag = p; marquee = document.createElement("div"); marquee.className = "marquee"; wrap.appendChild(marquee);
      }
    });

    canvas.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const p = canvasPoint(canvas, e);
      if (state.tool === "brush") {
        expand(p); page.annoCtx.lineTo(p.x, p.y); page.annoCtx.stroke(); composite(page);
      } else if (marquee) {
        const x = Math.min(drag.x, p.x), y = Math.min(drag.y, p.y), w = Math.abs(p.x - drag.x), h = Math.abs(p.y - drag.y);
        marquee.style.left = (x / page.w) * 100 + "%"; marquee.style.top = (y / page.h) * 100 + "%";
        marquee.style.width = (w / page.w) * 100 + "%"; marquee.style.height = (h / page.h) * 100 + "%";
      }
    });

    canvas.addEventListener("pointerup", (e) => {
      if (!drag) return;
      const p = canvasPoint(canvas, e);
      const start = drag; drag = null;
      if (marquee) { marquee.remove(); marquee = null; }
      if (state.tool === "cover") {
        const rect = { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) };
        if (rect.w > 3 && rect.h > 3) { addRemoval(page, rect, {}); toast("Removed", "success"); }
      } else if (state.tool === "brush") {
        commitStroke(page, snap, bbox); snap = null;
      }
    });
  }

  /* ───────────────────────────── thumbnails ───────────────────────────── */
  function buildThumbs() {
    el.thumbs.innerHTML = "";
    state.pages.forEach((page, i) => {
      const t = document.createElement("div"); t.className = "thumb";
      const tc = newCanvas(180, Math.round(180 * (page.h / page.w)));
      loadImage(page.thumbSrc).then((img) => tc.getContext("2d").drawImage(img, 0, 0, tc.width, tc.height)).catch(() => {});
      const label = document.createElement("span"); label.className = "thumb-num"; label.textContent = i + 1;
      t.append(tc, label);
      t.addEventListener("click", () => showPage(i));
      page._thumbCanvas = tc;
      el.thumbs.appendChild(t);
    });
    updateThumbActive();
  }
  function updateThumb(i) {
    const page = state.pages[i];
    if (page && page.canvas && page._thumbCanvas) {
      const tc = page._thumbCanvas;
      tc.height = Math.round(tc.width * (page.h / page.w));
      tc.getContext("2d").drawImage(page.canvas, 0, 0, tc.width, tc.height);
    }
  }

  /* ───────────────────────────── export ───────────────────────────── */
  const download = (blob, name) => { const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); };

  function exportPng() {
    const page = state.pages[state.current];
    doRefresh(page).then(() => canvasBlob(page.canvas)).then((b) => { download(b, `page-${state.current + 1}.png`); toast("PNG downloaded", "success"); });
  }
  async function exportPdf() {
    showLoader("Building HD PDF…");
    try {
      const fd = new FormData();
      for (let i = 0; i < state.pages.length; i++) {
        setProgress(i / state.pages.length);
        const page = state.pages[i];
        let blob;
        if (page.loaded) { if (page.removals.length) await doRefresh(page); blob = await canvasBlob(page.canvas); }
        else blob = await (await fetch(page.src)).blob();
        fd.append("files", blob, `p${i}.png`);
      }
      const res = await fetch(API + "/api/export", { method: "POST", body: fd });
      if (!res.ok) throw new Error("export failed");
      download(await res.blob(), "bol-edited.pdf");
      hideLoader(); toast("PDF exported", "success");
    } catch (e) { console.error(e); hideLoader(); toast("Export failed", "error"); }
  }

  /* ───────────────────────────── tool + control wiring ───────────────────────────── */
  function setTool(tool) {
    state.tool = tool;
    [...el.rail.querySelectorAll(".tool[data-tool]")].forEach((b) => b.classList.toggle("active", b.dataset.tool === tool));
    el.panelFill.hidden = tool === "brush";
    el.panelBrush.hidden = tool !== "brush";
    const wrap = state.pages[state.current]?._wrap; if (wrap) wrap.className = "canvas-wrap tool-" + tool;
  }
  function setFillMode(mode) {
    state.fillMode = mode;
    [...el.fillMode.children].forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
    el.colorRow.classList.toggle("disabled", mode === "auto");
    el.colorHex.textContent = mode === "auto" ? "Reconstructed from background" : el.fillColor.value.toUpperCase();
  }

  const openFile = () => el.fileInput.click();
  el.fileInput.addEventListener("change", (e) => { const f = e.target.files[0]; if (f) loadPdf(f); e.target.value = ""; });
  $("btn-open").addEventListener("click", openFile);
  $("dz-browse").addEventListener("click", openFile);

  ["dragenter", "dragover"].forEach((ev) => el.stage.addEventListener(ev, (e) => { e.preventDefault(); el.stage.classList.add("dragover"); }));
  ["dragleave", "drop"].forEach((ev) => el.stage.addEventListener(ev, (e) => { e.preventDefault(); el.stage.classList.remove("dragover"); }));
  el.stage.addEventListener("drop", (e) => {
    const f = [...e.dataTransfer.files].find((x) => x.type === "application/pdf" || x.type.startsWith("image/") || /\.(pdf|png|jpe?g|webp)$/i.test(x.name));
    if (f) loadPdf(f); else toast("Drop a PDF or image", "error");
  });

  el.rail.querySelectorAll(".tool[data-tool]").forEach((b) => b.addEventListener("click", () => setTool(b.dataset.tool)));
  el.btnUndo.addEventListener("click", undo); el.btnRedo.addEventListener("click", redo); el.btnReset.addEventListener("click", resetPage);
  el.btnEraseAll.addEventListener("click", () => eraseAll(state.pages[state.current]));

  el.scanModes.querySelectorAll(".chip").forEach((b) => b.addEventListener("click", () => {
    const page = state.pages[state.current]; if (!page) return;
    page.mode = b.dataset.mode; syncScanUI(page); applyEnhance({});
  }));
  el.btnAutofix.addEventListener("click", () => applyEnhance({ deskew: true, autocrop: true }));

  el.paintColor.addEventListener("input", (e) => (state.brushColor = e.target.value));
  el.slSize.addEventListener("input", (e) => (state.brushSize = +e.target.value));

  el.fillMode.querySelectorAll(".seg-btn").forEach((b) => b.addEventListener("click", () => setFillMode(b.dataset.mode)));
  el.fillColor.addEventListener("input", (e) => { state.fixedColor = e.target.value; el.colorHex.textContent = e.target.value.toUpperCase(); if (state.fillMode === "auto") setFillMode("fixed"); });

  el.toggleOverlays.addEventListener("change", (e) => { state.showOverlays = e.target.checked; state.pages[state.current]?._overlay?.classList.toggle("hidden", !state.showOverlays); });
  el.btnPng.addEventListener("click", exportPng); el.btnPdf.addEventListener("click", exportPdf);

  $("zoom-in").addEventListener("click", () => { state.zoom = clamp(state.zoom * 1.2, 0.2, 5); layoutCanvas(state.pages[state.current]); });
  $("zoom-out").addEventListener("click", () => { state.zoom = clamp(state.zoom / 1.2, 0.2, 5); layoutCanvas(state.pages[state.current]); });
  $("zoom-fit").addEventListener("click", () => { state.zoom = 1; layoutCanvas(state.pages[state.current]); });

  window.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" && e.target.type !== "range") return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    const map = { e: "erase", c: "cover", b: "brush" };
    if (map[e.key]) setTool(map[e.key]);
  });

  let rT;
  window.addEventListener("resize", () => { clearTimeout(rT); rT = setTimeout(() => { if (state.current >= 0) layoutCanvas(state.pages[state.current]); }, 120); });
  window.addEventListener("error", (e) => { hideLoader(); console.error("Uncaught:", e.error || e.message); });
  window.addEventListener("unhandledrejection", (e) => { hideLoader(); console.error("Unhandled:", e.reason); });

  setStatus("Ready — open a PDF or image to begin.");
})();
