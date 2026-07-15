import { useState } from "react";

/* AI Edit — natural-language editing (AI backend): describe a change,
 * review the proposed run-level edits, apply the checked ones (same erase+draw
 * path as manual editing, so undo/redo work).
 */
export default function AiPanel({ s, eng }) {
  const [ins, setIns] = useState("");

  const propose = () => {
    const t = ins.trim();
    if (!t || s.aiEditLoading || !s.hasDoc) return;
    eng().proposeEdits(t);
  };

  const checked = s.aiProposals.filter((p) => p.checked).length;

  if (!s.aiAvailable) {
    return (
      <section className="panel">
        <div className="panel-head">AI Edit <span className="pill">AI</span></div>
        <p className="hint-txt">AI is off — set <code>GEMINI_API_KEY</code> on the server to enable it.</p>
      </section>
    );
  }

  return (
    <section className="panel">
      <div className="panel-head">AI Edit <span className="pill">AI</span></div>
      <textarea
        className="ai-input" rows={2}
        placeholder={'e.g. "Replace every Apple with Orange" or "Delete all prices"'}
        value={ins} disabled={!s.hasDoc}
        onChange={(e) => setIns(e.target.value)}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); propose(); } }}
      />
      <button className="btn btn-primary wide" disabled={!s.hasDoc || s.aiEditLoading || !ins.trim()} onClick={propose}>
        {s.aiEditLoading ? "Analyzing…" : "Propose edits"}
      </button>

      {s.aiProposals.length > 0 && (
        <>
          <div className="prop-list">
            {s.aiProposals.map((p) => (
              <div key={p.id} className="prop-row" onClick={() => eng().gotoProposal(p.id)} title="Click to show on the page">
                <input
                  type="checkbox" checked={p.checked}
                  onClick={(e) => e.stopPropagation()}
                  onChange={() => eng().toggleProposal(p.id)}
                />
                <div className="prop-body">
                  <span className="prop-page">p.{p.page + 1}</span>
                  <span className="old">{p.oldText}</span>
                  <span className="arr">→</span>
                  {p.newText.trim() ? <span className="new">{p.newText}</span> : <span className="del">delete</span>}
                </div>
              </div>
            ))}
          </div>
          <button className="btn btn-primary wide" disabled={!checked} onClick={() => eng().applyProposals()}>
            Apply {checked ? `(${checked})` : ""}
          </button>
          <button className="btn btn-ghost wide" onClick={() => eng().discardProposals()}>Discard</button>
        </>
      )}
    </section>
  );
}
