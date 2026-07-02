import { useEffect, useRef, useState, useCallback } from "react";
import Editor from "./engine/Editor.js";
import BrushPanel from "./BrushPanel.jsx";

/* ── tiny inline icon set ─────────────────────────────────────────────── */
const I = {
  logo: <path d="M4 20h16M14.5 4.5l5 5L8 21l-5 1 1-5z" />,
  open: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></>,
  download: <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m7 10 5 5 5-5" /><path d="M12 15V3" /></>,
  erase: <><path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21" /><path d="M22 21H7" /><path d="m5 11 9 9" /></>,
  cover: <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M9 21V9" opacity=".5" /></>,
  brush: <><path d="M9.06 11.9 1.86 19.1a2 2 0 1 0 2.83 2.83l7.2-7.2" /><path d="M14 6a3.5 3.5 0 0 1 4 0 3.5 3.5 0 0 1 0 4l-6.5 6.5-4-4z" opacity=".8" /><path d="m17 3 4 4" /></>,
  undo: <><path d="M3 7v6h6" /><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13" /></>,
  redo: <><path d="M21 7v6h-6" /><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13" /></>,
  reset: <><path d="M3 2v6h6" /><path d="M3 13a9 9 0 1 0 3-7.7L3 8" /></>,
  autofix: <><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2" /><path d="m9 12 2 2 4-4" /></>,
  upload: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /><path d="M12 18v-6" /><path d="m9 15 3-3 3 3" /></>,
};
const Svg = ({ d, s = 20 }) => (
  <svg viewBox="0 0 24 24" width={s} height={s} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{d}</svg>
);

const TOOLS = [{ id: "erase", label: "Erase", icon: I.erase }, { id: "cover", label: "Cover", icon: I.cover }, { id: "brush", label: "Brush", icon: I.brush }];

