import { useEffect, useRef, useState, useCallback } from "react";
import Editor from "./engine/Editor.js";
import AiPanel from "./AiPanel.jsx";
import ChatPanel from "./ChatPanel.jsx";
import CommandPalette from "./CommandPalette.jsx";
import FindPanel from "./FindPanel.jsx";
import PagesPanel from "./PagesPanel.jsx";
import StylePanel from "./StylePanel.jsx";
import SupportPanel from "./SupportPanel.jsx";

/* ── tiny inline icon set ─────────────────────────────────────────────── */
const I = {
  logo: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /><path d="M9 13h6M9 17h4" /></>,
  open: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></>,
  download: <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m7 10 5 5 5-5" /><path d="M12 15V3" /></>,
  upload: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /><path d="M12 18v-6" /><path d="m9 15 3-3 3 3" /></>,
  undo: <><path d="M3 7v6h6" /><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13" /></>,
  redo: <><path d="M21 7v6h-6" /><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13" /></>,
  reset: <><path d="M3 2v6h6" /><path d="M3 13a9 9 0 1 0 3-7.7L3 8" /></>,
  text: <><path d="M4 7V4h16v3" /><path d="M9 20h6" /><path d="M12 4v16" /></>,
  wand: <><path d="m15 4 1.2 2.8L19 8l-2.8 1.2L15 12l-1.2-2.8L11 8l2.8-1.2z" /><path d="m5 13 .8 1.7L7.5 15.5l-1.7.8L5 18l-.8-1.7-1.7-.8 1.7-.8z" /><path d="M13.5 13.5 20 20" /></>,
  layers: <><rect x="3" y="3" width="13" height="16" rx="1.5" /><path d="M8 21h11a2 2 0 0 0 2-2V8" opacity=".55" /></>,
  help: <><circle cx="12" cy="12" r="9.5" /><path d="M9.5 9.5a2.5 2.5 0 1 1 3.4 2.3c-.7.3-1.4.9-1.4 1.9v.3" /><path d="M12 17.2h.01" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.6-3.6" /></>,
  chat: <><path d="M21 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z" /></>,
};
const Svg = ({ d, s = 20 }) => (
  <svg viewBox="0 0 24 24" width={s} height={s} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{d}</svg>
);

const TABS = [
  { id: "edit", label: "Edit", icon: I.text },
  { id: "find", label: "Find", icon: I.search },
  { id: "aiedit", label: "AI Edit", icon: I.wand },
  { id: "chat", label: "Chat", icon: I.chat },
  { id: "pages", label: "Pages", icon: I.layers },
];

/* Tesseract codes → readable names. Anything not listed shows its raw code,
   which is still better than hiding an installed pack. */
const LANG_NAMES = {
  eng: "English", uzb: "Oʻzbekcha", uzb_cyrl: "Ўзбекча (кирилл)", rus: "Русский",
  tur: "Türkçe", deu: "Deutsch", fra: "Français", spa: "Español", ita: "Italiano",
  por: "Português", pol: "Polski", ukr: "Українська", kaz: "Қазақша", ara: "العربية",
  chi_sim: "中文 (简体)", jpn: "日本語", kor: "한국어",
};
const langLabel = (c) => LANG_NAMES[c] || c;
const BOTTOM_TABS = [
  { id: "support", label: "Support", icon: I.help },
];

