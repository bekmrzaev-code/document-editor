import { useEffect, useRef, useState } from "react";

/* AI Chat — ask questions about the open document (summary, totals, facts).
 * The server sends Gemini the document's extracted TEXT, never the file.
 */
export default function ChatPanel({ s, eng }) {
  const [q, setQ] = useState("");
  const listRef = useRef(null);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;          // stick to the newest message
  }, [s.aiMessages, s.aiLoading]);

  const ask = () => {
    const t = q.trim();
    if (!t || s.aiLoading || !s.hasDoc) return;
    eng().askAi(t);
    setQ("");
  };

  if (!s.aiAvailable) {
    return (
      <section className="panel">
        <div className="panel-head">Chat <span className="pill">AI</span></div>
        <p className="hint-txt">AI is off — set <code>GEMINI_API_KEY</code> on the server to enable it.</p>
      </section>
    );
  }

  return (
    <section className="panel">
      <div className="panel-head">
        Chat <span className="pill">AI</span>
        {s.aiMessages.length > 0 && <button className="head-link" onClick={() => eng().clearChat()}>Clear</button>}
      </div>

      {s.aiMessages.length === 0 && !s.aiLoading && (
        <p className="hint-txt">Ask about the open document — &ldquo;What&apos;s the total?&rdquo;, &ldquo;Summarize this&rdquo;, &ldquo;Whose signature is on it?&rdquo;</p>
      )}

      <div className="ai-chat" ref={listRef}>
        {s.aiMessages.map((m, i) => (
          <div key={i} className={"ai-msg " + (m.role === "you" ? "user" : "ai") + (m.error ? " error" : "")}>{m.text}</div>
        ))}
        {s.aiLoading && <div className="ai-msg ai typing"><span className="dots">Thinking</span></div>}
      </div>

      <textarea
        className="ai-input" rows={2} placeholder="Ask about this document…"
        value={q} disabled={!s.hasDoc}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(); } }}
      />
      <button className="btn btn-primary wide" disabled={!s.hasDoc || s.aiLoading || !q.trim()} onClick={ask}>
        {s.aiLoading ? "Thinking…" : "Ask"}
      </button>
    </section>
  );
}
