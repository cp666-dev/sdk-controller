#!/bin/bash
# Publish SDK Controller as a GitHub release, which is what UA Universe lists: the .lunaaddon (LUNA
# installs it from Universe or the Showcase) and the installer zip (the Add On builder, which a
# .lunaaddon can't carry). Builds from the branch's last commit with build.sh, so tests and the
# pre-demo check pass first.
#   sdk-controller-package/release.sh            the repo in SDK_CONTROLLER_REPO, or cp666-dev/sdk-controller
#   sdk-controller-package/release.sh --dry-run  build and say what it would publish
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${SDK_CONTROLLER_REPO:-cp666-dev/sdk-controller}"
"$REPO/sdk-controller-package/build.sh"
VERSION="$(node -p "require('$REPO/sdk-controller/manifest.json').version")"
ADDON="$REPO/dist/SDK Controller/Files/SDK Controller.lunaaddon"
ZIP="$REPO/dist/SDK-Controller-$VERSION.zip"
cp "$ADDON" "$REPO/dist/SDK-Controller.lunaaddon"
echo "Release v$VERSION to $TARGET: SDK-Controller.lunaaddon, $(basename "$ZIP")"
[ "${1:-}" = "--dry-run" ] && { echo "Dry run: nothing published."; exit 0; }
gh release create "v$VERSION" "$REPO/dist/SDK-Controller.lunaaddon" "$ZIP" --repo "$TARGET" \
  --title "SDK Controller $VERSION" \
  --notes "Chat with an AI model inside LUNA to edit your session and build Add Ons. Install from UA Universe, or download $(basename "$ZIP") for the installer with the Add On builder."
