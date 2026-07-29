import { useEffect, useMemo, useRef, useState } from "react";

/* Command palette (⌘K) — every tool, panel and action in one searchable list.
 *
 * The editor grew more tools than the inspector can advertise at a glance, and
 * the tool row only exists once a document is open, so features were easy to
 * miss entirely. This is the one place that always knows everything the app
 * can do.
 */

/* Rank a command against the query. A substring hit wins (earlier = better);
   otherwise the query has to appear as a subsequence, so "fpdf" still finds
   "Export PDF". Returns -1 for no match. */
export function score(text, query) {
  const q = (query || "").trim().toLowerCase();
  if (!q) return 0;
  const t = (text || "").toLowerCase();
  const at = t.indexOf(q);
  if (at >= 0) return 1000 - at;
  let i = 0;
  for (const ch of q) {
    i = t.indexOf(ch, i);
    if (i < 0) return -1;
    i++;
  }
  return 1;
}

/* The full command set, built fresh from the current state so `enabled`
   reflects what is actually possible right now. */
export function buildCommands({ s, eng, setTab, openFile }) {
  const doc = s.hasDoc;
  const e = () => eng();
  const cmds = [
    // tools
    { group: "Tool", label: "Edit text", hint: "V", enabled: doc, run: () => e().setTool("edit") },
    { group: "Tool", label: "Add text", hint: "T", enabled: doc, run: () => e().setTool("text") },
    { group: "Tool", label: "Numbers — click a number to delete it", hint: "N", enabled: doc, run: () => e().setTool("numbers") },
    { group: "Tool", label: "Erase area", hint: "E", enabled: doc, run: () => e().setTool("erase") },
    { group: "Tool", label: "Copy region", hint: "C", enabled: doc, run: () => e().setTool("copy") },

    // panels
    { group: "Go to", label: "Edit panel", enabled: true, run: () => setTab("edit") },
    { group: "Go to", label: "Find & Replace", hint: "⌘F", enabled: true, run: () => setTab("find") },
    { group: "Go to", label: "AI Edit", enabled: true, run: () => setTab("aiedit") },
    { group: "Go to", label: "Chat", enabled: true, run: () => setTab("chat") },
    { group: "Go to", label: "Pages", enabled: true, run: () => setTab("pages") },
    { group: "Go to", label: "Report a problem", enabled: true, run: () => setTab("support") },

    // document
    { group: "Document", label: "Open a file…", hint: "⌘O", enabled: true, run: openFile },
    { group: "Document", label: "Export PDF", enabled: doc, run: () => e().exportPdf() },
    { group: "Document", label: "Export this page as PNG", enabled: doc, run: () => e().exportPng() },
    { group: "Document", label: "Digitize — rebuild with a real text layer", enabled: doc, run: () => e().digitize(s.aiAvailable) },

    // editing
    { group: "Edit", label: "Undo", hint: "⌘Z", enabled: s.canUndo, run: () => e().undo() },
    { group: "Edit", label: "Redo", hint: "⌘⇧Z", enabled: s.canRedo, run: () => e().redo() },
    { group: "Edit", label: "Reset this page", enabled: doc, run: () => e().resetPage() },
    { group: "Edit", label: s.showOverlays ? "Hide text highlights" : "Show text highlights", enabled: doc, run: () => e().toggleOverlays(!s.showOverlays) },

    // pages
    { group: "Page", label: "Next page", hint: "→", enabled: doc && s.current < s.pageCount - 1, run: () => e().showPage(s.current + 1) },
    { group: "Page", label: "Previous page", hint: "←", enabled: doc && s.current > 0, run: () => e().showPage(s.current - 1) },
    { group: "Page", label: "Rotate page right", enabled: doc, run: () => e().rotatePage(90) },
    { group: "Page", label: "Rotate page left", enabled: doc, run: () => e().rotatePage(-90) },
    { group: "Page", label: "Delete this page", enabled: doc && s.pageCount > 1, run: () => e().deletePage(s.current) },
    { group: "Page", label: "Zoom in", hint: "+", enabled: doc, run: () => e().zoomBy(1.15) },
    { group: "Page", label: "Zoom out", hint: "−", enabled: doc, run: () => e().zoomBy(1 / 1.15) },
    { group: "Page", label: "Fit to window", hint: "0", enabled: doc, run: () => e().zoomFit() },

    // AI
    { group: "AI", label: "Fix OCR with AI", enabled: doc && s.aiAvailable && s.scanned, run: () => e().fixOcr() },
    { group: "AI", label: "Find fonts with AI", enabled: doc && s.aiAvailable, run: () => e().findFonts() },
  ];
  return cmds.map((c, i) => ({ ...c, id: i }));
}

export default function CommandPalette({ open, onClose, s, eng, setTab, openFile }) {
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  const commands = useMemo(() => buildCommands({ s, eng, setTab, openFile }), [s, eng, setTab, openFile]);

  const results = useMemo(() => {
    const scored = commands
      .map((c) => ({ c, n: Math.max(score(c.label, q), score(`${c.group} ${c.label}`, q)) }))
      .filter((x) => x.n >= 0);
    // disabled commands stay listed but sink, so you can still see they exist
    scored.sort((a, b) => (b.c.enabled - a.c.enabled) || (b.n - a.n) || (a.c.id - b.c.id));
    return scored.map((x) => x.c);
  }, [commands, q]);

  useEffect(() => { if (open) { setQ(""); setActive(0); } }, [open]);
  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);
  useEffect(() => { setActive(0); }, [q]);
  useEffect(() => {
    listRef.current?.querySelector('[data-active="1"]')?.scrollIntoView({ block: "nearest" });
  }, [active, results]);

  if (!open) return null;

  const pick = (cmd) => {
    if (!cmd || !cmd.enabled) return;
    onClose();
    // let the palette unmount before the command steals focus or opens a dialog
    setTimeout(() => cmd.run(), 0);
  };

  const onKeyDown = (ev) => {
    ev.stopPropagation();                            // never fire global shortcuts here
    if (ev.key === "ArrowDown") { ev.preventDefault(); setActive((i) => Math.min(i + 1, results.length - 1)); }
    else if (ev.key === "ArrowUp") { ev.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
    else if (ev.key === "Enter") { ev.preventDefault(); pick(results[active]); }
    else if (ev.key === "Escape") { ev.preventDefault(); onClose(); }
  };

  let lastGroup = null;

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette" onMouseDown={(ev) => ev.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette-input"
          placeholder="Search tools and actions…"
          value={q}
          onChange={(ev) => setQ(ev.target.value)}
          onKeyDown={onKeyDown}
          aria-label="Search commands"
        />
        <div className="palette-list" ref={listRef} role="listbox">
          {results.length === 0 && <div className="palette-empty">Nothing matches “{q}”.</div>}
          {results.map((c, i) => {
            const head = c.group !== lastGroup ? ((lastGroup = c.group), c.group) : null;
            return (
              <div key={c.id}>
                {head && <div className="palette-group">{head}</div>}
                <button
                  className={"palette-item" + (i === active ? " active" : "") + (c.enabled ? "" : " disabled")}
                  data-active={i === active ? "1" : "0"}
                  role="option"
                  aria-selected={i === active}
                  disabled={!c.enabled}
                  onMouseMove={() => setActive(i)}
                  onClick={() => pick(c)}
                >
                  <span className="palette-label">{c.label}</span>
                  {c.hint && <kbd className="palette-hint">{c.hint}</kbd>}
                </button>
              </div>
            );
          })}
        </div>
        <div className="palette-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
          <span><kbd>↵</kbd> run</span>
          <span><kbd>esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}
