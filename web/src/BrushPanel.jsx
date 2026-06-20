import React, { useRef, useEffect } from "react";

const STYLES = [
  { id: "pen", label: "Pen", w: 2.6, cap: "round", op: 1 },
  { id: "marker", label: "Marker", w: 6, cap: "round", op: 0.85 },
  { id: "highlighter", label: "Highlighter", w: 11, cap: "butt", op: 0.4 },
];
const PRESETS = ["#e23744", "#111827", "#ffffff", "#f59e0b", "#22c55e", "#3b82f6", "#a855f7", "#06b6d4"];

export default function BrushPanel({ s, eng }) {
  const ref = useRef(null);

  // Live preview of the actual stroke (on a white "paper" background).
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const W = c.clientWidth, H = c.clientHeight;
    c.width = W * dpr; c.height = H * dpr;
    const ctx = c.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, W, H);
    const lw = Math.max(1, Math.min(s.brushSize, H - 16));
    ctx.globalAlpha = s.brushOpacity;
    ctx.strokeStyle = s.brushColor;
    ctx.lineWidth = lw;
    ctx.lineCap = s.brushStyle === "highlighter" ? "butt" : "round";
    ctx.lineJoin = "round";
    const pad = lw / 2 + 10;
    ctx.beginPath();
    ctx.moveTo(pad, H * 0.66);
    ctx.bezierCurveTo(W * 0.32, H * 0.04, W * 0.55, H * 1.0, W - pad, H * 0.34);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }, [s.brushColor, s.brushSize, s.brushOpacity, s.brushStyle]);

  const cur = STYLES.find((x) => x.id === s.brushStyle) || STYLES[0];

  return (
    <section className="panel brush-panel">
      <div className="panel-head">
        Brush
        <span className="brush-tag">{cur.label} · {s.brushSize}px · {Math.round(s.brushOpacity * 100)}%</span>
      </div>

      <div className="brush-preview"><canvas ref={ref} /></div>

      <div className="field-label">Style</div>
      <div className="brush-styles">
        {STYLES.map((st) => (
          <button key={st.id} className={"style-btn" + (s.brushStyle === st.id ? " active" : "")} onClick={() => eng().setBrushStyle(st.id)} title={st.label}>
            <svg viewBox="0 0 40 22" width="100%" height="22" preserveAspectRatio="none">
              <line x1="4" y1="11" x2="36" y2="11" stroke={s.brushColor} strokeWidth={st.w} strokeLinecap={st.cap} opacity={st.op} />
            </svg>
            <span>{st.label}</span>
          </button>
        ))}
      </div>

      <div className="field-label">Color</div>
      <div className="brush-color">
        <input type="color" className="cur-swatch" value={s.brushColor} onChange={(e) => eng().setBrushColor(e.target.value)} title="Click to pick a custom color" />
        <button className={"pick-btn" + (s.picking ? " active" : "")} onClick={() => eng().startPick("brush")} title="Eyedropper — pick a color from the document" aria-label="Pick color from document">
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m2 22 1-1h3l9-9" /><path d="M3 21v-3l9-9" /><path d="m15 6 3.4-3.4a2.1 2.1 0 0 1 3 3L18 9l.4.4a2.1 2.1 0 0 1 0 3 2.1 2.1 0 0 1-3 0L9 6.6a2.1 2.1 0 0 1 0-3 2.1 2.1 0 0 1 3 0z" /></svg>
        </button>
        <div className="swatches">
          {PRESETS.map((c) => (
            <button key={c} className={"dot" + (s.brushColor.toLowerCase() === c ? " active" : "")} style={{ background: c }} onClick={() => eng().setBrushColor(c)} title={c} />
          ))}
        </div>
      </div>

      <div className="field">
        <div className="field-label">Size <b>{s.brushSize}px</b></div>
        <div className="field-ctl">
          <input type="range" min="1" max="80" value={s.brushSize} onChange={(e) => eng().setBrushSize(e.target.value)} />
          <span className="size-dot" style={{ width: Math.max(4, Math.min(22, s.brushSize)), height: Math.max(4, Math.min(22, s.brushSize)), background: s.brushColor }} />
        </div>
      </div>

      <div className="field">
        <div className="field-label">Opacity <b>{Math.round(s.brushOpacity * 100)}%</b></div>
        <input type="range" min="5" max="100" value={Math.round(s.brushOpacity * 100)} onChange={(e) => eng().setBrushOpacity(e.target.value / 100)} />
      </div>
    </section>
  );
}
