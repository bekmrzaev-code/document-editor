/* Pages — the thumbnail navigator (rendered by the engine into `thumbsRef`)
 * plus the page operations: rotate, reorder, delete, and picking which pages
 * the PDF export should contain.
 *
 * Rotate and delete are server round trips, not canvas tricks: the backend
 * re-detects the text on the rotated raster and keeps its own page list in
 * step, so Digitize and the AI endpoints never work on a stale document.
 */
export default function PagesPanel({ s, eng, thumbsRef, onToast }) {
  const i = s.current;
  const last = s.pageCount - 1;
  const selected = s.exportPages;                 // null = every page
  const isSel = (k) => !selected || selected.includes(k);

  const rotate = (deg) => {
    if (eng().hasPageEdits(i) && !window.confirm(
      "Rotating reloads this page from the server, so the edits on it will be lost. Continue?")) return;
    eng().rotatePage(deg);
  };

  const remove = () => {
    if (s.pageCount <= 1) { onToast("A document needs at least one page", "error"); return; }
    if (window.confirm(`Delete page ${i + 1}? This also removes it from the document on the server.`)) eng().deletePage(i);
  };

  return (
    <section className="panel page-panel">
      <div className="panel-head">Pages <span className="pill">{s.pageCount}</span></div>

      <div className="field-label">Page {i + 1}</div>
      <div className="btn-row">
        <button className="btn btn-ghost" onClick={() => rotate(-90)} title="Rotate left">↺</button>
        <button className="btn btn-ghost" onClick={() => rotate(90)} title="Rotate right">↻</button>
        <button className="btn btn-ghost" disabled={i <= 0} onClick={() => eng().movePage(i, -1)} title="Move up">↑</button>
        <button className="btn btn-ghost" disabled={i >= last} onClick={() => eng().movePage(i, 1)} title="Move down">↓</button>
        <button className="btn btn-ghost danger" disabled={s.pageCount <= 1} onClick={remove} title="Delete page">✕</button>
      </div>

      <div className="divider-h" />

      <div className="panel-head">
        Include in export
        {selected && <button className="head-link" onClick={() => eng().selectAllPages()}>All</button>}
      </div>
      <div className="page-chips">
        {Array.from({ length: s.pageCount }, (_, k) => (
          <button
            key={k}
            className={"page-chip" + (isSel(k) ? " on" : "") + (k === i ? " current" : "")}
            onClick={() => eng().toggleExportPage(k)}
            title={isSel(k) ? `Page ${k + 1} is exported` : `Page ${k + 1} is skipped`}
          >{k + 1}</button>
        ))}
      </div>
      {selected && <p className="hint-txt">Exporting {selected.length} of {s.pageCount} pages.</p>}

      <div className="divider-h" />
      <div className="thumbs" ref={thumbsRef} />
    </section>
  );
}
