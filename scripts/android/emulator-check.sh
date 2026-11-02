#!/usr/bin/env bash
#
# Point the emulator's back camera at the synthetic book clips and scan
# them with the AstarScan app (Google ML Kit Document Scanner). Run by CI
# (`android-emulator` job) inside reactivecircus/android-emulator-runner,
# with scripts/android/camera-feed.py already playing on the v4l2loopback
# device that the emulator uses as `-camera-back webcam0`.
#
#   bash scripts/android/emulator-check.sh <apk> <out-dir>
#
# Env: FEED_CONTROL / FEED_STATUS — the feed's control and status files.
#
# For every clip in scripts/eval/book-clips/clips the check opens the
# scanner, lets ML Kit auto-capture the page shown, and after each
# capture turns the page on the feed (the feed plays the page turn and
# then holds the next spread until the next capture), until every hold
# of the clip has been captured. It keeps:
#   - a screenshot + UI dump of every scanner screen (camera, adjust
#     corners, review), named after what the dump shows, not after the
#     step we expected (scripts/android/ui.py kind);
#   - captures.tsv: clip, capture index, hold shown, feed frame;
#   - the app's page list (several scroll positions) after each clip.
# book-measure.py turns that into corner errors and page counts.
# The last clip skips one spread and takes another twice on purpose, so
# the list must show a red 欠番 and a red 重複 there.
# Never fails the job on a UI miss: every step leaves evidence in <out-dir>.

set -uo pipefail

APK=$1
OUT=$2
PKG=com.astarworks.astarscan
HERE=$(cd "$(dirname "$0")" && pwd)
CLIPS=$HERE/../eval/book-clips/clips
FEED_CONTROL=${FEED_CONTROL:-/tmp/feed.control}
FEED_STATUS=${FEED_STATUS:-/tmp/feed.status}
mkdir -p "$OUT"
n=0
printf 'clip\tcapture\thold\tframe\tshot\n' >"$OUT/captures.tsv"

log() { echo "[emulator-check] $(date +%H:%M:%S) $*" | tee -a "$OUT/steps.log"; }

dump() {
  local f=$OUT/ui.xml
  rm -f "$f"
  for _ in 1 2; do
    adb shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1 && adb pull /sdcard/ui.xml "$f" >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

kind() { python3 "$HERE/ui.py" kind "$OUT/ui.xml"; }

# shot <label> — screenshot + the last dump, named "<n>-<screen kind>-<label>".
# The kind comes from a fresh dump so the name says what is on screen.
SHOT=
shot() {
  n=$((n + 1))
  local k
  adb exec-out screencap -p >"$OUT/tmp.png"
  dump
  k=$(kind)
  SHOT=$(printf '%03d-%s%s' "$n" "$k" "${1:+-$1}")
  mv "$OUT/tmp.png" "$OUT/$SHOT.png"
  [ -f "$OUT/ui.xml" ] && cp "$OUT/ui.xml" "$OUT/$SHOT.xml" && python3 "$HERE/ui.py" list "$OUT/$SHOT.xml" >"$OUT/$SHOT.txt"
  log "shot $SHOT"
}

has() { python3 "$HERE/ui.py" find "$OUT/ui.xml" "$1" "${2:-}" >/dev/null; }
xy() { python3 "$HERE/ui.py" find "$OUT/ui.xml" "$1" "${2:-}"; }
# shellcheck disable=SC2086
tap_now() { local p; p=$(xy "$@") || return 1; log "tap '$1' at $p"; adb shell input tap $p; }

feed() { echo "$1 $2" >"$FEED_CONTROL"; log "feed -> $1 hold $2"; }
feed_frame() { cut -d' ' -f2 "$FEED_STATUS" 2>/dev/null; }

GMS=com.google.android.gms
DOCSCAN=com.google.android.gms.optional_mlkit_docscan_ui:id

log "webcams seen by the emulator:"
"${ANDROID_SDK_ROOT:-/usr/local/lib/android/sdk}/emulator/emulator" -webcam-list 2>&1 | tee -a "$OUT/steps.log"
adb shell dumpsys media.camera 2>/dev/null | grep -iE 'Camera [0-9]|facing|webcam|qemu|SCALER_AVAILABLE_STREAM|availableStreamConfigurations' | head -20 >>"$OUT/steps.log"

log "install"
adb install -r "$APK" 2>&1 | tee -a "$OUT/steps.log"
adb shell pm grant "$PKG" android.permission.CAMERA 2>/dev/null || true

# The scanner needs a recent Google Play services. The image ships an old
# one that Play updates in the background shortly after boot, killing any
# open scanner while it installs. Wait for that update (max 25 min).
gms_version() { adb shell dumpsys package com.google.android.gms | grep -m1 versionName | tr -d ' \r'; }
v0=$(gms_version)
log "Play services $v0; waiting for its update"
end=$((SECONDS + 1500))
while [ $SECONDS -lt $end ]; do
  v=$(gms_version)
  if [ -n "$v" ] && [ "$v" != "$v0" ]; then log "Play services updated to $v"; sleep 60; break; fi
  sleep 20
done

adb logcat -c
adb shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null
sleep 10
shot app-launch

# to_start — get the app back to its start screen with an empty list.
to_start() {
  local i
  for i in 1 2 3 4 5 6; do
    dump
    case $(kind) in
      app-start) return 0 ;;
      dialog-full-screen) tap_now '^Got it$' ;;
      app-list | app-list-empty) tap_now '^すべて削除$' "$PKG" ;;
      scanner-*) adb shell input keyevent KEYCODE_BACK ;;
      *) adb shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null ;;
    esac
    sleep 3
  done
  return 1
}

