#!/bin/bash
# Start the SDK Controller helper (foreground). Used directly and by the login item.
set -euo pipefail
cd "$(dirname "$0")"
# Node 22 or later, looked up at every start so a Node upgrade never strands the login item:
# the one on PATH, else the newest nvm one, else Homebrew's.
for n in "$(command -v node || true)" $(ls -d "$HOME"/.nvm/versions/node/v*/bin/node 2>/dev/null | sort -rV) /opt/homebrew/bin/node /usr/local/bin/node; do
  if [ -x "$n" ] && [ "$("$n" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge 22 ]; then
    export PATH="$(dirname "$n"):$PATH" # npm for /scaffold and /test
    exec "$n" server.mjs "$@"
  fi
done
echo "run.sh: Node 22 or later not found" >&2
exit 1
