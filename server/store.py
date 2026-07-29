"""
Disk-backed session store.

Analyzed documents used to live only in a module-level dict, so a restart (or a
second uvicorn worker) dropped every open document and the UI fell back to
"Session expired — please re-upload" while the user was still editing. Sessions
are now mirrored to SESSION_DIR; the in-memory dict is a cache in front of it,
so a session survives a restart for as long as its TTL.

On-disk layout, one directory per session:

    <SESSION_DIR>/<sid>/meta.json     everything except the image bytes
                       /doc.pdf       the original (or image-wrapped) document
                       /p{i}.png      full-resolution page render
                       /t{i}.png      thumbnail

meta.json is written LAST and is what marks a directory as complete — a session
interrupted mid-write is simply never loaded back.

Set SESSION_PERSIST=0 for the old memory-only behaviour (useful for tests and
for deployments with a read-only filesystem).
"""
from __future__ import annotations

import json
import shutil
import time
from pathlib import Path

# Keys of a page dict that are image bytes — stored as files, not in meta.json.
_BLOBS = ("png", "thumb")


class SessionStore:
    """A dict-like store of analyzed documents, cached in memory, kept on disk.

    A session is ``{"pdf": bytes, "created": float, "pages": [page, …]}`` where
    each page is ``{"png", "thumb", "scale", "boxes", "ptw", "pth", "scanned"}``
    — the same shape the API layer has always used, so callers are unchanged.
    """

    def __init__(self, root: Path, ttl: int, persist: bool = True, max_cached: int = 30):
        self.root = Path(root)
        self.ttl = ttl
        self.persist = persist
        self.max_cached = max_cached
        self._mem: dict[str, dict] = {}
        if self.persist:
            try:
                self.root.mkdir(parents=True, exist_ok=True)
            except OSError:                       # read-only fs → memory only
                self.persist = False

    # ── public API ──────────────────────────────────────────────────────────
    def put(self, sid: str, session: dict) -> None:
        self._mem[sid] = session
        self._write(sid, session)
        self.cleanup()

    def get(self, sid: str) -> dict | None:
        """Fetch a session, loading it back from disk if it fell out of memory.

        Touches ``created`` so an actively-used session keeps renewing its TTL,
        matching how the in-memory version behaved.
        """
        sess = self._mem.get(sid)
        if sess is None:
            sess = self._read(sid)
            if sess is None:
                return None
            self._mem[sid] = sess
            self._evict()
        sess["created"] = time.time()
        return sess

    def save_meta(self, sid: str) -> None:
        """Persist metadata only — for edits that change box text (AI OCR fixes)
        without touching a single pixel."""
        sess = self._mem.get(sid)
        if sess and self.persist:
            self._write_meta(sid, sess)

    def save_page(self, sid: str, index: int) -> None:
        """Rewrite one page's images plus the metadata.

        Rotating a page changes exactly that page; a full put() would rewrite
        every image of a 60-page session for it.
        """
        sess = self._mem.get(sid)
        if not sess or not self.persist or not 0 <= index < len(sess["pages"]):
            return
        p = sess["pages"][index]
        d = self._dir(sid)
        try:
            d.mkdir(parents=True, exist_ok=True)
            (d / f"p{index}.png").write_bytes(p["png"])
            (d / f"t{index}.png").write_bytes(p["thumb"])
            self._write_meta(sid, sess)
        except OSError:
            pass

    def cleanup(self) -> None:
        """Drop expired sessions from memory and from disk."""
        now = time.time()
        for sid in [s for s, v in self._mem.items() if now - v["created"] > self.ttl]:
            self._mem.pop(sid, None)
        self._evict()
        if not self.persist:
            return
        try:
            entries = list(self.root.iterdir())
        except OSError:
            return
        for d in entries:
            meta = d / "meta.json"
            try:
                if d.is_dir() and (not meta.exists() or now - meta.stat().st_mtime > self.ttl):
                    shutil.rmtree(d, ignore_errors=True)
            except OSError:
                pass

    def __len__(self) -> int:
        """Live sessions — cached ones plus any that are only on disk."""
        if not self.persist:
            return len(self._mem)
        try:
            on_disk = {d.name for d in self.root.iterdir() if (d / "meta.json").exists()}
        except OSError:
            on_disk = set()
        return len(on_disk | set(self._mem))

    # ── memory cache ────────────────────────────────────────────────────────
    def _evict(self) -> None:
        """Trim the memory cache to max_cached (oldest first). With persistence
        on this only frees RAM — the session stays loadable from disk."""
        if len(self._mem) <= self.max_cached:
            return
        for sid in sorted(self._mem, key=lambda s: self._mem[s]["created"])[:-self.max_cached]:
            sess = self._mem.pop(sid)
            if not self.persist:                  # memory was the only copy
                continue
            del sess

    # ── disk ────────────────────────────────────────────────────────────────
    def _dir(self, sid: str) -> Path:
        return self.root / sid

    def _write(self, sid: str, session: dict) -> None:
        if not self.persist:
            return
        d = self._dir(sid)
        try:
            d.mkdir(parents=True, exist_ok=True)
            (d / "doc.pdf").write_bytes(session["pdf"])
            for i, p in enumerate(session["pages"]):
                (d / f"p{i}.png").write_bytes(p["png"])
                (d / f"t{i}.png").write_bytes(p["thumb"])
            self._write_meta(sid, session)        # last: marks the dir complete
        except OSError:
            shutil.rmtree(d, ignore_errors=True)  # partial write is worse than none

    def _write_meta(self, sid: str, session: dict) -> None:
        meta = {"created": session["created"],
                "pages": [{k: v for k, v in p.items() if k not in _BLOBS}
                          for p in session["pages"]]}
        try:
            (self._dir(sid) / "meta.json").write_text(json.dumps(meta), encoding="utf-8")
        except OSError:
            pass

    def _read(self, sid: str) -> dict | None:
        if not self.persist or "/" in sid or "\\" in sid or not sid.isalnum():
            return None                           # sid is a uuid4 hex — reject path tricks
        d = self._dir(sid)
        try:
            meta = json.loads((d / "meta.json").read_text(encoding="utf-8"))
            pages = []
            for i, p in enumerate(meta["pages"]):
                p["png"] = (d / f"p{i}.png").read_bytes()
                p["thumb"] = (d / f"t{i}.png").read_bytes()
                pages.append(p)
            return {"pdf": (d / "doc.pdf").read_bytes(), "pages": pages,
                    "created": meta.get("created", time.time())}
        except (OSError, ValueError, KeyError):
            return None
