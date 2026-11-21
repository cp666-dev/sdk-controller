#!/bin/bash
# Builds the folder to hand to someone: dist/SDK Controller (and a zip of it), from the branch's
# last commit, not the working tree. Tests and the mock pre-demo check have to pass first.
#   sdk-controller-package/build.sh
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
SDK="$HOME/Library/Application Support/LUNA Builder SDK"
CLI="$SDK/dist/cli.js"
OUT="$REPO/dist"
NAME="SDK Controller"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
source "$HOME/.nvm/nvm.sh" >/dev/null && nvm use 22 >/dev/null

git -C "$REPO" archive feature/sdk-controller | tar -x -C "$WORK"
SRC="$WORK/sdk-controller"
VERSION="$(node -p "require('$SRC/manifest.json').version")"

echo "Testing..."
ln -s "$REPO/sdk-controller/node_modules" "$SRC/node_modules"
(cd "$SRC" && npx vitest run >/dev/null) || { echo "Add On tests failed"; exit 1; }
(cd "$WORK/sdk-controller-helper" && node --test tests/*.test.mjs >/dev/null) || { echo "Helper tests failed"; exit 1; }
"$SRC/check/check.sh" >/dev/null || { echo "Pre-demo check failed"; exit 1; }
rm "$SRC/node_modules"

DEST="$OUT/$NAME"
rm -rf "$DEST" "$OUT/SDK-Controller-$VERSION.zip"
mkdir -p "$DEST/Files"

# The Add On, packed the way LUNA installs it. The folder at the top is named after package_name.
STAGE="$WORK/stage/$NAME"
mkdir -p "$STAGE"
ditto "$SRC" "$STAGE"
rm -rf "$STAGE/check" "$STAGE/tests"
(cd "$WORK/stage" && node "$CLI" pack "$STAGE" --out "$DEST/Files/$NAME.lunaaddon" >/dev/null)

# The builder's helper. The SDK isn't bundled: the installer downloads UA's public release, so
# UA's documentation is never redistributed from here.
mkdir -p "$DEST/Files/helper"
# Every module the helper imports, and its scripts: not its tests.
cp "$WORK/sdk-controller-helper/"*.mjs "$WORK/sdk-controller-helper/"{run.sh,install-login-item.sh,uninstall-login-item.sh} "$DEST/Files/helper/"

cp "$REPO/sdk-controller-package/Install SDK Controller.command" "$REPO/sdk-controller-package/Uninstall SDK Controller.command" "$DEST/"
cp "$REPO/sdk-controller-package/READ ME FIRST.md" "$DEST/"
chmod +x "$DEST/"*.command "$DEST/Files/helper/"*.sh

# The packaged helper has to start on its own, from nothing but what's in the package.
CHECK_PORT=8803
(cd "$DEST/Files/helper" && SDK_CONTROLLER_PORT=$CHECK_PORT SDK_CONTROLLER_WORKSPACE="$WORK/helper-check" node server.mjs >"$WORK/helper-check.log" 2>&1 &)
for _ in $(seq 1 20); do curl -s "http://127.0.0.1:$CHECK_PORT/health" | grep -q '"ok":true' && break; sleep 0.25; done
if ! curl -s "http://127.0.0.1:$CHECK_PORT/health" | grep -q '"ok":true'; then
  cat "$WORK/helper-check.log"; echo "The packaged helper did not start"; exit 1
fi
lsof -nP -iTCP:$CHECK_PORT -sTCP:LISTEN | awk 'NR>1{print $2}' | xargs kill
find "$DEST" -name .DS_Store -delete

(cd "$OUT" && ditto -c -k --norsrc --noextattr --noqtn --keepParent "$NAME" "SDK-Controller-$VERSION.zip")
echo "Built $DEST"
echo "Built $OUT/SDK-Controller-$VERSION.zip ($(du -h "$OUT/SDK-Controller-$VERSION.zip" | cut -f1))"
