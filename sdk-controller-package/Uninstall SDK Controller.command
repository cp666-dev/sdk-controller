#!/bin/bash
# Removes SDK Controller, its helper and its login item. Leaves the LUNA Builder SDK, Add Ons you
# built, and your API key in the keychain, and says how to remove those.
set -uo pipefail
ADDONS="${UA_ADDONS_FOLDER:-/Library/Application Support/Universal Audio/LUNA/Add Ons}"
APP_SUPPORT="${SDC_APP_SUPPORT:-$HOME/Library/Application Support}"
TARGET="$ADDONS/SDK Controller"
clear
echo "SDK Controller uninstaller"
echo "=========================="
if [ -L "$TARGET" ]; then
  echo "\"$TARGET\" is a link to a developer copy, so it was left alone."
elif [ -d "$TARGET" ] && grep -q '"com.cp.sdkcontroller"' "$TARGET/manifest.json" 2>/dev/null; then
  rm -rf "$TARGET" && echo "Add On: removed" || echo "Couldn't remove $TARGET. Delete it in Finder."
else
  echo "Add On: not installed"
fi
if [ -z "${SDC_NO_LOGIN_ITEM:-}" ]; then
  launchctl bootout "gui/$(id -u)/com.cp.sdkcontroller.helper" 2>/dev/null || true
  rm -f "$HOME/Library/LaunchAgents/com.cp.sdkcontroller.helper.plist"
fi
rm -rf "$APP_SUPPORT/SDK Controller" && echo "Helper and login item: removed"
echo
echo "Left in place, in case you use them:"
echo "  ~/Library/Application Support/LUNA Builder SDK, if you installed it yourself"
echo "  ~/LUNA Built Add Ons (anything you built)"
echo "  your API key, in Keychain Access under com.uaudio.luna.addon.com.cp.sdkcontroller"
echo
echo "Press Return to close."
read -r _
