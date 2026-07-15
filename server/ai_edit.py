"""
Gemini wrapper — document Q&A (chat) and, later, structured edit proposals.

The API key comes from the GEMINI_API_KEY env var (server/.env is loaded by
app.py). All functions raise AiUnavailable when no key is configured and
AiError when the upstream request fails, so the API layer can map them to
clean HTTP statuses.
"""
from __future__ import annotations

import json
import os

MODEL = os.environ.get("GEMINI_MODEL", "gemini-flash-latest")
# Tried in order when the primary model is overloaded/retired (404/429/503).
_FALLBACK_MODELS = [MODEL, "gemini-3-flash-preview", "gemini-2.0-flash", "gemini-flash-lite-latest"]
_RETRIABLE = ("404", "429", "503", "NOT_FOUND", "RESOURCE_EXHAUSTED", "UNAVAILABLE")


class AiUnavailable(Exception):
    """No API key configured — the AI features are switched off."""


class AiError(Exception):
    """The upstream Gemini request failed."""


_client = None


def available() -> bool:
    return bool(os.environ.get("GEMINI_API_KEY"))


def _get_client():
    global _client
    key = os.environ.get("GEMINI_API_KEY")
    if not key:
        raise AiUnavailable("GEMINI_API_KEY is not set on the server.")
    if _client is None:
        from google import genai
        _client = genai.Client(api_key=key)
    return _client


_CHAT_PROMPT = """\
You are a document assistant inside a PDF editor. The user has opened a document;
its extracted text is below (word order follows the page layout, so minor
spacing artifacts are possible). Answer the user's question about the document
concisely and factually. Answer in the same language as the question.

--- DOCUMENT TEXT ---
{doc}
--- END DOCUMENT ---

Question: {question}"""


def _generate(contents, **kwargs):
    """generate_content with a model-fallback chain for transient failures."""
    client = _get_client()
    last = None
    for model in dict.fromkeys(_FALLBACK_MODELS):
        try:
            return client.models.generate_content(model=model, contents=contents, **kwargs)
        except Exception as e:  # overloaded / retired model → try the next one
            last = e
            if any(code in str(e) for code in _RETRIABLE):
                continue
            raise AiError(f"AI request failed: {e}")
    raise AiError(f"AI request failed: {last}")


def chat(question: str, doc_text: str) -> str:
    resp = _generate(_CHAT_PROMPT.format(doc=doc_text, question=question))
    return (resp.text or "").strip() or "(empty answer)"


# ── Font identification (vision) ─────────────────────────────────────────────
_FONTS_PROMPT = """\
You are a typography expert examining a document page image. Identify each
DISTINCT text style on the page. For every style return:
- font: the CLOSEST widely available font family (e.g. Arial, Helvetica,
  Times New Roman, Georgia, Courier New, Calibri, Verdana, Futura, Garamond).
  Never invent obscure or exotic names — pick the nearest common match.
- style: one of: regular, bold, italic, bold italic
- approxSizePt: approximate point size (an A4 page is ~842 pt tall)
- usage: a short phrase saying where the style is used (title, table headers,
  body text, labels, footer, …)
- examples: 2-4 words from the page printed in this style, EXACTLY as written
Order the styles from most-used to least-used and merge near-identical ones."""

_FONTS_SCHEMA = {
    "type": "object",
    "properties": {
        "fonts": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "font": {"type": "string"},
                    "style": {"type": "string"},
                    "approxSizePt": {"type": "integer"},
                    "usage": {"type": "string"},
                    "examples": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["font", "style", "usage"],
            },
        }
    },
    "required": ["fonts"],
}


def identify_fonts(image_png: bytes) -> list[dict]:
    """Ask Gemini (vision) to name the fonts used on a page image. Returns
    [{font, style, approxSizePt?, usage, examples?}] ordered by prevalence."""
    from google.genai import types
    resp = _generate(
        [types.Part.from_bytes(data=image_png, mime_type="image/png"), _FONTS_PROMPT],
        config={"response_mime_type": "application/json", "response_schema": _FONTS_SCHEMA},
    )
    try:
        data = json.loads(resp.text or "{}")
    except json.JSONDecodeError:
        raise AiError("AI returned malformed JSON")
    fonts = data.get("fonts")
    if not isinstance(fonts, list):
        raise AiError("AI response missing 'fonts'")
    return fonts


