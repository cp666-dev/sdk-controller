#!/bin/bash
# The three ways to share, driven in headless Chrome against check/share-rig.mjs: a stand-in
# GitHub and a local share service, so nothing real is published. Passes only if each way reaches
# its last step. Needs the private repo's sdk-controller-share folder beside this one.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ADDON="$(dirname "$HERE")"
CLI="$HOME/Library/Application Support/LUNA Builder SDK/dist/cli.js"
source "$HOME/.nvm/nvm.sh" >/dev/null && nvm use 22 >/dev/null
export RIG_DIR="$(mktemp -d)"
trap 'kill $(jobs -p) 2>/dev/null; wait 2>/dev/null; rm -rf "$RIG_DIR"' EXIT
mkdir -p "$RIG_DIR/work/demo/vendor" "$RIG_DIR/data"
printf '{"id":"com.cp.built.demo","title":"demo","html":"index.html","target":"window","width":400,"height":300}' > "$RIG_DIR/work/demo/manifest.json"
printf '<script src="vendor/luna.global.js"></script>' > "$RIG_DIR/work/demo/index.html"
printf 'var Luna={};' > "$RIG_DIR/work/demo/vendor/luna.global.js"
node "$HERE/share-rig.mjs" >/dev/null &
(cd "$ADDON" && exec node "$CLI" serve --port 8790 >/dev/null 2>&1) &
sleep 2
U="http://localhost:8790/?helper=8807"
OPEN="if (typeof session === 'undefined' || !session) return false; if (!window.__o) { window.__o = 1; localStorage.clear(); document.getElementById('share-toggle').click(); return false; } if (document.getElementById('share-body').hidden) return false;"
fail=0
run() { # name, wait body, expected text in the expression's result
  local out
  out=$(node "$CLI" probe "$U" --mock --settle 200 --timeout 40000 --wait "(() => { $OPEN $2 })()" --expr "document.getElementById('share-stepper').textContent + ' / ' + (document.querySelector('.sdc-stepcard:not([hidden]) .sdc-step-h')?.textContent ?? '')" 2>&1 | tail -1)
  if [[ "$out" == *"$3"* ]]; then echo "ok      $1"; else echo "FAILED  $1: $out"; fail=1; fi
}
run "Share it for me" "if (!window.__w) { window.__w = 1; document.querySelector('[data-way=community]').click(); setTimeout(() => { document.getElementById('share-name').value = 'Sam'; document.getElementById('share-agree').checked = true; document.getElementById('share-send').click(); }, 300); return false; } return !document.querySelector('[data-step=done]').hidden;" "2. Shared"
run "Use my GitHub account" "if (!window.__w) { window.__w = 1; document.querySelector('[data-way=github]').click(); setTimeout(() => document.getElementById('share-connect').click(), 300); return false; } if (!document.getElementById('share-connect-done').hidden && !window.__n) { window.__n = 1; document.getElementById('share-connect-next').click(); setTimeout(() => { document.getElementById('share-name').value = 'Sam'; document.getElementById('share-agree').checked = true; document.getElementById('share-send').click(); }, 300); } return document.querySelectorAll('#share-checklist li').length === 4;" "Put it on UA Universe"
run "Help me make a GitHub account" "if (!window.__w) { window.__w = 1; document.querySelector('[data-way=newgithub]').click(); setTimeout(() => { const box = document.getElementById('share-account-done'); box.checked = true; box.dispatchEvent(new Event('change')); document.getElementById('share-account-next').click(); }, 300); return false; } return !document.querySelector('[data-step=connect]').hidden;" "Connect your GitHub account"
[ $fail = 0 ] && echo "SHARE CHECK PASSED" || { echo "SHARE CHECK FAILED"; exit 1; }
