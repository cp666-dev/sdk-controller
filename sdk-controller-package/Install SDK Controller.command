#!/bin/bash
# Installs SDK Controller into LUNA, and optionally the Add On builder. Safe to run again.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
FILES="$HERE/Files"
ADDONS="${UA_ADDONS_FOLDER:-/Library/Application Support/Universal Audio/LUNA/Add Ons}"
APP_SUPPORT="${SDC_APP_SUPPORT:-$HOME/Library/Application Support}"
HELPER_DIR="$APP_SUPPORT/SDK Controller/helper"
OWN_SDK="$APP_SUPPORT/LUNA Builder SDK"
SDK_DIR="$APP_SUPPORT/SDK Controller/luna-builder-sdk"
TARGET="$ADDONS/SDK Controller"

say() { printf '\n%s\n' "$*"; }
fail() { say "Stopped: $*"; say "Nothing else was changed. Press Return to close."; read -r _; exit 1; }
ask() { printf '\n%s [y/n] ' "$1"; read -r a; [[ "$a" =~ ^[Yy] ]]; }

clear
echo "SDK Controller installer"
echo "========================"

# 1. LUNA 3.1.1 or later.
LUNA_APP="${SDC_LUNA_APP:-/Applications/LUNA.app}"
[ -d "$LUNA_APP" ] || fail "LUNA isn't in your Applications folder. Install LUNA 3.1.1 or later first."
v="$(plutil -extract CFBundleShortVersionString raw "$LUNA_APP/Contents/Info.plist" 2>/dev/null || echo 0)"
if [ "$(printf '%s\n3.1.1\n' "$v" | sort -V | head -1)" != "3.1.1" ]; then
  fail "SDK Controller needs LUNA 3.1.1 or later, and you have $v. Update LUNA in UA Connect first."
fi
echo "LUNA $v: OK"

# 2. The Add On.
if [ -L "$TARGET" ]; then
  fail "\"$TARGET\" is a link to a developer copy. Remove it yourself if you want this version."
fi
if [ -d "$TARGET" ] && ! grep -q '"com.cp.sdkcontroller"' "$TARGET/manifest.json" 2>/dev/null; then
  fail "\"$TARGET\" exists and isn't SDK Controller, so it was left alone."
fi
mkdir -p "$ADDONS" 2>/dev/null
if [ -w "$ADDONS" ]; then
  rm -rf "$TARGET"
  ditto -x -k "$FILES/SDK Controller.lunaaddon" "$ADDONS" || fail "Couldn't unpack the Add On."
  echo "Add On: installed"
else
  say "Your Add Ons folder needs LUNA to install into it, so LUNA will open the Add On file now."
  open -a "$LUNA_APP" "$FILES/SDK Controller.lunaaddon" || fail "LUNA couldn't open the Add On file."
  say "If LUNA asks, allow the install."
fi

# 3. The Add On builder (optional).
say "SDK Controller can also build new Add Ons for you. That needs Node.js and a small helper that
starts when you log in. Session edits work without it."
if ask "Set up the Add On builder?"; then
  NODE=""
  for n in "$(command -v node || true)" $(ls -d "$HOME"/.nvm/versions/node/v*/bin/node 2>/dev/null | sort -rV) /opt/homebrew/bin/node /usr/local/bin/node; do
    if [ -x "$n" ] && [ "$("$n" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge 22 ]; then NODE="$n"; break; fi
  done
  if [ -z "$NODE" ]; then
    say "The builder needs Node.js 22 or later, which isn't on this Mac. Install the LTS version from
nodejs.org, then run this installer again. SDK Controller itself is already installed."
    ask "Open nodejs.org now?" && open "https://nodejs.org/en/download"
  else
    echo "Node $("$NODE" --version): OK"
    # The builder makes Add Ons with UA's LUNA Builder SDK. Use the user's own if they have one,
    # else download UA's latest public release: its ready-built plugin folder, plus the
    # repository's docs (the overview and API reference the builder reads).
    if [ -f "$OWN_SDK/dist/cli.js" ]; then
      echo "LUNA Builder SDK: using yours"
    else
      say "Downloading the LUNA Builder SDK from Universal Audio (github.com/uaudio-labs/luna-builder-sdk)..."
      TAG="$(curl -fsSL -m 30 https://api.github.com/repos/uaudio-labs/luna-builder-sdk/releases/latest | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1)"
      TAG="${TAG:-v3.1.2}"
      TMP="$(mktemp -d)"
      curl -fsSL -m 300 -o "$TMP/sdk.tgz" "https://codeload.github.com/uaudio-labs/luna-builder-sdk/tar.gz/refs/tags/$TAG" || fail "Couldn't download the LUNA Builder SDK. Check your internet connection and run this again."
      mkdir -p "$TMP/src" && tar -xzf "$TMP/sdk.tgz" -C "$TMP/src" --strip-components=1 || fail "Couldn't unpack the LUNA Builder SDK."
      [ -f "$TMP/src/plugins/ua-luna-builder/sdk/cli.js" ] || fail "The LUNA Builder SDK download wasn't the shape expected."
      rm -rf "$SDK_DIR"; mkdir -p "$SDK_DIR"
      ditto "$TMP/src/plugins/ua-luna-builder" "$SDK_DIR"
      ditto "$TMP/src/docs" "$SDK_DIR/docs"
      rm -rf "$TMP"
      echo "LUNA Builder SDK $TAG: installed"
    fi
    mkdir -p "$HELPER_DIR"
    cp "$FILES/helper/"* "$HELPER_DIR/"
    chmod +x "$HELPER_DIR/"*.sh
    if [ -n "${SDC_NO_LOGIN_ITEM:-}" ]; then
      echo "Helper: copied (login item skipped)"
    else
      "$HELPER_DIR/install-login-item.sh" >/dev/null || fail "Couldn't start the helper."
      ok=""
      for _ in $(seq 1 20); do
        curl -s -H 'origin: ua-content://com.cp.sdkcontroller' http://127.0.0.1:8795/health | grep -q '"ok":true' && { ok=1; break; }
        sleep 0.5
      done
      [ -n "$ok" ] || fail "The helper didn't start. Its log is in ~/Library/Logs/SDK Controller."
      echo "Helper: running, and starts when you log in"
    fi
  fi
fi

say "Done. In LUNA, open Add Ons > Windows > SDK Controller, open Settings, press GET A FREE KEY
(or choose another provider) and paste your key. Press Return to close."
read -r _
