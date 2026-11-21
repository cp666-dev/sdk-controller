#!/bin/bash
# Stop the helper and remove its LaunchAgent.
set -euo pipefail
LABEL="com.cp.sdkcontroller.helper"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
echo "Removed $LABEL"
