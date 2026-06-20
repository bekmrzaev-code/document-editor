# ---------- Stage 1: build the React UI ----------
FROM node:20-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# ---------- Stage 2: Python backend + Tesseract + OpenCV ----------
FROM python:3.11-slim

# System libraries: Tesseract (OCR) and the libs OpenCV/Pillow need at runtime.
RUN apt-get update && apt-get install -y --no-install-recommends \
      tesseract-ocr \
      libglib2.0-0 \
      libgl1 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

# Python deps first (better layer caching)
COPY server/requirements.txt ./server/requirements.txt
RUN pip install -r server/requirements.txt

# Backend code + the built frontend from stage 1
COPY server/ ./server/
COPY --from=web /web/dist ./web/dist

EXPOSE 8000

# Render injects $PORT; bind to it (defaults to 8000 locally).
CMD ["sh", "-c", "uvicorn app:app --app-dir server --host 0.0.0.0 --port ${PORT:-8000}"]
