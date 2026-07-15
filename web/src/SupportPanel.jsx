import { useRef, useState } from "react";

/* Support — users report a problem: a message, a screenshot of it, and the
 * document they couldn't edit (auto-attached from the open session, or a file
 * they pick). Sent to the server's support inbox. */
export default function SupportPanel({ s, eng, onToast }) {
  const [message, setMessage] = useState("");
  const [email, setEmail] = useState("");
  const [shot, setShot] = useState(null);        // { blob, url, label }
  const [doc, setDoc] = useState(null);          // File
  const [sending, setSending] = useState(false);
  const shotRef = useRef(null);
  const docRef = useRef(null);

  const setShotBlob = (blob, label) => {
    setShot((prev) => { if (prev?.url) URL.revokeObjectURL(prev.url); return blob ? { blob, url: URL.createObjectURL(blob), label } : null; });
  };
  const useView = async () => {
    const blob = await eng().snapshotView();
    if (blob) setShotBlob(blob, "Current view"); else onToast("Open a document first", "error");
  };
  const pickShot = (e) => { const f = e.target.files[0]; if (f) setShotBlob(f, f.name); e.target.value = ""; };
  const pickDoc = (e) => { const f = e.target.files[0]; if (f) setDoc(f); e.target.value = ""; };

  const send = async () => {
    const m = message.trim();
    if (!m || sending) return;
    setSending(true);
    try {
      const ticket = await eng().submitSupport({ message: m, email: email.trim(), screenshot: shot?.blob, document: doc });
      onToast(`Report sent — ticket ${ticket}`, "success");
      setMessage(""); setEmail(""); setShotBlob(null); setDoc(null);
    } catch (e) { console.error(e); onToast(e.message || "Could not send report", "error"); }
    setSending(false);
  };

  return (
    <section className="panel">
      <div className="panel-head">Report a problem</div>
      <p className="hint-txt">Stuck on a document, or something looks wrong? Tell us what happened and attach a screenshot — we'll take a look.</p>

      <textarea
        className="ai-input" rows={4} placeholder="What went wrong? What did you expect to happen?"
        value={message} onChange={(e) => setMessage(e.target.value)}
        onKeyDown={(e) => e.stopPropagation()}
      />

      <label className="field-label">Screenshot</label>
      {shot && <div className="attach-preview"><img src={shot.url} alt="screenshot" /><button className="attach-x" onClick={() => setShotBlob(null)} title="Remove">×</button></div>}
      <div className="btn-row">
        <button className="btn btn-ghost" onClick={useView} disabled={!s.hasDoc}>Use current view</button>
        <button className="btn btn-ghost" onClick={() => shotRef.current.click()}>Upload image</button>
      </div>

      <label className="field-label">Document you couldn't edit</label>
      <div className="attach-line">
        {doc ? <span className="attach-name">{doc.name}</span>
          : s.hasDoc ? <span className="attach-name muted">Using the open document</span>
          : <span className="attach-name muted">None</span>}
        <button className="btn btn-ghost sm" onClick={() => docRef.current.click()}>{doc || s.hasDoc ? "Change" : "Attach"}</button>
        {doc && <button className="attach-x" onClick={() => setDoc(null)} title="Remove">×</button>}
      </div>

      <label className="field-label">Email <span className="muted">(optional, for a reply)</span></label>
      <input className="ai-input" type="email" placeholder="you@example.com" value={email}
        onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />

      <button className="btn btn-primary wide" disabled={!message.trim() || sending} onClick={send}>
        {sending ? "Sending…" : "Send report"}
      </button>

      <input type="file" ref={shotRef} accept="image/*" hidden onChange={pickShot} />
      <input type="file" ref={docRef} accept="application/pdf,image/*" hidden onChange={pickDoc} />
    </section>
  );
}
