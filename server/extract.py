"""
Text-run extraction — word-level pieces of a PDF page's text layer, each with
enough style metadata (size, color, bold/italic, family hint, baseline) for the
frontend to redraw a visually matching replacement.

Coordinates are in PDF points; the API layer scales them to render pixels.
"""
from __future__ import annotations


def _family(font: str) -> str:
    """Coarse family hint so the canvas can pick a similar web-safe font."""
    f = (font or "").lower()
    if "courier" in f or "mono" in f:
        return "mono"
    if "times" in f or "serif" in f or "georgia" in f or "garamond" in f or "bookman" in f:
        return "serif"
    return "sans"


def extract_text_runs(page) -> list[dict]:
    """Group each span's chars into whitespace-separated words. Bounds come from
    the union of the real glyph boxes (so descenders g/y/p aren't clipped), the
    baseline from the first glyph's origin. Returns [] on image-only pages."""
    runs = []
    raw = page.get_text("rawdict")
    for bi, block in enumerate(raw.get("blocks", [])):
        for li, line in enumerate(block.get("lines", [])):
            for span in line.get("spans", []):
                font = span.get("font", "")
                size = span.get("size", 0) or 0
                flags = span.get("flags", 0)
                color = span.get("color", 0)
                style = {
                    "fontSize": size,
                    "color": "#{:06x}".format(color & 0xFFFFFF),
                    "bold": bool(flags & 16) or "bold" in font.lower(),
                    "italic": bool(flags & 2) or "italic" in font.lower() or "oblique" in font.lower(),
                    "family": _family(font),
                    "font": font,          # raw name — the canvas tries it before the fallback
                    "block": bi, "line": li,
                }
                cur = None
                for ch in span.get("chars", []):
                    c = ch.get("c", "")
                    bb = ch.get("bbox")
                    if not bb or c.isspace():
                        if cur and cur["text"]:
                            runs.append(cur)
                        cur = None
                        continue
                    org = ch.get("origin")
                    if cur is None:
                        cur = {"text": "", "rect": list(bb),
                               "base": org[1] if org else bb[3], **style}
                    cur["text"] += c
                    r = cur["rect"]
                    r[0] = min(r[0], bb[0]); r[1] = min(r[1], bb[1])
                    r[2] = max(r[2], bb[2]); r[3] = max(r[3], bb[3])
                if cur and cur["text"]:
                    runs.append(cur)
    return runs
