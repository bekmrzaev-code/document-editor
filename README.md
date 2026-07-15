# DocEdit — AI Document Editor

Open a PDF or image and every piece of text becomes editable. Click any word to
change it in place ("Apple" → "Orange"), or tell the AI what to change in plain
language ("replace every Apple with Orange") and review its proposals before
applying. Erased text is **seamlessly rebuilt from the surrounding background**,
and the exported PDF is flattened so the original text is truly gone.

A **FastAPI + PyMuPDF + OpenCV** backend does text extraction, OCR, seamless
removal and the **Gemini** integration; a **Vite + React** frontend drives an
imperative canvas engine for the interactive editing.

## Features

- **Click-to-edit** — every text run (word) is detected with its style
  (size, color, bold/italic, family) and highlighted; click one, type the
  replacement, Enter. Clear the text — or just **right-click** a word — to
  erase it. Each edit patches only a small region around the word (a few KB
  round trip), so editing stays instant even on large scans.
- **Seamless removal** — the backend reconstructs the background behind the old
  text (flat fill where uniform, row-interpolated fill where it isn't) — the
  result is always crisp, never a blurred patch. Table rules crossing the
  erased area are detected and painted back so the grid stays intact, and
  matched paper grain is blended in on textured scans.
- **Invisible replacements** — a replacement is typeset from the document's
  **own glyphs**: "169"→"770" reuses the page's real 7 and 0, so ink weight,
  blur and paper noise match exactly (it's the original pixels). Characters the
  page never shows fall back to a font — softened to the page's own edge
  blur/noise and baseline slant on scans, or the real font (loaded on demand
  from AI *Find fonts*) on digital pages.
- **Magic erase** — like the phone-gallery object eraser: switch to the erase
  tool (`E`) and drag over anything — a stamp, handwriting, a mark — and it's
  removed seamlessly. Undoable like any edit.
- **Digital _and_ scanned files** — digital PDFs use the real text layer
  (char-level boxes + baseline); scans and images fall back to **Tesseract
  OCR** with estimated styling (dashed boxes).
- **AI Chat** — ask questions about the open document (summary, totals, facts).
- **Fix OCR with Gemini (beta)** — on scanned pages, Gemini vision compares the
  OCR result against the page image and corrects misreads ("2078" → "2026",
  "L8" → "LB") in one click.
- **Digitize (beta)** — rebuild a scan as a NEW PDF that looks like the
  original (lines, stamps, barcodes, signatures stay as background) but carries
  a **real text layer**: every detected word is erased from the image and
  re-inserted as genuine PDF text. The result is searchable, and re-opening it
  in the editor gives precise digital-PDF editing instead of estimated OCR
  boxes. With an AI key set, Gemini checks the OCR before rebuilding.
- **AI Edit** — natural-language editing: describe the change, Gemini returns
  run-level edit proposals (validated against the document to filter
  hallucinations), you review/uncheck and apply. Applied edits go through the
  same erase+draw pipeline as manual edits, so **undo/redo** work everywhere.
- **Viewer** — multi-page thumbnails, zoom at cursor (⌘/Ctrl + wheel), pan,
  dot-grid editing surface.
- **Export** — flattened **PDF** (no recoverable text layer) or a **PNG** of
  the current page. Pages are re-encoded at one uniform JPEG quality and the
  document metadata is stripped, so the whole page reads as a single
  consistent raster (no locally-recompressed patch, neutral producer trail).

## Architecture

- **`server/`** — FastAPI backend.
  - `app.py` — routing, sessions, rate limits, analyze/erase/export, AI endpoints.
  - `extract.py` — word-level text-run extraction with style metadata.
  - `scan.py` — OpenCV: seamless erase, OCR preprocessing, ink-color sampling.
  - `ai_edit.py` — Gemini wrapper (chat + structured edit proposals with a
    model-fallback chain).
- **`web/`** — Vite + React frontend. A declarative shell (`src/App.jsx`,
  `src/AiPanel.jsx`) wraps an imperative canvas engine (`src/engine/Editor.js`)
  that owns the layered canvases (clean/base/anno/composite), overlays and
  thumbnails.

## Running

```bash
cd server
./run.sh            # makes the venv, builds the React UI on first run, starts :8000
```

Then open **http://localhost:8000**.

**Dev mode (hot reload) — two terminals:**

```bash
cd server && ./run.sh                      # backend on :8000
cd web    && npm install && npm run dev    # UI on :5173 (proxies /api → :8000)
```

### AI (optional)

Create `server/.env`:

```
GEMINI_API_KEY=your-key-here
# GEMINI_MODEL=gemini-flash-latest   (default)
```

Without a key the editor works fully — the AI panel just shows as disabled.

### OCR (optional)

```bash
brew install tesseract        # macOS
```

Used only when a page has no text layer. Without it, scanned pages are
view-only.

## API

| Endpoint | Purpose |
| --- | --- |
| `POST /api/analyze` | multipart PDF/image → `{ session, ocrAvailable, aiAvailable, pages:[…] }` with per-run text boxes |
| `GET /api/page/{s}/{i}` | full-resolution page PNG (lazy-loaded) |
| `GET /api/thumb/{s}/{i}` | thumbnail PNG |
| `POST /api/erase` | multipart image + `rects` + `fillMode`/`color` → cleaned PNG |
| `POST /api/ai-chat` | `session`, `question` → `{ answer }` |
| `POST /api/ai-edit` | `session`, `instruction` → `{ edits:[{id, page, oldText, newText}] }` |
| `POST /api/ai-ocr` | `session`, `page` → `{ fixes:[{id, text}] }` (Gemini vision OCR correction) |
| `POST /api/digitize` | `session`, `useAi` → new PDF with a real text layer (download) |
| `POST /api/export` | multipart page PNGs → flattened PDF download |
| `GET /api/health` | `{ ok, ocr, ai, sessions }` |

### Limits & configuration

All overridable via environment variables:

| Env var | Default | Meaning |
| --- | --- | --- |
| `MAX_UPLOAD_BYTES` | `31457280` (30 MB) | max size of a single upload |
| `MAX_PAGES` | `60` | max pages per document |
| `MAX_IMAGE_PIXELS` | `40000000` | Pillow decompression-bomb ceiling |
| `SESSION_TTL` | `3600` (60 min) | idle lifetime of a session |
| `ALLOWED_ORIGINS` | *(empty)* | extra CORS origins if the UI is hosted elsewhere |
| `GEMINI_API_KEY` | *(empty)* | enables the AI panel |
| `GEMINI_MODEL` | `gemini-flash-latest` | primary model (falls back automatically on 404/429/503) |
| `RL_ANALYZE` / `RL_ERASE` / `RL_EXPORT` / `RL_AI` / `RL_DIGITIZE` | `40` / `200` / `40` / `15` / `10` | per-IP requests / minute |

## Shortcuts

| Key | Action |
| --- | ------ |
| Click text | Edit it (Enter saves, Esc cancels) |
| `←` / `→` | Previous / next page |
| `+` / `-` / `0` | Zoom in / out / fit |
| `⌘/Ctrl + wheel` | Zoom at cursor |
| Drag / `Space` + drag | Pan |
| `⌘/Ctrl + Z` / `⌘/Ctrl + ⇧ + Z` | Undo / redo |

## Notes

- Sessions live in server memory and expire after `SESSION_TTL`; on "session
  expired" just re-upload.
- The AI never edits the document directly — it only *proposes* run-level
  edits, which are validated against the document (unknown ids or mismatched
  text are dropped) and applied client-side through the normal editing path.
- **Privacy:** running locally, files are processed in memory on your machine.
  With an AI key set, the document's *extracted text* (not the file) is sent to
  the Gemini API for chat/edit requests. If you deploy this publicly, your
  uploads are processed on that server — don't send sensitive documents to a
  deployment you don't control.
