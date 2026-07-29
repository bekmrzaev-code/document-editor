/* Editor.js is 1000+ lines of geometry and state bookkeeping that only ran in a
 * browser. These cover the canvas-free parts — the ones where an off-by-one or
 * a stale index silently corrupts a document rather than throwing.
 *
 * The engine is constructed but never mounted: nothing here touches a 2D
 * context, so no canvas backend is needed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Editor, { fontOptions, isNumericRun } from "./Editor.js";

/* A page as the engine models it, minus the canvases. `base` is the text
   baseline; the geometry helpers use it to decide what shares a line. */
const mkPage = (boxes, w = 600, h = 800) => ({
  w, h, scanned: false, loaded: true,
  boxes: boxes.map((b, i) => ({
    id: b.id ?? i + 1, x: 0, y: 0, w: 40, h: 12, fontSize: 12,
    base: (b.y ?? 0) + 10, erased: false, text: "", kind: "text", ...b,
  })),
});

const mkEditor = (pages = []) => {
  const eng = new Editor({});
  eng.pages = pages;
  eng.current = pages.length ? 0 : -1;
  eng.session = "sid";
  return eng;
};

describe("lineSpace", () => {
  it("stops at the next word on the same line, not at one above or below", () => {
    const page = mkPage([
      { id: 1, x: 100, y: 200, w: 50 },                 // the word being replaced
      { id: 2, x: 200, y: 200, w: 40 },                 // same line, to the right
      { id: 3, x: 120, y: 400, w: 40 },                 // a different line entirely
    ]);
    const eng = mkEditor([page]);
    // room runs from x=100 up to the neighbour at x=200, less a 4px gutter
    expect(eng.lineSpace(page, page.boxes[0])).toBe(96);
  });

  it("runs to the page edge when nothing follows on the line", () => {
    const page = mkPage([{ id: 1, x: 100, y: 200, w: 50 }]);
    const eng = mkEditor([page]);
    expect(eng.lineSpace(page, page.boxes[0])).toBe(600 - 100 - 6);
  });

  it("ignores erased neighbours — their space is free again", () => {
    const page = mkPage([
      { id: 1, x: 100, y: 200, w: 50 },
      { id: 2, x: 200, y: 200, w: 40, erased: true },
    ]);
    const eng = mkEditor([page]);
    expect(eng.lineSpace(page, page.boxes[0])).toBe(600 - 100 - 6);
  });

  it("never returns less than the word's own width, however tight the neighbour", () => {
    const page = mkPage([
      { id: 1, x: 100, y: 200, w: 50 },
      { id: 2, x: 149, y: 200, w: 40 },                 // butted right up against it
    ]);
    const eng = mkEditor([page]);
    // the 4px gutter would leave only 45px — the word's own 50px wins
    expect(eng.lineSpace(page, page.boxes[0])).toBeCloseTo(51, 5);
  });

  it("ignores a neighbour that overlaps the word rather than following it", () => {
    const page = mkPage([
      { id: 1, x: 100, y: 200, w: 50 },
      { id: 2, x: 130, y: 200, w: 40 },                 // starts inside the word
    ]);
    const eng = mkEditor([page]);
    expect(eng.lineSpace(page, page.boxes[0])).toBe(600 - 100 - 6);
  });
});

describe("search", () => {
  const doc = () => mkEditor([
    mkPage([{ id: 1, text: "Apple" }, { id: 2, text: "pineapple" }, { id: 3, text: "Orange" }]),
    mkPage([{ id: 4, text: "APPLE" }, { id: 5, text: "apple-pie" }]),
  ]);

  it("matches case-insensitively across pages by default", () => {
    const m = doc().search("apple");
    expect(m.map((x) => x.id)).toEqual([1, 2, 4, 5]);
    expect(m.find((x) => x.id === 4).page).toBe(1);
  });

  it("honours match case", () => {
    expect(doc().search("Apple", { matchCase: true }).map((x) => x.id)).toEqual([1]);
  });

  it("honours whole word — a substring hit is not a word hit", () => {
    // "apple-pie" still matches: the hyphen is a word boundary, "pineapple" isn't
    expect(doc().search("apple", { whole: true }).map((x) => x.id)).toEqual([1, 4, 5]);
  });

  it("treats regex metacharacters as literal text", () => {
    const eng = mkEditor([mkPage([{ id: 1, text: "total (net)" }, { id: 2, text: "totalXnet" }])]);
    expect(eng.search("(net)").map((x) => x.id)).toEqual([1]);
  });

  it("skips erased runs and clears on an empty query", () => {
    const eng = doc();
    eng.pages[0].boxes[0].erased = true;
    expect(eng.search("apple").map((x) => x.id)).toEqual([2, 4, 5]);
    expect(eng.search("  ")).toEqual([]);
  });
});

describe("_replaced", () => {
  it("replaces every occurrence inside a run", () => {
    const eng = mkEditor();
    eng.search("a");
    expect(eng._replaced("banana", "o")).toBe("bonono");
  });

  it("replaces case-insensitively but keeps the rest of the run intact", () => {
    const eng = mkEditor();
    eng.search("apple");
    expect(eng._replaced("APPLE-juice", "Orange")).toBe("Orange-juice");
  });

  it("is a no-op with no active query", () => {
    expect(mkEditor()._replaced("Apple", "Orange")).toBe("Apple");
  });
});

