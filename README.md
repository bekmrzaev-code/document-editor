# BOL Editor — Number Eraser

Open a PDF or image (a Bill of Lading or anything else) and the editor renders each
page as an editable canvas, **detects every number, and lets you click the ones you
want gone**. Each erased region is **seamlessly rebuilt from the surrounding
background** so the number is removed, not just hidden under a box. On export the
page is flattened to an image, so the exported PDF carries **no recoverable text
layer** — the numbers are truly gone.

A **FastAPI + PyMuPDF + OpenCV** backend does detection, OCR, enhancement and
seamless removal; a **Vite + React** frontend (served by the same backend) drives
an imperative canvas engine for the interactive editing.

## Features

- **Click-to-erase** — numbers are auto-detected and highlighted; click to remove.
- **Seamless removal** — the backend reconstructs the background behind each region
  (flat fill where the background is uniform, inpaint where it's textured), or you
  can choose a **fixed color** / use the **eyedropper**.
- **Digital _and_ scanned files** — detection uses the PDF's real text layer; pages
  with no text fall back to **OCR** (Tesseract) when it's installed on the server.
- **Enhance (CamScanner-style)** — Auto / Magic / Gray / B&W filters plus
  brightness, contrast, sharpen, deskew and auto-crop.
- **Cover tool** — drag a rectangle over anything detection missed.
- **Brush** — pen / marker / highlighter with adjustable size, color and opacity.
- **Undo / redo / reset**, multi-page **thumbnails**, and **zoom** (⌘/Ctrl + wheel).
- **Export** the edited **PDF**, or a quick **PNG** of the current page.

## Architecture

- **`server/`** — FastAPI backend. `app.py` (routing, char-level number detection,
  OCR, session store) + `scan.py` (OpenCV enhancement, seamless removal, OCR
  preprocessing).
- **`web/`** — Vite + **React** frontend. A declarative React shell
  (`web/src/App.jsx`) wraps an imperative canvas engine
  (`web/src/engine/Editor.js`) that owns the layered canvases, number overlays and
  thumbnails.

## Running

**Simple (one command, serves the built React app at :8000):**

```bash
cd server
./run.sh            # makes the venv, builds the React UI on first run, starts the server
```

Then open **http://localhost:8000**.

**Dev mode (hot-reload while editing the UI) — two terminals:**

```bash
cd server && ./run.sh                      # backend on :8000
cd web    && npm install && npm run dev     # UI on :5173 (proxies /api → :8000)
```

Open **http://localhost:5173** for the dev server. After changing the UI, rebuild
for the :8000 build with `cd web && npm run build`.

### Optional: OCR for scanned files

OCR is used only when a page has no text layer. Install the Tesseract binary and
it's picked up automatically:

```bash
brew install tesseract        # macOS
```

Without it, scanned pages still work — just cover numbers with the **Cover** tool.

## How to use

1. Drop a PDF or image onto the window (or click **Open**). It's uploaded and analyzed.
2. Highlighted boxes mark detected numbers — blue = pure numbers, amber = tokens
   that contain digits. Click any one to erase it (instant preview).
3. Missed something? Use the **Cover** tool to drag over it. Need an exact color?
   Use the **eyedropper** or a **Fixed** color in the Fill panel.
4. Click **Export PDF** — the edited pages are flattened and returned as a single
   PDF. (**PNG** exports the current page image.)

### Shortcuts

| Key | Action |
| --- | ------ |
| `E` | Erase tool |
| `C` | Cover tool |
| `B` | Brush tool |
| `Space` (hold) | Pan |
| `+` / `-` / `0` | Zoom in / out / fit |
| `⌘/Ctrl + wheel` | Zoom at cursor |
| `⌘/Ctrl + Z` | Undo |
| `⌘/Ctrl + ⇧ + Z` | Redo |

## API

| Endpoint | Purpose |
| --- | --- |
| `POST /api/analyze` | multipart PDF/image → `{ session, ocrAvailable, pages:[…] }` |
| `GET /api/page/{s}/{i}` | full-resolution page PNG (lazy-loaded) |
| `GET /api/thumb/{s}/{i}` | thumbnail PNG |
| `POST /api/enhance` | `{ session, page, mode, brightness, … }` → enhanced page PNG |
| `POST /api/inpaint` | multipart image + `rects` + `fillMode`/`color` → cleaned PNG |
| `POST /api/export` | multipart page PNGs → flattened PDF download |
| `GET /api/health` | `{ ok, ocr, sessions }` |

### Limits & configuration

Abuse guards keep the app open to everyone while stopping a script from exhausting
the box. All are overridable via environment variables:

| Env var | Default | Meaning |
| --- | --- | --- |
| `MAX_UPLOAD_BYTES` | `31457280` (30 MB) | max size of a single upload |
| `MAX_PAGES` | `60` | max pages per document |
| `MAX_IMAGE_PIXELS` | `40000000` | Pillow decompression-bomb ceiling |
| `SESSION_TTL` | `3600` (60 min) | idle lifetime of a session |
| `ALLOWED_ORIGINS` | *(empty)* | extra CORS origins if you host the UI elsewhere |
| `RL_ANALYZE` / `RL_INPAINT` / `RL_ENHANCE` / `RL_EXPORT` | `40` / `200` / `200` / `40` | per-IP requests / minute |

## Tech

- **Backend:** [FastAPI](https://fastapi.tiangolo.com/) ·
  [PyMuPDF](https://pymupdf.readthedocs.io/) (render + text extraction) ·
  [OpenCV](https://opencv.org/) (enhancement + seamless removal) ·
  [pytesseract](https://github.com/madmaze/pytesseract) (optional OCR).
- **Frontend:** [Vite](https://vitejs.dev/) + [React](https://react.dev/) +
  [GSAP](https://gsap.com/) for motion.

## Notes

- Sessions live in server memory (the uploaded doc + detected boxes) and expire
  after `SESSION_TTL`; if you get a "session expired" message, just re-upload.
- Pages render at up to 2× for crisp editing. The on-page erase is an instant
  preview; the server-side rebuild follows a moment later.
- **Privacy:** running locally, files are processed entirely in memory on your own
  machine and never written to disk. If you **deploy** this (e.g. to Render), your
  uploads are processed on that server instead — don't send sensitive documents to
  a shared/public deployment you don't control.
