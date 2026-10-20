#!/bin/sh
# usage: capture.sh <name> <url> [wait_ms]
# Runs one REA browser scenario (headed Chrome, REA-owned temp profile) and extracts
# the accessibility text + screenshot from the returned Evidence.
SP=${REA_WORKDIR}
NAME="$1"; URL="$2"; WAIT="${3:-6000}"
OUT=$SP/re/captures/$NAME
mkdir -p "$OUT"
cat > "$OUT/scenario.json" <<JSON
{
  "browser": { "mode": "launch", "executable_path": "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "headless": false },
  "start_url": { "url": "$URL" },
  "environment": { "viewport": { "width": 1440, "height": 900, "device_scale_factor": 1 } },
  "actions": [ { "step_id": "settle", "action": "wait_for_timeout", "duration_ms": $WAIT } ],
  "capture": { "at_end": ["accessibility", "url", "screenshot"], "events": ["network"] }
}
JSON
"$SP/tools/rea" capture-browser-scenario "$OUT/scenario.json" --format json > "$OUT/evidence.json" 2> "$OUT/stderr.txt"
/usr/bin/python3 -I "$SP/re/bin/extract.py" "$OUT/evidence.json" "$OUT"