describe("history", () => {
  it("caps the undo stack so ImageData pairs can't grow without bound", () => {
    const eng = mkEditor();
    for (let i = 0; i < 200; i++) eng._pushHistory({ type: "replace", page: 0, boxId: i });
    expect(eng.undoStack.length).toBe(60);
    expect(eng.undoStack[0].boxId).toBe(140);           // oldest entries dropped
    expect(eng.undoStack.at(-1).boxId).toBe(199);
  });

  it("clears the redo stack when a new edit lands", () => {
    const eng = mkEditor();
    eng.redoStack = [{ type: "replace", page: 0 }];
    eng._pushHistory({ type: "replace", page: 0 });
    expect(eng.redoStack).toEqual([]);
  });
});

describe("_styled", () => {
  const box = { fontSize: 11, color: "#222222", bold: true, italic: false, family: "serif", fontName: "Times" };

  it("keeps the detected style when nothing is pinned", () => {
    expect(mkEditor()._styled(box)).toEqual({
      size: 11, color: "#222222", bold: true, italic: false, family: "serif", fontName: "Times",
    });
  });

  it("lets a pinned value win, including falsy ones", () => {
    const eng = mkEditor();
    eng.style = { ...eng.style, size: 20, bold: false };
    const st = eng._styled(box);
    expect(st.size).toBe(20);
    expect(st.bold).toBe(false);                        // false must not fall back to true
    expect(st.color).toBe("#222222");
  });

  it("drops the document's own font name once a family is chosen", () => {
    const eng = mkEditor();
    eng.style = { ...eng.style, family: "mono" };
    expect(eng._styled(box)).toMatchObject({ family: "mono", fontName: null });
  });
});

describe("page reordering", () => {
  let eng;
  beforeEach(() => {
    eng = mkEditor([mkPage([{ id: 1 }]), mkPage([{ id: 2 }]), mkPage([{ id: 3 }])]);
    eng._post = vi.fn().mockResolvedValue({ pages: 2 });
    eng.buildThumbs = vi.fn();
    eng.toast = vi.fn();
  });

  it("reindexes history so undo still points at the right page", async () => {
    eng.undoStack = [{ page: 0, boxId: "a" }, { page: 2, boxId: "c" }];
    eng.redoStack = [{ page: 1, boxId: "b" }];
    await eng._applyOrder([2, 0, 1], "Reorder");        // page 2 moves to the front
    expect(eng.undoStack).toEqual([{ page: 1, boxId: "a" }, { page: 0, boxId: "c" }]);
    expect(eng.redoStack).toEqual([{ page: 2, boxId: "b" }]);
  });

  it("drops the history of a deleted page instead of misapplying it", async () => {
    eng.undoStack = [{ page: 0, boxId: "a" }, { page: 1, boxId: "gone" }, { page: 2, boxId: "c" }];
    await eng._applyOrder([0, 2], "Delete");            // page 1 removed
    expect(eng.undoStack).toEqual([{ page: 0, boxId: "a" }, { page: 1, boxId: "c" }]);
  });

  it("repoints page URLs at their new indices", async () => {
    const [p0, p1, p2] = eng.pages;
    await eng._applyOrder([2, 0, 1], "Reorder");
    expect(eng.pages).toEqual([p2, p0, p1]);
    expect(eng.pages[0].src).toBe("/api/page/sid/0");
    expect(eng.pages[2].thumbSrc).toBe("/api/thumb/sid/2");
  });

  it("remaps the export selection and forgets deleted pages", async () => {
    eng.exportSel = new Set([1, 2]);
    await eng._applyOrder([2, 0], "Delete");            // page 1 deleted, page 2 → index 0
    expect([...eng.exportSel]).toEqual([0]);
  });

  it("leaves everything untouched when the server rejects the change", async () => {
    eng._post = vi.fn().mockRejectedValue(new Error("nope"));
    const before = [...eng.pages];
    eng.undoStack = [{ page: 2, boxId: "c" }];
    expect(await eng._applyOrder([0], "Delete")).toBe(false);
    expect(eng.pages).toEqual(before);
    expect(eng.undoStack).toEqual([{ page: 2, boxId: "c" }]);
  });
});

describe("export selection", () => {
  it("defaults to every page and collapses back to null when all are re-picked", () => {
    const eng = mkEditor([mkPage([]), mkPage([]), mkPage([])]);
    expect(eng._exportIndices()).toEqual([0, 1, 2]);
    eng.toggleExportPage(1);
    expect(eng._exportIndices()).toEqual([0, 2]);
    eng.toggleExportPage(1);
    expect(eng.exportSel).toBe(null);                   // "all" again, not a full Set
  });
});

