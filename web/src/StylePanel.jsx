/* Style — pin the look of replacement text.
 *
 * Everything defaults to "Auto": the size, colour and weight detected for the
 * word being replaced (on scans those are estimated from pixels, so they are
 * sometimes wrong and the user had no way to correct them). A pinned value
 * overrides the detection for every following edit, and for the text tool.
 */
const FAMILIES = [
  { id: null, label: "Auto" },
  { id: "sans", label: "Sans" },
  { id: "serif", label: "Serif" },
  { id: "mono", label: "Mono" },
];

export default function StylePanel({ s, eng }) {
  const st = s.style || {};
  const pinned = Object.values(st).some((v) => v !== null && v !== undefined);
  const set = (patch) => eng().setStyle(patch);
  // a tri-state toggle: Auto → on → off → Auto
  const cycle = (v) => (v === null ? true : v === true ? false : null);
  const label = (v) => (v === null ? "Auto" : v ? "On" : "Off");

  return (
    <>
      <div className="panel-head">
        Style
        {pinned && <button className="head-link" onClick={() => eng().resetStyle()}>Reset</button>}
      </div>

      <div className="style-grid">
        <label className="field-label">Size</label>
        <div className="style-ctl">
          <input
            type="number" className="num-input" min="4" max="200" step="0.5"
            value={st.size ?? ""} placeholder="Auto"
            onChange={(e) => set({ size: e.target.value === "" ? null : Number(e.target.value) })}
            onKeyDown={(e) => e.stopPropagation()}
          />
          <span className="unit">px</span>
        </div>

        <label className="field-label">Colour</label>
        <div className="style-ctl">
          <input
            type="color" className="color-input" value={st.color || "#111111"}
            onChange={(e) => set({ color: e.target.value })}
          />
          <button className="btn btn-ghost sm" disabled={!st.color} onClick={() => set({ color: null })}>Auto</button>
        </div>

        <label className="field-label">Weight</label>
        <div className="style-ctl">
          <button className={"btn btn-ghost sm wide" + (st.bold ? " on" : "")} onClick={() => set({ bold: cycle(st.bold) })}>
            <b>B</b> {label(st.bold)}
          </button>
          <button className={"btn btn-ghost sm wide" + (st.italic ? " on" : "")} onClick={() => set({ italic: cycle(st.italic) })}>
            <i>I</i> {label(st.italic)}
          </button>
        </div>

        <label className="field-label">Family</label>
        <div className="style-ctl">
          <div className="seg seg-4">
            {FAMILIES.map((f) => (
              <button
                key={f.label}
                className={"seg-btn" + ((st.family ?? null) === f.id ? " active" : "")}
                onClick={() => set({ family: f.id, fontName: f.id ? null : st.fontName })}
              >{f.label}</button>
            ))}
          </div>
        </div>
      </div>

      {st.fontName && (
        <p className="hint-txt">Using <b>{st.fontName}</b> for replacements. <button className="head-link" onClick={() => set({ fontName: null })}>Clear</button></p>
      )}

      {/* AI font identification — names the real fonts on the page and loads
          them, so a replacement can match the document instead of falling back
          to the web-safe stack. */}
      {s.aiAvailable && (
        <>
          <button className="btn btn-ghost wide" disabled={!s.hasDoc || s.fontsLoading} onClick={() => eng().findFonts()}>
            {s.fontsLoading ? "Looking…" : "Find fonts with AI"}
          </button>
          {s.fonts.length > 0 && (
            <div className="prop-list">
              {s.fonts.map((f, i) => (
                <div key={i} className="prop-row" onClick={() => eng().useFont(f)} title="Use this font for replacements">
                  <div className="prop-body">
                    <b>{f.font}</b> <span className="muted">{f.style}{f.approxSizePt ? ` · ${f.approxSizePt}pt` : ""}</span>
                    <div className="muted">{f.usage}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}