# page_count — "Page x of M" on the scanner's review screen -> M.
page_count() {
  python3 - "$OUT/ui.xml" <<'PY'
import re, sys
m = re.findall(r"Page \d+ of (\d+)", open(sys.argv[1], encoding="utf-8", errors="replace").read())
print(max(map(int, m)) if m else 0)
PY
}

# scan_clip <clip> <hold indices to capture, in order>
scan_clip() {
  local clip=$1
  shift
  local plan=("$@")
  local want=${#plan[@]} m=0 adj=0 cam_shot=-1 cam_since=$SECONDS opens=0 saved=0
  log "=== $clip: capture holds ${plan[*]}"
  feed "$clip" "${plan[0]}"
  to_start || log "could not get back to the start screen"
  local end=$((SECONDS + 1200))
  while [ $SECONDS -lt $end ]; do
    dump
    case $(kind) in
      app-start)
        [ $saved = 1 ] && break
        opens=$((opens + 1))
        [ $opens -gt 6 ] && { log "gave up opening the scanner"; break; }
        tap_now '^スキャン$' "$PKG"
        m=0
        adj=0
        cam_since=$SECONDS
        sleep 5
        ;;
      app-waiting-scanner)
        if [ $((SECONDS - cam_since)) -gt 90 ]; then
          tap_now 'もう一度スキャンを開く' "$PKG"
          cam_since=$SECONDS
        fi
        sleep 3
        ;;
      app-list | app-list-empty)
        log "$clip: back in the app"
        break
        ;;
      dialog-full-screen) tap_now '^Got it$' ;;
      other-permissioncontroller)
        shot "$clip-permission"
        tap_now '(permission_allow_foreground_only_button|permission_allow_button|While using the app|^Allow$)' 'permissioncontroller'
        ;;
      scanner-dialog)
        shot "$clip-dialog"
        if has '^Keep editing$' "$GMS"; then tap_now '^Keep editing$' "$GMS"; else tap_now 'android:id/button1' "$GMS"; fi
        ;;
      scanner-adjust-corners)
        local fr
        fr=$(feed_frame)
        shot "$clip-c$adj-adjust"
        printf '%s\t%s\t%s\t%s\t%s\n' "$clip" "$adj" "${plan[$adj]:-}" "$fr" "$SHOT" >>"$OUT/captures.tsv"
        adj=$((adj + 1))
        tap_now "$DOCSCAN/confirm_crop_button" "$GMS"
        sleep 2
        ;;
      scanner-review)
        m=$(page_count)
        if [ "$adj" -lt "$m" ]; then
          # ML Kit went straight to the review: open the newest page's
          # corners so its frame is on record too.
          tap_now "Page $m of $m" "$GMS" || true
          sleep 1
          dump
          if ! tap_now "$DOCSCAN/edit_menu_crop_and_rotate_button" "$GMS"; then adj=$m; fi
          sleep 2
        elif [ "$m" -lt "$want" ]; then
          [ "$m" -le 1 ] && shot "$clip-review"
          feed "$clip" "${plan[$m]}"
          tap_now "$DOCSCAN/add_page" "$GMS" || tap_now '^Add page' "$GMS"
          cam_since=$SECONDS
          sleep 2
        else
          shot "$clip-review-final"
          tap_now "$DOCSCAN/save_document_button" "$GMS"
          saved=1
          sleep 4
        fi
        ;;
      *)
        # ML Kit's live camera (usually not dumpable while the preview runs).
        if [ "$cam_shot" != "$m" ] && [ $((SECONDS - cam_since)) -ge 2 ]; then
          shot "$clip-c$m-camera"
          cam_shot=$m
        elif [ $((SECONDS - cam_since)) -gt 60 ]; then
          # No auto-capture within a minute: press the shutter (manual).
          shot "$clip-c$m-no-autocapture"
          log "$clip c$m: no auto-capture in 60 s, pressing the shutter"
          if has '(shutter|Take photo|Capture)' "$GMS"; then tap_now '(shutter|Take photo|Capture)' "$GMS"; else adb shell input tap 540 2005; fi
          cam_since=$SECONDS
        fi
        sleep 1
        ;;
    esac
  done
  log "$clip: scanner loop ended (pages in scanner: $m / $want, saved=$saved)"

  # Page list: wait for the page-number OCR, then keep the list at a few
  # scroll positions (book-measure.py merges them).
  local t_end=$((SECONDS + 420))
  while [ $SECONDS -lt $t_end ]; do
    dump
    grep -qE '読み取り中|読み取り準備中' "$OUT/ui.xml" || break
    sleep 10
  done
  shot "$clip-list"
  local s
  for s in 1 2 3 4 5 6; do
    adb shell input swipe 540 1700 540 700 500
    sleep 2
    shot "$clip-list-s$s"
  done
}

