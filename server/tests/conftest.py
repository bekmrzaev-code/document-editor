import os
import sys

# Put the server/ dir on the path so `import app` / `import scan` work,
# mirroring how uvicorn runs the app (`--app-dir server`).
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

# Keep the default test run from writing session directories into the repo;
# the persistence tests build their own SessionStore over a tmp_path.
os.environ.setdefault("SESSION_PERSIST", "0")
