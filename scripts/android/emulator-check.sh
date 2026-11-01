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

GMS=com.google.android.gms
DOCSCAN=com.google.android.gms.optional_mlkit_docscan_ui:id

# has <regex> [package-regex] — the last dump has a matching node.
has() { python3 "$HERE/ui.py" find "$OUT/ui.xml" "$1" "${2:-}" >/dev/null; }
# xy <regex> [package-regex] — centre of the matching node in the last dump.
xy() { python3 "$HERE/ui.py" find "$OUT/ui.xml" "$1" "${2:-}"; }
# shellcheck disable=SC2046
tap_now() { local p; p=$(xy "$@") || return 1; log "tap '$1' at $p"; adb shell input tap $p; }

# Photo picker: select up to 4 photos (the fixtures), then confirm.
pick_photos() {
  for i in 1 2 3 4; do
    dump
    p=$(python3 - "$OUT/ui.xml" "$i" <<'PY'
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
    log "select photo $i at $p"
    # shellcheck disable=SC2086
    adb shell input tap $p
    sleep 1
  done
  shot photo-picker-selected
  tap_match '^(add|done|ok|select|追加|完了|選択)( \(\d+\))?$' || true
}

# The scanner needs a recent Google Play services. An emulator image ships
# an old one that Play updates in the background (~10-15 min), restarting
# Play services, so the loop below keeps reacting to whatever screen is up
# until the scan returns to the app with the imported pages.
log "scan: open ML Kit, import the fixture photos, show the page frame, finish"
imported=0
cropped=0
saved=0
end=$((SECONDS + 3000))
while [ $SECONDS -lt $end ]; do
  sleep 3
  dump || continue
  if has 'Keep editing' "$GMS"; then
    tap_now 'Keep editing' "$GMS"
  elif has "$DOCSCAN/confirm_crop_button" "$GMS"; then
    # "Adjust corners": the detected page frame with its four handles.
    if [ $imported = 1 ]; then shot scanner-adjust-corners; cropped=1; else shot scanner-adjust-corners-camera; fi
    tap_now "$DOCSCAN/confirm_crop_button" "$GMS"
  elif has "$DOCSCAN/gallery_button" "$GMS"; then
    if [ $imported = 0 ]; then
      shot scanner-camera
      # Switch to manual first so auto-capture does not grab the room, then
      # open the gallery (both from the same dump: no time for a capture).
      man=$(xy '^Manual$' "$GMS") && adb shell input tap $man
      tap_now "$DOCSCAN/gallery_button" "$GMS"
      sleep 6
      shot photo-picker
      pick_photos
      imported=1
      sleep 8
    else
      log "back on the camera after import; closing"
      tap_now "$DOCSCAN/close_button" "$GMS" || adb shell input keyevent KEYCODE_BACK
    fi
  elif has "$DOCSCAN/save_document_button" "$GMS"; then
    if [ $imported = 0 ]; then
      # Auto-capture grabbed the virtual room first: drop it, go to the camera.
      shot scanner-review-room
      tap_now "$DOCSCAN/delete_button" "$GMS" || tap_now "$DOCSCAN/add_page" "$GMS"
    elif [ $cropped = 0 ]; then
      shot scanner-review
      tap_now "$DOCSCAN/edit_menu_crop_and_rotate_button" "$GMS" || cropped=1
      cropped=1
    else
      shot scanner-review-final
      tap_now "$DOCSCAN/save_document_button" "$GMS"
      saved=1
    fi
  elif has '^(Delete|削除)$' "$GMS" && has 'android:id/button1' "$GMS"; then
    tap_now 'android:id/button1' "$GMS"
  elif has '(PDF 保存|追加スキャン)' "$PKG"; then
    [ $saved = 1 ] && break
    tap_now '追加スキャン' "$PKG"
  elif has '^(スキャン|もう一度スキャンを開く)$' "$PKG"; then
    if has 'もう一度スキャンを開く' "$PKG"; then sleep 30; dump; fi
    tap_now '^(スキャン|もう一度スキャンを開く)$' "$PKG" || true
    sleep 20
  elif has '(photo|写真)' 'providers.media|photopicker|documentsui'; then
    pick_photos
    imported=1
  elif [ $saved = 1 ] && has "$DOCSCAN" "$GMS"; then
    # Unknown post-save screen: try the obvious confirm buttons.
    tap_now '^(Done|Save|Next|完了|保存|次へ)$' "$GMS" || true
  fi
done
log "scan loop ended (imported=$imported cropped=$cropped saved=$saved)"
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
