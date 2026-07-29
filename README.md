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

- **Floating format bar** — editing text pops a toolbar right above the caret
  (the way Sejda does it) with the document's own font, size steppers,
  bold/italic, a colour swatch with hex entry, and an **eyedropper** that
  samples a colour straight off the page. A grip on the bar drags the text to a
  new position. Everything previews live in the editor before it is committed.
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
- **Scan language** — pick the language before uploading. Tesseract assumes
  English otherwise, which mangles Cyrillic and the Uzbek oʻ/gʻ digraphs; the
  picker lists whatever packs the server has installed (`GET /api/langs`).
- **Find & Replace** — plain, instant, no AI: the word runs already carry their
  text, so searching is free. Match case / whole word, click a hit to jump to
  it, replace one or all through the same erase+draw path (so undo works).
- **Command palette** — `⌘K` (or the **Commands** button) searches every tool,
  panel and action in one list, with the shortcut for each. Actions that need a
  document stay listed but greyed out, so nothing is invisible.
- **Numbers** — the **Numbers** tool (`N`) puts a blue border round every run
  containing a digit (amounts, quantities, dates, invoice and container
  numbers) and hides everything else; one click wipes a marked run and rebuilds
  the background, with no editor in between. The borders stay visible even with
  *Highlight editable text* switched off. ⌘Z undoes like any edit.
- **Add text** — the **Text** tool (`T`) drops new text anywhere on the page,
  sized to the document's own body text by default.
- **Style overrides** — size, colour, weight and family are auto-detected per
  word, and estimated from pixels on scans. The Style panel pins any of them
  when the guess is wrong; everything defaults to *Auto*.
- **Page operations** — rotate, reorder, delete, and choose which pages the PDF
  export contains. Rotation re-detects the text on the rotated raster, and
  deletions/reorders are mirrored on the server, so Digitize and the AI
  endpoints never work on a stale document.
- **Sessions survive a restart** — analyzed documents are mirrored to disk, so
  a redeploy no longer evicts everyone mid-edit.
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
  - `app.py` — routing, rate limits, analyze/erase/export, page ops, AI endpoints.
  - `store.py` — disk-backed session store (memory cache in front of it).
  - `extract.py` — word-level text-run extraction with style metadata.
  - `scan.py` — OpenCV: seamless erase, OCR preprocessing, ink-color sampling.
  - `ai_edit.py` — Gemini wrapper (chat + structured edit proposals with a
    model-fallback chain).
- **`web/`** — Vite + React frontend. A declarative shell (`src/App.jsx` plus
  the `*Panel.jsx` inspectors) wraps an imperative canvas engine
  (`src/engine/Editor.js`) that owns the layered canvases
  (clean/base/anno/composite), overlays and thumbnails.

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

**Tests:**

```bash
cd server && ./.venv/bin/python -m pytest -q    # backend
cd web    && npm test                            # engine logic (vitest)
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
brew install tesseract tesseract-lang        # macOS: engine + every language pack
```

Used only when a page has no text layer. Without it, scanned pages are
view-only.

**Install the language packs you need** — the engine ships with English only,
and it will happily read a Cyrillic or Uzbek scan *as English*, producing
garbage. The Docker image installs `uzb`, `uzb-cyrl`, `rus`, `tur`, `deu`,
`fra` and `spa`; on Debian/Ubuntu it's `apt install tesseract-ocr-uzb` and
friends. Whatever is installed shows up in the **Scan language** picker on the
upload screen.

## API

| Endpoint | Purpose |
| --- | --- |
| `POST /api/analyze` | multipart PDF/image + `lang` → `{ session, ocrAvailable, aiAvailable, ocrLangs, lang, pages:[…] }` with per-run text boxes |
| `GET /api/page/{s}/{i}` | full-resolution page PNG (lazy-loaded) |
| `GET /api/thumb/{s}/{i}` | thumbnail PNG |
| `POST /api/erase` | multipart image + `rects` + `fillMode`/`color` → cleaned PNG |
| `POST /api/rotate` | `session`, `page`, `deg` → the page re-rendered and re-detected at its new rotation |
| `POST /api/pages` | `session`, `order` (JSON array of kept page indices, in order) → reorders/deletes server-side |
| `POST /api/ai-chat` | `session`, `question` → `{ answer }` |
| `POST /api/ai-edit` | `session`, `instruction` → `{ edits:[{id, page, oldText, newText}] }` |
| `POST /api/ai-ocr` | `session`, `page` → `{ fixes:[{id, text}] }` (Gemini vision OCR correction) |
| `POST /api/ai-fonts` | `session`, `page` → `{ fonts:[{font, style, usage, …}] }` (Gemini vision) |
| `POST /api/digitize` | `session`, `useAi` → new PDF with a real text layer (download) |
| `POST /api/export` | multipart page PNGs → flattened PDF download |
| `POST /api/support` | `message`, `session`, `email`, screenshot/document → `{ ticket }` |
| `GET /api/langs` | `{ langs, default }` — OCR languages installed on this server |
| `GET /api/health` | `{ ok, ocr, ai, langs, sessions }` |