export default function App() {
  const stageRef = useRef(null);
  const hostRef = useRef(null);
  const thumbsRef = useRef(null);
  const fileRef = useRef(null);
  const engineRef = useRef(null);

  const [s, setS] = useState(() => ({ hasDoc: false, loading: false, loadingText: "", progress: 0, tool: "erase", fillMode: "auto", fixedColor: "#ffffff", brushColor: "#e23744", brushSize: 8, showOverlays: true, current: -1, pageCount: 0, count: 0, mode: "original", scanned: false, ocrAvailable: false, canUndo: false, canRedo: false, status: "Ready — open a PDF or image to begin." }));
  const [toasts, setToasts] = useState([]);
  const [drag, setDrag] = useState(false);

  const pushToast = useCallback((msg, kind = "") => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t, { id, msg, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2600);
  }, []);

  useEffect(() => {
    const eng = new Editor({ onState: setS, onToast: pushToast });
    eng.mount({ stageEl: stageRef.current, hostEl: hostRef.current, thumbsEl: thumbsRef.current });
    engineRef.current = eng;

    const onKey = (e) => {
      if (e.target.tagName === "INPUT" && e.target.type !== "range") return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? eng.redo() : eng.undo(); return; }
      if (e.key === "+" || e.key === "=") { eng.zoomBy(1.2); return; }
      if (e.key === "-" || e.key === "_") { eng.zoomBy(1 / 1.2); return; }
      if (e.key === "0") { eng.zoomFit(); return; }
      const map = { e: "erase", c: "cover", b: "brush" };
      if (map[e.key]) eng.setTool(map[e.key]);
    };
    window.addEventListener("keydown", onKey);

    // Ctrl/⌘ + wheel (and trackpad pinch) → zoom at the cursor.
    const stage = stageRef.current;
    const onWheel = (e) => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); eng.zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX, e.clientY); } };
    stage.addEventListener("wheel", onWheel, { passive: false });

    return () => { window.removeEventListener("keydown", onKey); stage.removeEventListener("wheel", onWheel); eng.destroy(); };
  }, [pushToast]);

  const eng = () => engineRef.current;
  const openFile = () => fileRef.current.click();
  const onPick = (e) => { const f = e.target.files[0]; if (f) eng().open(f); e.target.value = ""; };
  const onDrop = (e) => {
    e.preventDefault(); setDrag(false);
    const f = [...e.dataTransfer.files].find((x) => x.type === "application/pdf" || x.type.startsWith("image/") || /\.(pdf|png|jpe?g|webp)$/i.test(x.name));
    if (f) eng().open(f); else pushToast("Drop a PDF or image", "error");
  };

  return (
    <div className="app">
      {/* Top bar */}
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark"><Svg d={I.logo} s={19} /></div>
          <div className="brand-text"><h1>BOL&nbsp;Studio</h1><span>Scan &amp; Redact</span></div>
        </div>
        <div className="topbar-actions">
          <button className="btn btn-ghost" onClick={openFile}><Svg d={I.open} s={16} />Open</button>
          <div className="divider-v" />
          <button className="btn btn-ghost" disabled={!s.hasDoc} onClick={() => eng().exportPng()}>PNG</button>
          <button className="btn btn-primary" disabled={!s.hasDoc} onClick={() => eng().exportPdf()}><Svg d={I.download} s={16} />Export PDF</button>
        </div>
      </header>

      <div className="body">
        {/* Tool rail */}
        <nav className="rail">
          {TOOLS.map((t) => (
            <button key={t.id} className={"tool" + (s.tool === t.id ? " active" : "")} title={t.label} onClick={() => eng().setTool(t.id)}>
              <Svg d={t.icon} /><span>{t.label}</span>
            </button>
          ))}
          <div className="rail-sep" />
          <button className="tool" disabled={!s.canUndo} onClick={() => eng().undo()}><Svg d={I.undo} /><span>Undo</span></button>
          <button className="tool" disabled={!s.canRedo} onClick={() => eng().redo()}><Svg d={I.redo} /><span>Redo</span></button>
          <button className="tool" disabled={!s.hasDoc} onClick={() => eng().resetPage()}><Svg d={I.reset} /><span>Reset</span></button>
        </nav>

        {/* Stage */}
        <main
          className={"stage" + (drag ? " dragover" : "")}
          ref={stageRef}
          onDragEnter={(e) => { e.preventDefault(); setDrag(true); }}
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
          onDragLeave={(e) => { e.preventDefault(); setDrag(false); }}
          onDrop={onDrop}
        >
          {!s.hasDoc && (
            <div className="dropzone">
              <div className="dz-inner">
                <div className="dz-icon"><Svg d={I.upload} s={32} /></div>
                <h2>Drop a PDF or image</h2>
                <p>Numbers are detected automatically — click to erase them, seamlessly rebuilt from the background.</p>
                <button className="btn btn-primary lg" onClick={openFile}>Choose a file</button>
                <span className="dz-hint">PDF · JPG · PNG — runs locally on your machine</span>
              </div>
            </div>
          )}
          <div className="canvas-host" ref={hostRef} hidden={!s.hasDoc} />
          {s.hasDoc && (
            <div className="zoombar">
              <button onClick={() => eng().zoomBy(1 / 1.2)} title="Zoom out (−)">−</button>
              <button className="zoomlvl" onClick={() => eng().zoomFit()} title="Fit (0)">{Math.round((s.zoom || 1) * 100)}%</button>
              <button onClick={() => eng().zoomBy(1.2)} title="Zoom in (+)">+</button>
            </div>
          )}
          {s.loading && (
            <div className="loader">
              <div className="loader-card">
                <div className="spinner" />
                <div className="loader-text">{s.loadingText}</div>
                <div className="progress"><div className="progress-bar" style={{ width: Math.round(s.progress * 100) + "%" }} /></div>
              </div>
            </div>
          )}
        </main>

        {/* Inspector */}
        <aside className="inspector">
          {s.tool !== "brush" ? (
            <section className="panel">
              <div className="panel-head">Fill color</div>
              <div className="seg">
                <button className={"seg-btn" + (s.fillMode === "auto" ? " active" : "")} onClick={() => eng().setFillMode("auto")}>Auto background</button>
                <button className={"seg-btn" + (s.fillMode === "fixed" ? " active" : "")} onClick={() => eng().setFillMode("fixed")}>Fixed</button>
              </div>
              <div className="color-row">
                <input type="color" value={s.fixedColor} onChange={(e) => eng().setFixedColor(e.target.value)} title="Cover color" />
                <div className="color-meta">
                  <span className="color-label">Cover color</span>
                  <span className="color-hex">{s.fillMode === "auto" ? "Reconstructed from background" : s.fixedColor.toUpperCase()}</span>
                </div>
                <button className={"pick-btn" + (s.picking ? " active" : "")} onClick={() => eng().startPick("fill")} title="Eyedropper — pick a color from the document" aria-label="Pick cover color from document">
                  <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m2 22 1-1h3l9-9" /><path d="M3 21v-3l9-9" /><path d="m15 6 3.4-3.4a2.1 2.1 0 0 1 3 3L18 9l.4.4a2.1 2.1 0 0 1 0 3 2.1 2.1 0 0 1-3 0L9 6.6a2.1 2.1 0 0 1 0-3 2.1 2.1 0 0 1 3 0z" /></svg>
                </button>
              </div>
            </section>
          ) : (
            <BrushPanel s={s} eng={eng} />
          )}

          <section className="panel">
            <div className="panel-head">Numbers <span className="pill">{s.count}</span></div>
            <label className="toggle-row"><input type="checkbox" checked={s.showOverlays} onChange={(e) => eng().toggleOverlays(e.target.checked)} /><span>Show highlights</span></label>
            <button className="btn btn-ghost wide" disabled={!s.hasDoc} onClick={() => eng().eraseAll()}>Erase all numbers</button>
          </section>

          <section className="panel page-panel" hidden={!s.hasDoc}>
            <div className="panel-head">Pages <span className="pill">{s.pageCount}</span></div>
            <div className="thumbs" ref={thumbsRef} />
          </section>
        </aside>
      </div>

      <footer className="statusbar">
        <span className="status-item">{s.status}</span>
        <span className="status-spacer" />
        <span className="status-item mono">{s.hasDoc ? `Page ${s.current + 1} / ${s.pageCount}` : ""}</span>
      </footer>

      <div className="toasts">
        {toasts.map((t) => (<div key={t.id} className={"toast " + t.kind}><span className="dot" /><span>{t.msg}</span></div>))}
      </div>

      <input type="file" ref={fileRef} accept="application/pdf,image/*,.pdf,.png,.jpg,.jpeg,.webp" hidden onChange={onPick} />
    </div>
  );
}
