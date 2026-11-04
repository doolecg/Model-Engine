#!/bin/sh
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js was not found on PATH. Install the LTS version from https://nodejs.org then run this again." >&2
  exit 1
fi
if [ ! -d .claude/live/node_modules ]; then
  echo "First run: installing dependencies from npm..."
  npm ci --omit=dev --ignore-scripts --prefix .claude/live || { echo "npm install failed. Check your connection then run this again." >&2; exit 1; }
fi
# exec so an update can replace this file while the server runs
exec node .claude/live/server.js
