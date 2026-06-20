# Deploying to Render

This app needs **Tesseract** (OCR) and **OpenCV** system libraries, so it deploys
as a **Docker** web service. The included `Dockerfile` builds the React UI and runs
the FastAPI backend, which serves both the API and the UI from one URL.

## Option A — Blueprint (one click, uses `render.yaml`)

1. Push this repo to GitHub (already done: `bekmrzaev-code/document-editor`).
2. In Render: **New ▸ Blueprint** → connect the repo → Render reads `render.yaml`
   and creates the service. Click **Apply**.

## Option B — Create the Web Service manually

In the Render dashboard: **New ▸ Web Service** → connect the GitHub repo, then set:

| Setting | Value |
| --- | --- |
| **Language / Runtime** | `Docker` |
| **Branch** | `main` |
| **Dockerfile Path** | `./Dockerfile` |
| **Docker Build Context Directory** | `.` |
| **Region** | Frankfurt (closest to Central Asia) |
| **Instance Type** | Free (or Starter for more RAM) |
| **Health Check Path** | `/api/health` |
| **Build Command** | *(leave empty — Docker handles it)* |
| **Start Command** | *(leave empty — set by the Dockerfile)* |

### Environment variables

None are required. `PORT` is injected by Render automatically and the app binds to
it. Optionally add:

| Key | Value |
| --- | --- |
| `PYTHONUNBUFFERED` | `1` |

You do **not** set a port yourself, and you do **not** need an API base URL — the
frontend calls `/api/...` on the same origin that serves it.

## After deploy

- Your app will be at `https://document-editor-XXXX.onrender.com` (Render assigns it).
- Health check: `GET /api/health` → `{"ok": true, "ocr": true, ...}` (confirms OCR works).

## Notes / limits on the Free plan

- **RAM is 512 MB.** Rendering + OCR + inpaint on large/high-page PDFs can exceed it.
  If you hit out-of-memory errors, upgrade to a Starter instance.
- **The service spins down after ~15 min idle**, so the first request after a pause
  takes ~30–60 s to wake up.
- **Sessions are in memory** and reset whenever the service restarts/redeploys — fine
  for one-off edits; re-upload if you get a "session expired" message.

## Test the image locally (optional)

```bash
docker build -t document-editor .
docker run -p 8000:8000 document-editor
# open http://localhost:8000
```
