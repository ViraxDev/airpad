#!/usr/bin/env bash
# Run AirPad: create the Python environment on first run, then start the server.
set -e
cd "$(dirname "$0")"

VENV=".venv"

if [ ! -d "$VENV" ]; then
  echo "→ Creating the Python environment (first run)…"
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install --quiet --upgrade pip
  "$VENV/bin/pip" install --quiet -r requirements.txt
  echo "→ Done."
fi

exec "$VENV/bin/python" server.py