record_start() {
  (for i in 1 2 3 4 5; do adb shell screenrecord --time-limit 180 --bit-rate 4000000 "/sdcard/rec-$i.mp4"; done) &
  REC_PID=$!
}
record_stop() {
  kill "$REC_PID" 2>/dev/null
  adb shell pkill -INT screenrecord 2>/dev/null
  sleep 3
  local i
  : >"$OUT/rec.txt"
  for i in 1 2 3 4 5; do
    adb pull "/sdcard/rec-$i.mp4" "$OUT/rec-$i.mp4" >/dev/null 2>&1 && echo "file 'rec-$i.mp4'" >>"$OUT/rec.txt"
  done
  if [ -s "$OUT/rec.txt" ]; then
    (cd "$OUT" && ffmpeg -hide_banner -loglevel error -f concat -safe 0 -i rec.txt -c copy book-eval-recording.mp4) && rm -f "$OUT"/rec-*.mp4
  fi
  rm -f "$OUT/rec.txt"
}

holds() { python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(*range(sum(s["phase"]=="hold" for s in d["segments"])))' "$CLIPS/$1.gt.json"; }

# shellcheck disable=SC2046
scan_clip spread-land-wood $(holds spread-land-wood)
# shellcheck disable=SC2046
scan_clip spread-port-white $(holds spread-port-white)
# shellcheck disable=SC2046
scan_clip spread-land-white-thick $(holds spread-land-white-thick)
# shellcheck disable=SC2046
scan_clip single-port-wood $(holds single-port-wood)
# Last clip (recorded): skip hold 3 (p37) and take hold 6 (p43) twice.
record_start
scan_clip single-land-white 0 1 2 4 5 6 6 7 8 9
record_stop

log "save PDF (last clip)"
tap_match_pdf() { dump && tap_now '^PDF 保存' "$PKG"; }
tap_match_pdf || log "save button not found"
sleep 8
shot pdf-saved
adb shell ls -l /sdcard/Download/AstarScan/ 2>&1 | tee -a "$OUT/steps.log"

adb logcat -d >"$OUT/logcat.txt" 2>&1
log "done"
exit 0