describe("isNumericRun", () => {
  it("marks the runs people actually blank out on a bill of lading", () => {
    for (const t of ["1000", "#1001", "$25.50", "10", "28.07.2026", "H14629", "A4", "20 pcs"]) {
      expect(isNumericRun(t), t).toBe(true);
    }
  });

  it("leaves plain words alone", () => {
    for (const t of ["Invoice", "Product", "Thank you", "", null, undefined]) {
      expect(isNumericRun(t), String(t)).toBe(false);
    }
  });

  it("counts only the live numbers on the current page", () => {
    const eng = mkEditor([mkPage([
      { id: 1, text: "Invoice" }, { id: 2, text: "#1000" },
      { id: 3, text: "$25.50", erased: true }, { id: 4, text: "10" },
    ])]);
    expect(eng.snapshot().numCount).toBe(2);
    expect(eng.snapshot().count).toBe(3);
  });
});

describe("_findBox", () => {
  it("finds a run on any page and reports which page it is on", () => {
    const eng = mkEditor([mkPage([{ id: 1 }]), mkPage([{ id: 7, text: "x" }])]);
    expect(eng._findBox(7).box.text).toBe("x");
    expect(eng._findBox(7).page).toBe(eng.pages[1]);
    expect(eng._findBox(99)).toBe(null);
  });
});

describe("fontOptions", () => {
  it("leads with the document's own font, so the menu is never blank on it", () => {
    const [first] = fontOptions("ABCDEF+Helvetica-Bold");
    expect(first).toEqual(["font:ABCDEF+Helvetica-Bold", "Helvetica-Bold"]);   // subset prefix stripped
  });

  it("still offers the generic families, and the AI-found fonts after them", () => {
    const opts = fontOptions("Helvetica", [{ font: "Calibri" }, { font: "Georgia" }]);
    expect(opts.map((o) => o[1])).toEqual(["Helvetica", "Sans", "Serif", "Mono", "Calibri", "Georgia"]);
  });

  it("does not list the document's font twice when the AI names it too", () => {
    const opts = fontOptions("Calibri", [{ font: "Calibri" }]);
    expect(opts.filter((o) => o[0] === "font:Calibri")).toHaveLength(1);
  });

  it("falls back to just the families for an OCR run, which has no font name", () => {
    expect(fontOptions(null).map((o) => o[0])).toEqual(["sans", "serif", "mono"]);
  });
});

describe("_layoutBar", () => {
  /* The bar is chrome measured in screen px floating over a page that zooms
     underneath it, so its placement is pure arithmetic worth pinning down. */
  const run = (ctx, { canvasW = 400, intrinsic = 1200, barW = 300, barH = 34 } = {}) => {
    const bar = { offsetWidth: barW, offsetHeight: barH, style: {} };
    const page = { canvas: { clientWidth: canvasW, width: intrinsic } };
    mkEditor()._layoutBar(page, bar, { dx: 0, dy: 0, ...ctx });
    return { left: parseFloat(bar.style.left), top: parseFloat(bar.style.top) };
  };

  it("sits just above the text, scaled to the current zoom", () => {
    // scale = 400/1200 = 1/3, so x=300,y=600 → 100,200 on screen
    expect(run({ x: 300, y: 600, h: 30 })).toEqual({ left: 100, top: 200 - 34 - 8 });
  });

  it("flips below when the text is too near the top to fit above it", () => {
    const { top } = run({ x: 300, y: 30, h: 30 });      // y=30 → 10 on screen
    expect(top).toBe(10 + 30 / 3 + 8);
  });

  it("keeps the bar on the page instead of letting it run off the right edge", () => {
    expect(run({ x: 1150, y: 600, h: 30 }).left).toBe(400 - 300);
  });

  it("centres a bar that is wider than the zoomed-out page rather than crushing it", () => {
    expect(run({ x: 300, y: 600, h: 30 }, { canvasW: 200, barW: 300 }).left).toBe(-50);
  });

  it("follows a dragged editor", () => {
    const narrow = { barW: 100 };                      // wide enough not to clamp
    const a = run({ x: 300, y: 600, h: 30 }, narrow);
    const b = run({ x: 300, y: 600, h: 30, dx: 300, dy: 300 }, narrow);
    expect(b.left - a.left).toBeCloseTo(100, 5);
    expect(b.top - a.top).toBeCloseTo(100, 5);
  });
});

describe("session expiry", () => {
  it("announces a lost session exactly once", () => {
    const toast = vi.fn();
    const eng = new Editor({ onToast: toast });
    eng.markSessionExpired();
    eng.markSessionExpired();
    expect(eng.sessionExpired).toBe(true);
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it("flags expiry from a 404 whose detail mentions the session", async () => {
    const eng = new Editor({});
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false, status: 404,
      clone: () => ({ json: async () => ({ detail: "Session expired — please re-upload." }) }),
    });
    await expect(eng._post("/api/ai-chat", new FormData())).rejects.toThrow(/Session expired/);
    expect(eng.sessionExpired).toBe(true);
  });

  it("leaves the flag alone for an unrelated 404", async () => {
    const eng = new Editor({});
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false, status: 404,
      clone: () => ({ json: async () => ({ detail: "No such page" }) }),
    });
    await expect(eng._post("/api/rotate", new FormData())).rejects.toThrow("No such page");
    expect(eng.sessionExpired).toBe(false);
  });
});