# ── Structured edit proposals ────────────────────────────────────────────────
_EDIT_PROMPT = """\
You are the edit engine of a PDF editor. The document's text runs are listed
below, one per line, in the form:  id | page | text
A "run" is one word/token as it appears on the page.

The user's instruction: {instruction}

Decide which runs must change to satisfy the instruction. Rules:
- Return ONLY runs that actually need to change (id + exact current text as
  oldText + the replacement as newText).
- newText replaces the run's ENTIRE text. Use "" (empty) to delete the run.
- Do not invent ids and do not change oldText — copy it exactly from the list.
- If the instruction changes a multi-word phrase, emit one edit per run.
- If nothing matches the instruction, return an empty list.

--- TEXT RUNS ---
{runs}
--- END RUNS ---"""

_EDIT_SCHEMA = {
    "type": "object",
    "properties": {
        "edits": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "integer"},
                    "oldText": {"type": "string"},
                    "newText": {"type": "string"},
                },
                "required": ["id", "oldText", "newText"],
            },
        }
    },
    "required": ["edits"],
}


# ── Vision OCR correction ────────────────────────────────────────────────────
_OCR_FIX_PROMPT = """\
The image is a scanned document page. Below is the OCR extraction — one word
per line, in the form:  id | text
Some words may be misread (e.g. "2078" instead of "2026", "L8" instead of
"LB"). Compare each word against what is actually printed in the image and
return ONLY the entries whose text is wrong, with the exact text visible in
the image. Rules:
- Keep the ids; never invent new ids.
- Fix misreads only — do not rephrase, translate or "improve" anything.
- Preserve case, digits and punctuation exactly as printed.
- If everything is correct, return an empty list.

--- OCR WORDS ---
{words}
--- END WORDS ---"""

_OCR_FIX_SCHEMA = {
    "type": "object",
    "properties": {
        "fixes": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "integer"},
                    "text": {"type": "string"},
                },
                "required": ["id", "text"],
            },
        }
    },
    "required": ["fixes"],
}


def fix_ocr(image_png: bytes, words: list[dict]) -> list[dict]:
    """Ask Gemini (vision) to correct OCR misreads on a page image.
    ``words`` is [{id, text}]; returns the raw fixes [{id, text}] — the caller
    validates ids against the session."""
    from google.genai import types
    lines = "\n".join(f'{w["id"]} | {w["text"]}' for w in words)
    resp = _generate(
        [types.Part.from_bytes(data=image_png, mime_type="image/png"),
         _OCR_FIX_PROMPT.format(words=lines)],
        config={"response_mime_type": "application/json", "response_schema": _OCR_FIX_SCHEMA},
    )
    try:
        data = json.loads(resp.text or "{}")
    except json.JSONDecodeError:
        raise AiError("AI returned malformed JSON")
    fixes = data.get("fixes")
    if not isinstance(fixes, list):
        raise AiError("AI response missing 'fixes'")
    return fixes


def propose_edits(instruction: str, runs: list[dict]) -> list[dict]:
    """Ask Gemini for structured edits over the given runs
    ([{id, page, text}]). Returns the raw proposals [{id, oldText, newText}];
    the caller is responsible for validating them against the session."""
    lines = "\n".join(f'{r["id"]} | {r["page"]} | {r["text"]}' for r in runs)
    resp = _generate(
        _EDIT_PROMPT.format(instruction=instruction, runs=lines),
        config={"response_mime_type": "application/json", "response_schema": _EDIT_SCHEMA},
    )
    try:
        data = json.loads(resp.text or "{}")
    except json.JSONDecodeError:
        raise AiError("AI returned malformed JSON")
    edits = data.get("edits")
    if not isinstance(edits, list):
        raise AiError("AI response missing 'edits'")
    return edits