export default function App() {
  const stageRef = useRef(null);
  const hostRef = useRef(null);
  const thumbsRef = useRef(null);
  const fileRef = useRef(null);
  const engineRef = useRef(null);

  /* Seed from a throwaway engine's own snapshot rather than a hand-written
     literal: the first render happens before mount() emits, and a field the
     literal forgot (an array, say) crashes the whole tree on that render. */
  const [s, setS] = useState(() => new Editor({}).snapshot());
  const [tab, setTab] = useState("edit");
  const [toasts, setToasts] = useState([]);
  const [drag, setDrag] = useState(false);
  const [palette, setPalette] = useState(false);
  const [hintSupport, setHintSupport] = useState(() => localStorage.getItem("docedit.supportHint") !== "seen");
  const dismissHint = () => { setHintSupport(false); localStorage.setItem("docedit.supportHint", "seen"); };

  const pushToast = useCallback((msg, kind = "") => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t, { id, msg, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2600);
  }, []);

  useEffect(() => {
    const eng = new Editor({ onState: setS, onToast: pushToast });
    eng.mount({ stageEl: stageRef.current, hostEl: hostRef.current, thumbsEl: thumbsRef.current });
    eng.loadLangs();                                                // populate the OCR picker
    engineRef.current = eng;

    const onKey = (e) => {
      const mod = e.metaKey || e.ctrlKey;
      // ⌘K works from anywhere, including while typing in a panel
      if (mod && e.key.toLowerCase() === "k") { e.preventDefault(); setPalette((p) => !p); return; }
      if (mod && e.key.toLowerCase() === "f") { e.preventDefault(); setTab("find"); return; }
      if (e.target.tagName === "TEXTAREA" || (e.target.tagName === "INPUT" && e.target.type !== "range")) return;
      if (mod && e.key.toLowerCase() === "o") { e.preventDefault(); fileRef.current?.click(); return; }
      if (e.key === "Enter") { eng.commitPaste(); return; }          // place a pending copy
      if (e.key === "Escape") { eng.cancelPaste(); return; }
      if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? eng.redo() : eng.undo(); return; }
      if (e.key === "+" || e.key === "=") { eng.zoomBy(1.15); return; }
      if (e.key === "-" || e.key === "_") { eng.zoomBy(1 / 1.15); return; }
      if (e.key === "0") { eng.zoomFit(); return; }
      if (e.key === "ArrowRight" || e.key === "PageDown") { eng.showPage(eng.current + 1); return; }
      if (e.key === "ArrowLeft" || e.key === "PageUp") { eng.showPage(eng.current - 1); return; }
      if (e.key === "e") { eng.setTool("erase"); return; }
      if (e.key === "c") { eng.setTool("copy"); return; }
      if (e.key === "t") { eng.setTool("text"); return; }
      if (e.key === "n") { eng.setTool("numbers"); return; }
      if (e.key === "v") { eng.setTool("edit"); return; }
    };
    window.addEventListener("keydown", onKey);

    // Ctrl/⌘ + wheel (and trackpad pinch) → smooth zoom at the cursor. The
    // factor is proportional to the scroll amount (fine ~1-2% steps on a
    // trackpad), clamped so a mouse-wheel notch never jumps more than ~9%.
    const stage = stageRef.current;
    const onWheel = (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const factor = Math.min(1.18, Math.max(0.85, Math.exp(-e.deltaY * 0.006)));
      eng.zoomBy(factor, e.clientX, e.clientY);
    };
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
          <div className="brand-text"><h1>DocEdit</h1><span>AI Document Editor</span></div>
        </div>
        <div className="topbar-actions">
          <button className="btn btn-ghost" onClick={openFile}><Svg d={I.open} s={16} />Open</button>
          {/* a visible door into every command — the tools were easy to miss */}
          <button className="btn btn-ghost cmd-btn" onClick={() => setPalette(true)} title="Search tools and actions (⌘K)">
            <Svg d={I.search} s={15} />Commands<kbd>⌘K</kbd>
          </button>
          <div className="divider-v" />
          <button className="btn btn-ghost icon" disabled={!s.canUndo} onClick={() => eng().undo()} title="Undo (⌘Z)"><Svg d={I.undo} s={16} /></button>
          <button className="btn btn-ghost icon" disabled={!s.canRedo} onClick={() => eng().redo()} title="Redo (⌘⇧Z)"><Svg d={I.redo} s={16} /></button>
          <button className="btn btn-ghost icon" disabled={!s.hasDoc} onClick={() => eng().resetPage()} title="Reset page"><Svg d={I.reset} s={16} /></button>
          <div className="divider-v" />
          <button
            className="btn btn-ghost" disabled={!s.hasDoc || s.digitizing}
            onClick={() => eng().digitize(s.aiAvailable)}
            title="Rebuild the document as a searchable PDF with a real text layer"
          >{s.digitizing ? "Digitizing…" : "Digitize"}</button>
          <button className="btn btn-ghost" disabled={!s.hasDoc} onClick={() => eng().exportPng()}>PNG</button>
          <button className="btn btn-primary" disabled={!s.hasDoc} onClick={() => eng().exportPdf()}>
            <Svg d={I.download} s={16} />Export PDF{s.exportPages ? ` (${s.exportPages.length})` : ""}
          </button>
        </div>
      </header>

      <div className="body">
        {/* Function rail */}
        <nav className="rail">
          {TABS.map((t) => (
            <button key={t.id} className={"rail-tab" + (tab === t.id ? " active" : "")} onClick={() => setTab(t.id)} title={t.label}>
              <Svg d={t.icon} s={19} />
              <span>{t.label}</span>
            </button>
          ))}
          <div className="rail-spacer" />
          {BOTTOM_TABS.map((t) => (
            <button key={t.id} className={"rail-tab" + (tab === t.id ? " active" : "")} onClick={() => { setTab(t.id); dismissHint(); }} title={t.label}>
              <Svg d={t.icon} s={19} />
              <span>{t.label}</span>
            </button>
          ))}
        </nav>

        {hintSupport && tab !== "support" && (
          <div className="support-hint">
            <span>Report a problem</span>
            <button className="hint-x" onClick={dismissHint} title="Dismiss" aria-label="Dismiss">×</button>
          </div>
        )}

        {/* Stage */}
        <main
          className={"stage-outer" + (drag ? " dragover" : "")}
          onDragEnter={(e) => { e.preventDefault(); setDrag(true); }}
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
          onDragLeave={(e) => { e.preventDefault(); setDrag(false); }}
          onDrop={onDrop}
        >
          {/* The canvas keeps working after the server drops a session, but
              seamless erasing and every AI action stop — say so instead of
              letting the quality quietly degrade. */}
          {s.sessionExpired && (
            <div className="expired-banner">
              <span>This session expired on the server — seamless erase and AI features need the document re-opened.</span>
              <button className="btn btn-primary sm" onClick={openFile}>Re-open</button>
            </div>
          )}
          <div className="stage" ref={stageRef}>
            {!s.hasDoc && (
              <div className="dropzone">
                <div className="dz-inner">
                  <div className="dz-icon"><Svg d={I.upload} s={32} /></div>
                  <h2>Drop a PDF or image</h2>
                  <p>The document is analyzed and every piece of text becomes editable.</p>
                  <button className="btn btn-primary lg" onClick={openFile}>Choose a file</button>
                  {/* Scanned pages are read with this language. Tesseract
                      defaults to English, which mangles Cyrillic and the Uzbek
                      oʻ/gʻ digraphs — so the choice belongs before the upload. */}
                  {s.ocrLangs.length > 1 && (
                    <label className="dz-lang">
                      <span>Scan language</span>
                      <select value={s.lang} onChange={(e) => eng().setLang(e.target.value)}>
                        {s.ocrLangs.map((c) => <option key={c} value={c}>{langLabel(c)}</option>)}
                      </select>
                    </label>
                  )}
                  <span className="dz-hint">PDF · JPG · PNG</span>
                </div>
              </div>
            )}
            <div className="canvas-host" ref={hostRef} hidden={!s.hasDoc} />
          </div>
          {s.hasDoc && (
            <div className="zoombar">
              <button onClick={() => eng().zoomBy(1 / 1.15)} title="Zoom out (−)">−</button>
              <button className="zoomlvl" onClick={() => eng().zoomFit()} title="Fit (0)">{Math.round((s.zoom || 1) * 100)}%</button>
              <button onClick={() => eng().zoomBy(1.15)} title="Zoom in (+)">+</button>
            </div>
          )}
          {s.loading && (
            <div className="loader">
              <div className="loader-card">
                <div className="loader-pct mono">{Math.round(s.progress * 100)}<span>%</span></div>
                <div className="loader-text">{s.loadingText.replace(/\s*\d+%$/, "")}</div>
                <div className="progress"><div className="progress-bar" style={{ width: Math.round(s.progress * 100) + "%" }} /></div>
              </div>
            </div>
          )}
        </main>

        {/* Inspector — content follows the selected function tab */}
        <aside className="inspector">
          {!s.hasDoc && tab !== "support" && (
            <section className="panel">
              <div className="panel-head">{TABS.find((t) => t.id === tab)?.label}</div>
              <p className="hint-txt">Open a PDF or image to start.</p>
              {/* the tool row only exists once a document is open, so list what
                  is coming — otherwise these features are invisible until you
                  happen to open a file and look in the right tab */}
              {tab === "edit" && (
                <ul className="tool-preview">
                  <li><b>✎ Edit</b> — click a word and retype it</li>
                  <li><b>T Text</b> — add new text anywhere</li>
                  <li><b># Numbers</b> — every number gets a blue border; click one to <b>delete</b> it</li>
                  <li><b>◌ Erase</b> — drag over a stamp, mark or object</li>
                  <li><b>⧉ Copy</b> — duplicate a piece of the page</li>
                </ul>
              )}
            </section>
          )}

          <section className="panel" hidden={!s.hasDoc || tab !== "edit"}>
            <div className="panel-head">Tool</div>
            <div className="seg seg-wrap">
              <button className={"seg-btn" + (s.tool === "edit" ? " active" : "")} onClick={() => eng().setTool("edit")}>✎ Edit</button>
              <button className={"seg-btn" + (s.tool === "text" ? " active" : "")} onClick={() => eng().setTool("text")}>T Text</button>
              <button className={"seg-btn" + (s.tool === "numbers" ? " active" : "")} onClick={() => eng().setTool("numbers")}># Numbers</button>
              <button className={"seg-btn" + (s.tool === "erase" ? " active" : "")} onClick={() => eng().setTool("erase")}>◌ Erase</button>
              <button className={"seg-btn" + (s.tool === "copy" ? " active" : "")} onClick={() => eng().setTool("copy")}>⧉ Copy</button>
            </div>
            {s.tool === "erase"
              ? <p className="hint-txt">Drag over anything — a stamp, handwriting, mark or object — and it's removed seamlessly, like the phone gallery eraser. ⌘Z undoes.</p>
              : s.tool === "copy"
              ? <p className="hint-txt">Drag a box around anything to copy it, then drag the copy where you want it. {s.pasteActive ? <b>Press Place to drop it.</b> : "It stays movable until you Place it."}</p>
              : s.tool === "text"
              ? <p className="hint-txt">Click anywhere on the page to add new text — Enter saves, Esc cancels. It picks up whatever is pinned in <b>Style</b> below.</p>
              : s.tool === "numbers"
              ? <p className="hint-txt">Every run containing a digit gets a blue border — amounts, quantities, dates, reference numbers. <b>One click wipes it</b> and rebuilds the background. ⌘Z undoes. <span className="pill">{s.numCount}</span> on this page.</p>
              : <p className="hint-txt">Click any word to edit it — Enter saves, Esc cancels. <b>Right-click a word to erase it instantly.</b></p>}
            {s.tool === "copy" && s.pasteActive && (
              <div className="btn-row">
                <button className="btn btn-primary" onClick={() => eng().commitPaste()}>Place</button>
                <button className="btn btn-ghost" onClick={() => eng().cancelPaste()}>Cancel</button>
              </div>
            )}

            <div className="divider-h" />
            <div className="panel-head">Text <span className="pill">{s.count}</span></div>
            <label className="toggle-row"><input type="checkbox" checked={s.showOverlays} onChange={(e) => eng().toggleOverlays(e.target.checked)} /><span>Highlight editable text</span></label>
            {s.scanned && s.ocrAvailable && <p className="hint-txt note">Scanned page — text detected via OCR, dashed boxes mean the styling is estimated.</p>}
            {s.scanned && !s.ocrAvailable && <p className="hint-txt note">Scanned page, but OCR (Tesseract) isn't installed on the server.</p>}
            {/* Gemini re-reads the page image and corrects misread words — the
                practical fix when the right language pack isn't installed. */}
            {s.scanned && s.aiAvailable && (
              <button className="btn btn-ghost wide" disabled={s.ocrFixLoading} onClick={() => eng().fixOcr()}>
                {s.ocrFixLoading ? "Checking the page…" : "Fix OCR with AI"}
              </button>
            )}

            <div className="divider-h" />
            <StylePanel s={s} eng={eng} />
          </section>

          <div hidden={!s.hasDoc || tab !== "find"}><FindPanel s={s} eng={eng} /></div>

          <div hidden={!s.hasDoc || tab !== "aiedit"}><AiPanel s={s} eng={eng} /></div>

          <div hidden={!s.hasDoc || tab !== "chat"}><ChatPanel s={s} eng={eng} /></div>

          <div hidden={tab !== "support"}><SupportPanel s={s} eng={eng} onToast={pushToast} /></div>

          <div className="panel-host" hidden={!s.hasDoc || tab !== "pages"}>
            <PagesPanel s={s} eng={eng} thumbsRef={thumbsRef} onToast={pushToast} />
          </div>
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

      <CommandPalette
        open={palette} onClose={() => setPalette(false)}
        s={s} eng={eng} setTab={setTab} openFile={openFile}
      />

      <input type="file" ref={fileRef} accept="application/pdf,image/*,.pdf,.png,.jpg,.jpeg,.webp" hidden onChange={onPick} />
    </div>
  );
}