### Limits & configuration

All overridable via environment variables:

| Env var | Default | Meaning |
| --- | --- | --- |
| `MAX_UPLOAD_BYTES` | `31457280` (30 MB) | max size of a single upload |
| `MAX_PAGES` | `60` | max pages per document |
| `MAX_IMAGE_PIXELS` | `40000000` | Pillow decompression-bomb ceiling |
| `SESSION_TTL` | `3600` (60 min) | idle lifetime of a session |
| `SESSION_DIR` | `server/sessions` | where analyzed documents are mirrored |
| `SESSION_PERSIST` | `1` | set `0` for the old memory-only behaviour (read-only filesystems) |
| `OCR_WORKERS` | `min(4, cpus)` | scanned pages OCR'd in parallel during analyze |
| `OCR_LANG` | `eng` | fallback OCR language when the client asks for one that isn't installed |
| `UNICODE_FONT` | *(auto-detected)* | TTF used by digitize for non-ASCII text (DejaVu in the Docker image) |
| `EXPORT_JPEG_Q` | `90` | uniform JPEG quality of exported pages |
| `ALLOWED_ORIGINS` | *(empty)* | extra CORS origins if the UI is hosted elsewhere |
| `GEMINI_API_KEY` | *(empty)* | enables the AI panels (needs `google-genai` installed too) |
| `GEMINI_MODEL` | `gemini-flash-latest` | primary model (falls back automatically on 404/429/503) |
| `SUPPORT_DIR` | `server/support` | where problem reports are written |
| `TELEGRAM_BOT_TOKEN` | *(empty)* | forwards support reports to Telegram |
| `TELEGRAM_CHAT_ID` | *(auto-resolved)* | which chat to forward them to |
| `RL_ANALYZE` / `RL_ERASE` / `RL_EXPORT` / `RL_AI` / `RL_DIGITIZE` / `RL_ROTATE` / `RL_SUPPORT` | `40` / `200` / `40` / `15` / `10` / `60` / `6` | per-IP requests / minute |

## Shortcuts

| Key | Action |
| --- | ------ |
| `⌘/Ctrl + K` | Command palette — every tool and action |
| Click text | Edit it (Enter saves, Esc cancels) |
| `V` / `T` / `N` / `E` / `C` | Edit / Text / Numbers / Erase / Copy tool |
| `⌘/Ctrl + F` | Find & Replace |
| `←` / `→` | Previous / next page |
| `+` / `-` / `0` | Zoom in / out / fit |
| `⌘/Ctrl + wheel` | Zoom at cursor |
| Drag / `Space` + drag | Pan |
| `⌘/Ctrl + Z` / `⌘/Ctrl + ⇧ + Z` | Undo / redo |
| `⌘/Ctrl + O` | Open a file |

## Performance notes

Measured on a 1700×2200 page with 600 detected words:

| | Before | Now |
| --- | --- | --- |
| Digitize (rebuild with a text layer) | 23.3 s | **0.8 s** |
| Analyze a 4-page scan | 7.3 s | **4.6 s** |
| OCR preprocessing, clean page | 350 ms | **20 ms** |
| OCR preprocessing, grainy scan | 350 ms | **171 ms** |
| One erase round trip | 1.9 ms | 1.9 ms |

Where the time went, and why the code looks the way it does:

- `scan._redraw_rules` recomputed a whole-page luminance map for *every* erased
  rect — 37 ms each, and digitize erases every word on the page. The page tone
  is now computed once per `erase()` call and the row/column scans are numpy.
- OCR denoising ran unconditionally at ~350 ms a page. Measured against a
  synthetic page with known words, accuracy was the same with and without it
  (98.6% either way on a clean page, 57.7% vs 56.7% on a grainy one), so it now
  runs only when the paper actually has high-frequency noise — and with a
  search window of 11 rather than 21, which measured identical for a third of
  the cost.
- Scanned pages are OCR'd in a thread pool. Tesseract is a subprocess and
  OpenCV releases the GIL; PyMuPDF is not thread-safe, so rasterizing stays
  serial and only detection is parallel.
- The frontend was measured too and left alone: the heaviest operation on a
  1500-word page is 15 ms, so there was nothing there worth trading complexity
  for.
- `index.html` is served `no-cache` while the fingerprinted `assets/*` are
  `immutable` — otherwise a deploy leaves browsers running the previous build.

## Notes

- Sessions are mirrored to `SESSION_DIR` and expire after `SESSION_TTL` of
  idleness, so a restart no longer drops open documents. If one does expire,
  the editor says so and offers to re-open the file.
- Rotating a page reloads it from the server, which discards the edits made on
  that page — the UI warns first when there are any.
- The AI never edits the document directly — it only *proposes* run-level
  edits, which are validated against the document (unknown ids or mismatched
  text are dropped) and applied client-side through the normal editing path.
- **Privacy:** running locally, files are processed in memory on your machine.
  With an AI key set, the document's *extracted text* (not the file) is sent to
  the Gemini API for chat/edit requests. If you deploy this publicly, your
  uploads are processed on that server — don't send sensitive documents to a
  deployment you don't control.
