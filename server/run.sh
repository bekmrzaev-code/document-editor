#!/usr/bin/env bash
# One-command launcher: sets up the Python venv, builds the React UI (first run),
# and starts the server. http://localhost:8000 serves the app + API.
set -e
cd "$(dirname "$0")"

if [ ! -d .venv ]; then
  echo "Creating virtualenv…"
  python3 -m venv .venv
fi
./.venv/bin/python -m pip install -q --upgrade pip
./.venv/bin/python -m pip install -q -r requirements.txt

# Build the React UI if it hasn't been built yet (so :8000 serves it).
if [ ! -f ../web/dist/index.html ] && command -v npm >/dev/null 2>&1; then
  echo "Building React UI (first run)…"
  ( cd ../web && npm install --no-audit --no-fund --silent && npm run build ) || echo "  (web build skipped — run it manually in ./web)"
fi

echo ""
echo "  BOL Studio →  http://localhost:8000"
echo ""
exec ./.venv/bin/uvicorn app:app --reload --port 8000
