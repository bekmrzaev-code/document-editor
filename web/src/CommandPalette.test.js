/* The palette is the one place that knows every action, so its ranking and
 * its enabled/disabled logic decide whether a feature is findable at all. */
import { describe, expect, it, vi } from "vitest";
import { buildCommands, score } from "./CommandPalette.jsx";

describe("score", () => {
  it("prefers an earlier substring hit", () => {
    expect(score("Export PDF", "export")).toBeGreaterThan(score("Quick Export", "export"));
  });

  it("falls back to a subsequence so initials still find a command", () => {
    expect(score("Export PDF", "epdf")).toBeGreaterThan(0);
    expect(score("Export PDF", "zzz")).toBe(-1);
  });

  it("is case-insensitive and treats an empty query as a match", () => {
    expect(score("Rotate page right", "ROTATE")).toBeGreaterThan(0);
    expect(score("anything", "")).toBe(0);
  });
});

const snap = (over = {}) => ({
  hasDoc: true, aiAvailable: true, scanned: true, canUndo: true, canRedo: true,
  showOverlays: true, current: 1, pageCount: 3, ...over,
});

const build = (over) => buildCommands({
  s: snap(over), eng: () => ({}), setTab: () => {}, openFile: () => {},
});

const find = (cmds, label) => cmds.find((c) => c.label.startsWith(label));

describe("buildCommands", () => {
  it("disables document actions until a file is open, but still lists them", () => {
    const cmds = build({ hasDoc: false });
    expect(find(cmds, "Export PDF").enabled).toBe(false);
    expect(find(cmds, "Numbers").enabled).toBe(false);
    // panels and Open stay reachable with no document
    expect(find(cmds, "Open a file").enabled).toBe(true);
    expect(find(cmds, "Find & Replace").enabled).toBe(true);
  });

  it("gates page navigation on where you actually are", () => {
    const first = build({ current: 0 });
    expect(find(first, "Previous page").enabled).toBe(false);
    expect(find(first, "Next page").enabled).toBe(true);
    const last = build({ current: 2 });
    expect(find(last, "Next page").enabled).toBe(false);
  });

  it("offers Fix OCR only on a scanned page with AI configured", () => {
    expect(find(build(), "Fix OCR with AI").enabled).toBe(true);
    expect(find(build({ scanned: false }), "Fix OCR with AI").enabled).toBe(false);
    expect(find(build({ aiAvailable: false }), "Fix OCR with AI").enabled).toBe(false);
  });

  it("won't offer to delete the only page", () => {
    expect(find(build({ pageCount: 1 }), "Delete this page").enabled).toBe(false);
    expect(find(build({ pageCount: 2 }), "Delete this page").enabled).toBe(true);
  });

  it("names the highlight toggle after what it will do", () => {
    expect(find(build({ showOverlays: true }), "Hide text highlights")).toBeTruthy();
    expect(find(build({ showOverlays: false }), "Show text highlights")).toBeTruthy();
  });

  it("routes each command at the right target", () => {
    const eng = { setTool: vi.fn(), undo: vi.fn() };
    const setTab = vi.fn();
    const openFile = vi.fn();
    const cmds = buildCommands({ s: snap(), eng: () => eng, setTab, openFile });
    find(cmds, "Numbers").run();
    expect(eng.setTool).toHaveBeenCalledWith("numbers");
    find(cmds, "Chat").run();
    expect(setTab).toHaveBeenCalledWith("chat");
    find(cmds, "Open a file").run();
    expect(openFile).toHaveBeenCalled();
  });

  it("gives every command a unique id, so the list can key on it", () => {
    const cmds = build();
    expect(new Set(cmds.map((c) => c.id)).size).toBe(cmds.length);
  });
});
