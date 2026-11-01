#!/usr/bin/env bash
#
# Drive the AstarScan Android app on an emulator (Google Play image) through
# the ML Kit Document Scanner and keep screenshots + UI dumps of each step.
# Run by CI (`android-emulator` job) inside reactivecircus/android-emulator-runner.
#
#   bash scripts/android/emulator-check.sh <apk> <out-dir>
#
# The pages come in through the scanner's gallery import (the emulator
# camera cannot point at real paper): scripts/android/fixtures/*.jpg are
# photos of pages numbered 12, 13, 13, 15, so the list should flag 13 as a
# duplicate and 14 as missing. A camera screenshot is also taken.
# Never fails the job on a UI miss: every step leaves evidence in <out-dir>.

set -uo pipefail

APK=$1
OUT=$2
PKG=com.astarworks.astarscan
HERE=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$OUT"
n=0

log() { echo "[emulator-check] $*" | tee -a "$OUT/steps.log"; }

dump() {
  local f=$OUT/ui.xml
  for _ in 1 2 3; do
    adb shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1 && adb pull /sdcard/ui.xml "$f" >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

shot() {
  n=$((n + 1))
  local name
  name=$(printf '%02d-%s' "$n" "$1")
  adb exec-out screencap -p >"$OUT/$name.png"
  dump && cp "$OUT/ui.xml" "$OUT/$name.xml" && python3 "$HERE/ui.py" list "$OUT/$name.xml" >"$OUT/$name.txt"
  log "shot $name"
}

# tap_match <regex> [package-regex] — tap the first matching node.
tap_match() {
  dump || return 1
  local xy
  xy=$(python3 "$HERE/ui.py" find "$OUT/ui.xml" "$1" "${2:-}") || return 1
  log "tap '$1' at $xy"
  # shellcheck disable=SC2086
  adb shell input tap $xy
}

# wait_match <regex> <seconds> [package-regex]
wait_match() {
  local end=$((SECONDS + $2))
  while [ $SECONDS -lt $end ]; do
    dump && python3 "$HERE/ui.py" find "$OUT/ui.xml" "$1" "${3:-}" >/dev/null && return 0
    sleep 3
  done
  log "timeout waiting for '$1'"
  return 1
}

log "install"
adb install -r "$APK" 2>&1 | tee -a "$OUT/steps.log"

log "push fixture photos"
adb shell mkdir -p /sdcard/Pictures/AstarScan
for f in "$HERE"/fixtures/*.jpg; do
  adb push "$f" /sdcard/Pictures/AstarScan/ >/dev/null
  adb shell am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE \
    -d "file:///sdcard/Pictures/AstarScan/$(basename "$f")" >/dev/null
done
adb shell content call --uri content://media --method scan_volume --arg external_primary >/dev/null 2>&1 || true

adb logcat -c
adb shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null
wait_match '^スキャン$' 90 || true
shot app-start

log "open ML Kit scanner"
tap_match '^スキャン$' || log "scan button not found"
# First use downloads the scanner module through Play services.
wait_match '(gallery|import|photo|capture|shutter|ギャラリー|インポート|撮影)' 240 'com.google.android.gms' || true
sleep 5
shot scanner-camera

log "import the fixture photos from the gallery"
tap_match '(gallery|import|ギャラリー|インポート)' 'com.google.android.gms' || log "gallery button not found"
sleep 6
shot photo-picker
# Photo picker: select every fixture (newest first in the grid), then add.
for i in 1 2 3 4; do
  dump
  xy=$(python3 - "$OUT/ui.xml" "$i" <<'PY'
import re, sys, xml.etree.ElementTree as ET
try:
    root = ET.parse(sys.argv[1]).getroot()
except Exception:
    sys.exit(1)
want = int(sys.argv[2])
hits = []
for n in root.iter("node"):
    d = (n.get("content-desc") or "") + " " + (n.get("text") or "")
    if re.search(r"(photo|image|写真|画像)", d, re.I) and n.get("clickable") == "true":
        m = re.match(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", n.get("bounds") or "")
        if m:
            x1, y1, x2, y2 = map(int, m.groups())
            if y2 - y1 > 100:
                hits.append(((x1 + x2) // 2, (y1 + y2) // 2))
if len(hits) >= want:
    print(*hits[want - 1])
else:
    sys.exit(1)
PY
  ) || break
  log "select photo $i at $xy"
  # shellcheck disable=SC2086
  adb shell input tap $xy
  sleep 1
done
shot photo-picker-selected
tap_match '^(add|done|ok|select|追加|完了|選択)( \(\d+\))?' || true
sleep 8
wait_match '(done|save|完了|保存)' 120 'com.google.android.gms' || true
shot scanner-review

log "open the crop view to show the detected page frame"
if tap_match '(crop|切り抜|トリミング)' 'com.google.android.gms'; then
  sleep 4
  shot scanner-crop-frame
  adb shell input keyevent KEYCODE_BACK
  sleep 3
fi

log "finish the scan and return to the app"
tap_match '^(done|save|完了|保存)$' 'com.google.android.gms' || tap_match '(done|save|完了|保存)' 'com.google.android.gms' || log "done button not found"
wait_match '(PDF 保存|追加スキャン)' 120 "$PKG" || true
sleep 3
shot app-list

log "wait for page-number OCR (models download on first use)"
end=$((SECONDS + 420))
while [ $SECONDS -lt $end ]; do
  dump
  if ! grep -q '読み取り中' "$OUT/ui.xml" && ! grep -q '読み取り準備中' "$OUT/ui.xml"; then break; fi
  sleep 10
done
shot app-list-page-numbers
adb shell input swipe 540 1800 540 900 400
sleep 2
shot app-list-scrolled

log "save PDF"
tap_match 'PDF 保存' "$PKG" || log "save button not found"
sleep 8
shot pdf-saved
adb shell ls -l /sdcard/Download/AstarScan/ 2>&1 | tee -a "$OUT/steps.log"
adb shell input keyevent KEYCODE_BACK
sleep 3
shot app-after-save

adb logcat -d >"$OUT/logcat.txt" 2>&1
adb logcat -d -s AstarScanMlkit chromium Tauri RustStdoutStderr >"$OUT/logcat-app.txt" 2>&1
log "done"
exit 0
