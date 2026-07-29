import { useEffect, useState } from "react";

/* Find & Replace — no AI, no round trip. Every word run already carries its
 * text, so searching is instant and free; the AI Edit panel is for changes that
 * actually need judgement ("delete all prices"), not literal substitutions.
 */
export default function FindPanel({ s, eng }) {
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [whole, setWhole] = useState(false);

  // re-run as the user types (and whenever an option flips)
  useEffect(() => {
    if (!s.hasDoc) return;
    const t = setTimeout(() => eng()?.search(query, { matchCase, whole }), 150);
    return () => clearTimeout(t);
  }, [query, matchCase, whole, s.hasDoc, eng]);

  const matches = s.matches || [];

  return (
    <section className="panel">
      <div className="panel-head">Find &amp; Replace {matches.length > 0 && <span className="pill">{matches.length}</span>}</div>

      <input
        className="ai-input" placeholder="Find…" value={query}
        disabled={!s.hasDoc} onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => e.stopPropagation()}
      />
      <input
        className="ai-input" placeholder="Replace with…" value={replacement}
        disabled={!s.hasDoc} onChange={(e) => setReplacement(e.target.value)}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") eng().replaceAll(replacement); }}
      />

      <div className="opt-row">
        <label className="toggle-row"><input type="checkbox" checked={matchCase} onChange={(e) => setMatchCase(e.target.checked)} /><span>Match case</span></label>
        <label className="toggle-row"><input type="checkbox" checked={whole} onChange={(e) => setWhole(e.target.checked)} /><span>Whole word</span></label>
      </div>

      <button className="btn btn-primary wide" disabled={!matches.length} onClick={() => eng().replaceAll(replacement)}>
        Replace all {matches.length ? `(${matches.length})` : ""}
      </button>

      {query.trim() && !matches.length && <p className="hint-txt">No matches in this document.</p>}

      {matches.length > 0 && (
        <div className="prop-list">
          {matches.map((m) => (
            <div key={m.id} className="prop-row" onClick={() => eng().gotoProposal(m.id)} title="Click to show on the page">
              <div className="prop-body">
                <span className="prop-page">p.{m.page + 1}</span>
                <Hit text={m.text} query={query} matchCase={matchCase} />
              </div>
              <button
                className="btn btn-ghost sm"
                onClick={(e) => { e.stopPropagation(); eng().replaceMatch(m.id, replacement); }}
                title="Replace just this one"
              >↻</button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/* Highlight the matched part so a hit inside a longer run is obvious
   ("1234" inside "INV-1234-A"). */
function Hit({ text, query, matchCase }) {
  const q = query.trim();
  if (!q) return <span>{text}</span>;
  const hay = matchCase ? text : text.toLowerCase();
  const needle = matchCase ? q : q.toLowerCase();
  const at = hay.indexOf(needle);
  if (at < 0) return <span>{text}</span>;
  return (
    <span>
      {text.slice(0, at)}
      <mark className="hit">{text.slice(at, at + q.length)}</mark>
      {text.slice(at + q.length)}
    </span>
  );
}
