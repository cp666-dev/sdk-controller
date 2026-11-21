#!/bin/bash
# Pre-demo check. Drives the real panel, in headless Chrome, through every session tool with a
# scripted stand-in for the model, approving each GO card, and prints each step's result.
#   check/check.sh            against Luna.MockEngine, no LUNA needed
#   check/check.sh --read-only  against the running LUNA's focused session, reading only
#   check/check.sh --live     against the running LUNA's focused session. Use a scratch session:
#                             it adds and then deletes "SDC Check" tracks, a bus and a marker, and
#                             leaves a tempo change at bar 9, a 3/4 bar at 13 and four chords.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ADDON="$(dirname "$HERE")"
CLI="$HOME/Library/Application Support/LUNA Builder SDK/dist/cli.js"
source "$HOME/.nvm/nvm.sh" >/dev/null && nvm use 22 >/dev/null
WORK="$(mktemp -d)"
trap 'kill $(jobs -p) 2>/dev/null; wait 2>/dev/null; rm -rf "$WORK"' EXIT

MOCK=(--mock "$WORK/fixture.js")
if [ "${1:-}" = "--live" ] || [ "${1:-}" = "--read-only" ]; then
  MOCK=()
  [ "${1:-}" = "--read-only" ] && export CHECK_READ_ONLY=1
else
  cat > "$WORK/fixture.js" <<JS
globalThis.LunaMockSetup = (engine) => {
  engine.addSession('check', { name: '${CHECK_FIXTURE_NAME:-Check}', tracks: ['Vocal', 'Bass'] });
  engine.addPlugin('com.uaudio.uadx.pultec', { name: 'Pultec EQP-1A', categories: ['EQ'] });
};
JS
fi

node "$HERE/scripted-model.mjs" >/dev/null &
(cd "$ADDON" && node "$CLI" serve --port 8799 >/dev/null 2>&1) &
sleep 2

# The check edits the session, so it refuses one that has tracks unless its name says it's a
# scratch: in every mode, so this guard is itself tested against the mock.
GUARD="session.visibleTracks.length > 0 && !/scratch|check|test/i.test(session.name.value ?? '')"
[ -n "${CHECK_READ_ONLY:-}" ] && GUARD="false"
WAIT="(() => {
  if (typeof session === 'undefined' || !session) return false;
  // Judge the session only once it has loaded: before that its track list is empty.
  if (!window.__loading) { window.__loading = true; session.ready().then(() => Promise.all(session.tracks.items.map((t) => t.load?.()))).then(() => { window.__loaded = true; }); }
  if (!window.__loaded) return false;
  if (!window.__started && ($GUARD)) { window.__refused = true; return true; }
  if (!window.__started) {
    window.__started = true;
    const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('change')); };
    if (document.getElementById('settings').hidden) document.getElementById('settings-toggle').click();
    set('provider', 'compatible');
    setTimeout(() => {
      set('base-url', 'http://127.0.0.1:8798/v1'); set('model-custom', 'scripted');
      document.getElementById('settings-toggle').click();
      document.getElementById('prompt').value = 'Run the check.';
      document.getElementById('composer').requestSubmit();
    }, 100);
    return false;
  }
  if (!document.getElementById('approval').hidden) { document.getElementById('approve').click(); return false; }
  return window.__started && !agent.running && document.getElementById('log').innerText.includes('CHECK COMPLETE');
})()"
EXPR="window.__refused ? 'REFUSED: the open session has tracks and is not named scratch, check or test.' : [...document.querySelectorAll('.sdc-tool')].map((r) => (r.classList.contains('ok') ? 'ok    ' : 'FAILED') + ' ' + r.textContent)"

# A run that did nothing must not pass: every step has to have run and come back ok.
if ! node "$CLI" probe http://localhost:8799/ ${MOCK[@]+"${MOCK[@]}"} --wait "$WAIT" --expr "$EXPR" --settle 300 --timeout 180000 > "$WORK/out.txt"; then
  cat "$WORK/out.txt"; echo "CHECK FAILED: the panel did not finish"; exit 1
fi
cat "$WORK/out.txt"
if grep -q REFUSED "$WORK/out.txt"; then echo "CHECK REFUSED: nothing was changed"; exit 1; fi
ran=$(grep -c '"ok ' "$WORK/out.txt" || true)
expected=$(curl -s http://127.0.0.1:8798/steps)
if grep -q FAILED "$WORK/out.txt" || [ "$ran" != "$expected" ]; then echo "CHECK FAILED: $ran of $expected steps ok"; exit 1; fi
echo "CHECK PASSED: $ran of $expected steps ok"
