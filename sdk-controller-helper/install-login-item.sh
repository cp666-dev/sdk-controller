#!/bin/bash
# Install a LaunchAgent so the helper starts at login and is restarted if it exits.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
# From a git checkout, run the built copy instead: switching branches removes this folder from
# the checkout. The copy follows the branch's commits (see the repo README, "Running the Add Ons").
BUILT="$HOME/LUNA Built Add Ons/branches/sdk-controller/sdk-controller-helper"
if git -C "$DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 && [ -f "$BUILT/run.sh" ]; then
  DIR="$BUILT"
fi
LABEL="com.cp.sdkcontroller.helper"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOGS="$HOME/Library/Logs/SDK Controller"
mkdir -p "$LOGS" "$HOME/Library/LaunchAgents"

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$DIR/run.sh</string>
  </array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOGS/helper.log</string>
  <key>StandardErrorPath</key><string>$LOGS/helper.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
PLIST

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
# bootout returns before the old service is gone; bootstrapping too early fails with error 5.
for _ in $(seq 1 20); do launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || break; sleep 0.5; done
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Installed $PLIST ($DIR)"
echo "Logs: $LOGS"
