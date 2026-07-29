#!/bin/sh
# Installs (or refreshes) the daily feed scan as a macOS LaunchAgent.
#
#   ./install.sh          install / update
#   ./install.sh remove   uninstall completely
#
# Why it copies scan.js instead of scheduling it in place
# -------------------------------------------------------
# This repo lives under ~/Desktop, which macOS protects with TCC. A
# launchd-spawned process cannot read anything there — not execute, not even
# `head` a file — until the user grants Full Disk Access to the interpreter:
#
#     $ launchctl load ...tccprobe.plist
#     head: /Users/…/Desktop/wbai-archive/package.json: Operation not permitted
#
# Granting Full Disk Access to /bin/sh to run one scanner is a bad trade, so the
# agent instead runs a copy from ~/Library/Application Support, which is not
# protected. scan.js is zero-dependency and self-contained, so a copy is a
# complete, working scanner.
#
# The cost is that the copy can drift from the repo. Re-run this script after
# changing scan.js — it overwrites the copy and reloads the agent. The installed
# copy records the git commit it came from, and `--version` prints it, so drift
# is at least visible rather than silent.
set -eu

LABEL="top.supersoul.wbai-feed-scan"
DEST="$HOME/Library/Application Support/wbai-feed-scan"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
SRC="$(cd "$(dirname "$0")" && pwd)"

if [ "${1:-}" = "remove" ]; then
  launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  rm -rf "$DEST"
  echo "removed: agent unloaded, $PLIST and $DEST deleted"
  echo "note: the scanner in this repo is untouched — run it by hand with: node scan.js"
  exit 0
fi

command -v node >/dev/null || { echo "node not found on PATH"; exit 1; }
NODE="$(command -v node)"
COMMIT="$(git -C "$SRC" rev-parse --short HEAD 2>/dev/null || echo unknown)"

mkdir -p "$DEST"
cp "$SRC/scan.js" "$DEST/scan.js"
echo "$COMMIT" > "$DEST/INSTALLED_FROM"

# The runner lives beside the copy so nothing in the scheduled path ever touches
# the protected folder. Silent on a quiet day: a watcher that writes every
# morning gets skimmed and then ignored, and the one line that mattered goes
# past unread.
cat > "$DEST/run.sh" <<RUNNER
#!/bin/sh
set -u
cd "\$(dirname "\$0")" || exit 2
LOG="\$(dirname "\$0")/feed-scan.log"
OUT=\$("$NODE" scan.js 2>&1)
CODE=\$?
if [ \$CODE -ne 0 ]; then
  { echo "===== \$(date '+%Y-%m-%d %H:%M:%S %Z')  exit=\$CODE"; echo "\$OUT"; echo; } >> "\$LOG"
fi
if [ -f "\$LOG" ] && [ "\$(wc -l < "\$LOG")" -gt 4000 ]; then
  tail -n 2000 "\$LOG" > "\$LOG.tmp" && mv "\$LOG.tmp" "\$LOG"
fi
exit \$CODE
RUNNER
chmod +x "$DEST/run.sh"

mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$DEST/run.sh</string></array>
  <key>StartCalendarInterval</key><dict>
    <key>Hour</key><integer>9</integer><key>Minute</key><integer>17</integer>
  </dict>
  <!-- false: loading the agent should not itself fire a scan. That would be
       noise, and on a fresh install it would also write the baseline at an
       arbitrary moment rather than at the scheduled one. -->
  <key>RunAtLoad</key><false/>
  <!-- launchd's own stderr, separate from the scan log. A scan that never ran
       writes nothing, which is indistinguishable from a quiet day — this is
       where "the agent could not start at all" shows up. -->
  <key>StandardErrorPath</key><string>$DEST/launchd.err</string>
</dict>
</plist>
PLISTEOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

echo "installed  $LABEL  (from commit $COMMIT)"
echo "  runs     09:17 daily; if the Mac is asleep, at next wake"
echo "  scanner  $DEST/scan.js"
echo "  log      $DEST/feed-scan.log   (written only when something changed)"
echo "  run now  launchctl start $LABEL"
echo "  remove   $SRC/install.sh remove"
