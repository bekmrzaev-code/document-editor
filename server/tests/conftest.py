import os
import sys

# Put the server/ dir on the path so `import app` / `import scan` work,
# mirroring how uvicorn runs the app (`--app-dir server`).
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
