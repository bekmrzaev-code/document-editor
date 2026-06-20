# BOL Editor — Number Eraser

Upload a PDF (a Bill of Lading or anything else), and the editor renders each
page as an editable image, **detects every number, and lets you click the ones
you want gone**. Each removed number is **truly redacted** by the backend — the
underlying text is deleted and the area is filled with the matching background
color, so it's gone, not just hidden under a box.

A **FastAPI + PyMuPDF** backend does detection, OCR and redaction; a vanilla-JS
frontend (served by the same backend) handles the interactive editing. Files are
processed in memory on your own machine — nothing is persisted to disk.

## Features

- **Click-to-erase** — numbers are auto-detected and highlighted; click to remove.
- **Real redaction** — PyMuPDF removes the text under each region and fills it
  with the sampled background color (not a rasterized cover-up).
- **Digital _and_ scanned PDFs** — detection uses the PDF's real text layer; pages
  with no text fall back to **OCR** (Tesseract) when it's installed on the server.
- **Smart background fill** — samples the dominant color around each number so the
  patch matches. Or switch to a **fixed color** / use the **eyedropper**.
- **Manual box tool** — drag a rectangle over anything detection missed.
- **Undo / redo / reset**, multi-page **thumbnails**, and **zoom**.
- **Export** the cleaned **PDF**, or a quick **PNG** of the current page.

## Architecture

- **`server/`** — FastAPI + PyMuPDF + OpenCV backend (rendering, char-level number
  detection, OCR, scan enhancement, seamless inpaint removal, PDF export).
- **`web/`** — Vite + **React** frontend. A declarative React shell wraps an
  imperative canvas engine (`web/src/engine/Editor.js`) that owns the layered
  canvases, number overlays and thumbnails.

## Running

**Simple (one command, serves the built React app at :8000):**

```bash
cd server
./run.sh            # makes the venv, builds the React UI on first run, starts the server
```

Then open **http://localhost:8000**.

**Dev mode (hot-reload while editing the UI) — two terminals:**

```bash
cd server && ./run.sh                 # backend on :8000
cd web    && npm install && npm run dev   # UI on :5173 (proxies /api → :8000)
```

Open **http://localhost:5173** for the dev server. After changing the UI, rebuild
for the :8000 build with `cd web && npm run build`.

### Optional: OCR for scanned PDFs

OCR is used only when a page has no text layer. Install the Tesseract binary and
it's picked up automatically:

```bash
brew install tesseract        # macOS
```

Without it, scanned pages still work — just cover numbers with the **Box** tool.

## How to use

1. Drop a PDF onto the window (or click **Open PDF**). It's uploaded and analyzed.
2. Highlighted boxes mark detected numbers — blue = pure numbers, amber = tokens
   that contain digits. Click any one to erase it (instant preview).
3. Missed something? Use the **Box** tool to drag over it. Need an exact color?
   Use the **eyedropper** (Pick) or a fixed color.
4. Click **Export PDF** — the backend redacts every erased region and returns the
   cleaned document. (**PNG** exports the current page image.)

### Shortcuts

| Key | Action |
| --- | ------ |
| `E` | Erase tool |
| `B` | Manual box tool |
| `I` | Eyedropper |
| `⌘/Ctrl + Z` | Undo |
| `⌘/Ctrl + ⇧ + Z` | Redo |

## API

| Endpoint | Purpose |
| --- | --- |
| `POST /api/analyze` | multipart PDF → `{ session, pages:[{ image, boxes, … }] }` |
| `POST /api/process` | `{ session, removals, manuals, fillMode, color }` → redacted PDF |
| `GET /api/health` | `{ ok, ocr, sessions }` |

## Tech

- **Backend:** [FastAPI](https://fastapi.tiangolo.com/) ·
  [PyMuPDF](https://pymupdf.readthedocs.io/) (render + text extraction + redaction) ·
  [pytesseract](https://github.com/madmaze/pytesseract) (optional OCR).
- **Frontend:** vanilla JS + [GSAP](https://gsap.com/) for motion.

## Notes

- Sessions live in server memory (the uploaded PDF + detected boxes) and expire
  after 30 minutes; if you get a "session expired" message, just re-upload.
- Pages render at 2× for crisp editing. The instant on-page erase is a preview;
  the exported PDF is the authoritative, server-side redaction.
