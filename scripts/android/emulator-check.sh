#!/usr/bin/env bash
#
# Point the emulator's back camera at the synthetic book clips and take
# them with the AstarScan app's own capture screen (CaptureActivity). Run
# by CI (`android-emulator` job) inside reactivecircus/android-emulator-runner,
# with scripts/android/camera-feed.py already playing on the v4l2loopback
# device that the emulator uses as `-camera-back webcam0`.
#
#   bash scripts/android/emulator-check.sh <apk> <out-dir>
#
# Env: FEED_CONTROL / FEED_STATUS — the feed's control and status files;
#      FEED_LOG — the feed's per-frame log (copied into <out-dir>).
#
# For every clip the check opens the capture screen and, for each page of
# its plan, holds that page in front of the camera (the feed keeps playing
# that hold) until the app says it took it ("撮れた" banner: the user's sign
# to turn), then turns to the next page. When the app says nothing for
# WAIT_S seconds, the check records whether a yellow or red notice was up
# and moves on. It keeps:
#   - checks.tsv: per page of the plan, what the screen said (taken /
#     filled / unread / gap / duplicate / yellow / none) and the screenshot;
#   - notices.tsv: every yellow / red notice the screen showed;
#   - events.log: the screen's own log (frames found, pages, numbers);
#   - eval/: the camera picture of every page taken (book-measure.py
#     measures the frame on it against the ground truth);
#   - the app's page list after each clip (several scroll positions).
# The last clip skips p37 on purpose (hold 3): the screen must say in red
# that 37 is missing, and taking it afterwards must fill the gap.
# Never fails the job on a UI miss: every step leaves evidence in <out-dir>.

set -uo pipefail

APK=$1
OUT=$2
PKG=com.astarworks.astarscan
HERE=$(cd "$(dirname "$0")" && pwd)
CLIPS=$HERE/../eval/book-clips/clips
FEED_CONTROL=${FEED_CONTROL:-/tmp/feed.control}
FEED_STATUS=${FEED_STATUS:-/tmp/feed.status}
FEED_LOG=${FEED_LOG:-/tmp/feed.log}
# Seconds a page may stay in front of the camera without a word from the app.
WAIT_S=${WAIT_S:-45}
# After "✓ 撮れた": how long to wait for the page's number result.
NUM_WAIT_S=${NUM_WAIT_S:-30}
mkdir -p "$OUT"
n=0
printf 'clip\tstep\thold\tresult\ttext\tshot\twaited\tnumwait\n' >"$OUT/checks.tsv"
printf 'clip\thold\tkind\ttext\n' >"$OUT/notices.tsv"
EVENTS=$OUT/events.log
: >"$EVENTS"

log() { echo "[emulator-check] $(date +%H:%M:%S) $*" | tee -a "$OUT/steps.log"; }

dump() {
  local f=$OUT/ui.xml
  rm -f "$f"
  for _ in 1 2; do
    timeout 20 adb shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1 && adb pull /sdcard/ui.xml "$f" >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

kind() { python3 "$HERE/ui.py" kind "$OUT/ui.xml"; }

# shot <label> [nodump] — screenshot (+ UI dump unless nodump), named
# "<n>-<label>". The capture screen redraws its frame all the time, so
# uiautomator often cannot dump it; its shots skip the dump.
SHOT=
shot() {
  n=$((n + 1))
  SHOT=$(printf '%03d-%s' "$n" "$1")
  adb exec-out screencap -p >"$OUT/$SHOT.png"
  if [ "${2:-}" != nodump ]; then
    dump && cp "$OUT/ui.xml" "$OUT/$SHOT.xml" && python3 "$HERE/ui.py" list "$OUT/$SHOT.xml" >"$OUT/$SHOT.txt"
  fi
  log "shot $SHOT"
}

has() { python3 "$HERE/ui.py" find "$OUT/ui.xml" "$1" "${2:-}" >/dev/null; }
xy() { python3 "$HERE/ui.py" find "$OUT/ui.xml" "$1" "${2:-}"; }
# shellcheck disable=SC2086
tap_now() { local p; p=$(xy "$@") || return 1; log "tap '$1' at $p"; adb shell input tap $p; }

# feed <clip> <hold> — also marks the hold in the device log, so
# book-measure.py ties every page the screen took to the hold it was taken
# in by log order (run 21: by clock time, every hold after the first came
# out blank).
feed() {
  echo "$1 $2" >"$FEED_CONTROL"
  adb shell log -t AstarScanEval "hold $1 $2" 2>/dev/null || true
  log "feed -> $1 hold $2"
}

log "webcams seen by the emulator:"
"${ANDROID_SDK_ROOT:-/usr/local/lib/android/sdk}/emulator/emulator" -webcam-list 2>&1 | tee -a "$OUT/steps.log"
adb shell dumpsys media.camera >"$OUT/media-camera.txt" 2>&1 || true

log "install"
adb install -r "$APK" 2>&1 | tee -a "$OUT/steps.log"
adb shell pm grant "$PKG" android.permission.CAMERA 2>/dev/null || true

# The capture screen keeps the camera picture of every page in eval/ when
# eval/.on exists (CaptureActivity.evalDir).
EVAL_DIR=/sdcard/Android/data/$PKG/files/eval
adb shell mkdir -p "$EVAL_DIR" 2>&1 | tee -a "$OUT/steps.log"
adb shell touch "$EVAL_DIR/.on" 2>&1 | tee -a "$OUT/steps.log"

# Host clock minus device clock (s): the screen logs wall-clock times of
# the frames it took pages from; book-measure.py looks them up in the feed log.
clock_offset() {
  python3 - <<'PY'
import subprocess, time
best = None
for _ in range(5):
    t0 = time.time()
    out = subprocess.run(["adb", "shell", "date", "+%s.%N"], capture_output=True, text=True).stdout.strip()
    t1 = time.time()
    try:
        dev = float(out)
    except ValueError:
        continue
    off = (t0 + t1) / 2 - dev
    if best is None or t1 - t0 < best[1]:
        best = (off, t1 - t0)
print(f"{best[0]:.3f} {best[1]:.3f}" if best else "0 9")
PY
}
read -r OFFSET RTT <<<"$(clock_offset)"
log "clock: host - device = $OFFSET s (adb round trip $RTT s)"
echo "$OFFSET" >"$OUT/clock-offset.txt"

adb logcat -c
# follow_log <file> <logcat args…> — `adb logcat` streams stop when adb
# drops the device for a moment (run 16); start again from the newest line.
follow_log() {
  local f=$1 first=1
  shift
  while :; do
    if [ $first = 1 ]; then adb logcat -v threadtime "$@" >>"$f" 2>&1; else adb logcat -v threadtime -T 1 "$@" >>"$f" 2>&1; fi
    first=0
    sleep 2
  done
}
follow_log "$EVENTS" -s AstarScanCapture:I AstarScanMlkit:I AstarScanEval:I AndroidRuntime:E &
EVENTS_PID=$!
adb shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null
sleep 10
shot app-launch

# to_start — the app's start screen with an empty list.
to_start() {
  local i
  for i in 1 2 3 4 5 6; do
    dump
    case $(kind) in
      app-start) return 0 ;;
      app-capture) adb shell input keyevent KEYCODE_BACK ;;
      dialog-full-screen) tap_now '^Got it$' ;;
      app-list | app-list-empty) tap_now '^すべて削除$' "$PKG" ;;
      no-dump) adb shell input keyevent KEYCODE_BACK ;;
      *) adb shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null ;;
    esac
    sleep 3
  done
  return 1
}

events_since() { tail -n +$(($1 + 1)) "$EVENTS"; }
events_lines() { wc -l <"$EVENTS"; }

# open_capture <clip> — tap スキャン and wait for the capture screen's camera.
open_capture() {
  local i mark
  mark=$(events_lines)
  dump
  tap_now '^スキャン$' "$PKG" || tap_now '^追加スキャン$' "$PKG" || { log "$1: no scan button"; return 1; }
  for i in $(seq 30); do
    events_since "$mark" | grep -q 'AstarScanCapture.*: camera bound' && events_since "$mark" | grep -q 'AstarScanCapture.*: detector ready' && break
    events_since "$mark" | grep -q 'AstarScanCapture.*: closing' && break
    sleep 1
  done
  events_since "$mark" | grep -E 'AstarScanCapture.*: (camera|detector|closing|frame )' | tee -a "$OUT/steps.log"
  sleep 2
  shot "$1-capture-open" nodump
}

# take_page <clip> <step> <hold> — hold the page until the screen says it
# took it ("shot", or a number result), or WAIT_S seconds pass; then, for a
# page taken, wait up to NUM_WAIT_S for its number result (read while the
# user turns on) and record that. One checks.tsv row.
take_page() {
  local clip=$1 step=$2 hold=$3 mark t0 line result=none text= waited dup= name= numwait= t1
  mark=$(events_lines)
  t0=$SECONDS
  while [ $((SECONDS - t0)) -lt "$WAIT_S" ]; do
    # A page taken in THIS hold: its "capture" line, then its "✓ 撮れた"
    # banner. A number result of the page before (read while the camera
    # turned on) is not this hold's page (run 22: spread-land-white-thick
    # h3 counted h2's late "番号なし" after 1 s and moved on untaken).
    if events_since "$mark" | grep -q -E 'AstarScanCapture.*: capture [^ ]+ t='; then
      line=$(events_since "$mark" | sed -n '/AstarScanCapture.*: capture [^ ]* t=/,$p' | grep -m1 -E 'AstarScanCapture.*: banner (shot|taken|unread|filled|gap|duplicate) ')
      if [ -n "$line" ]; then
        result=$(sed -E 's/.*: banner ([a-z]+) .*/\1/' <<<"$line")
        text=$(sed -E 's/.*: banner [a-z]+ //' <<<"$line")
        break
      fi
    fi
    # "撮影済み": the same page again (not turned) — keep waiting for this page.
    [ -z "$dup" ] && dup=$(events_since "$mark" | grep -m1 -E 'AstarScanCapture.*: banner duplicate ')
    sleep 0.5
  done
  waited=$((SECONDS - t0))
  if [ "$result" != none ]; then
    # The page this banner is about, and its number result.
    name=$(events_since "$mark" | grep -m1 -E 'AstarScanCapture.*: capture [^ ]+ t=' | sed -E 's/.*: capture ([^ ]+) t=.*/\1/')
    if [ -n "$name" ]; then
      t1=$SECONDS
      line=
      while [ $((SECONDS - t1)) -lt "$NUM_WAIT_S" ]; do
        line=$(events_since "$mark" | grep -m1 -F "AstarScanCapture: page $name kind=" || true)
        [ -z "$line" ] && line=$(events_since "$mark" | grep -m1 -E "AstarScanCapture *: page $name kind=" || true)
        [ -n "$line" ] && break
        sleep 0.5
      done
      numwait=$((SECONDS - t1))
      if [ -n "$line" ]; then
        result=$(sed -E 's/.*: page [^ ]+ kind=([a-z]+) .*/\1/' <<<"$line")
        # What the banner said for it (none when a newer page was already up).
        line=$(events_since "$mark" | grep -E 'AstarScanCapture.*: banner (taken|unread|filled|gap|duplicate) ' | tail -n1)
        [ -n "$line" ] && text=$(sed -E 's/.*: banner [a-z]+ //' <<<"$line")
      else
        text="$text (番号は ${NUM_WAIT_S}s で出ず)"
      fi
    fi
  fi
  if [ "$result" = none ]; then
    if [ -n "$dup" ]; then
      result=duplicate
      text=$(sed -E 's/.*: banner [a-z]+ //' <<<"$dup")
    else
      # What was up when nothing came: the newest yellow / red notice.
      line=$(events_since "$mark" | grep -E 'AstarScanCapture.*: banner (yellow|gap) ' | tail -n1)
      if [ -n "$line" ]; then
        result=$(sed -E 's/.*: banner ([a-z]+) .*/\1/' <<<"$line")
        [ "$result" = gap ] && result=gap-notice
        text=$(sed -E 's/.*: banner [a-z]+ //' <<<"$line")
      fi
    fi
  fi
  shot "$clip-h$hold-$result" nodump
  events_since "$mark" | grep -E 'AstarScanCapture.*: banner (yellow|gap) ' | while read -r l; do
    printf '%s\t%s\t%s\t%s\n' "$clip" "$hold" "$(sed -E 's/.*: banner ([a-z]+) .*/\1/' <<<"$l")" "$(sed -E 's/.*: banner [a-z]+ //' <<<"$l")" >>"$OUT/notices.tsv"
  done
  # The screen's own log for this page, into the job log too (what the frame
  # finder saw, how long each part of taking the page took).
  events_since "$mark" | grep -E 'AstarScan(Capture|Mlkit)' | grep -v ': margins ' | cut -c19- | cut -c1-300 | sed 's/^/    /'
  log "$clip step $step hold $hold: $result ${text:+($text)} after ${waited}s${numwait:+, number after ${numwait}s more}"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$clip" "$step" "$hold" "$result" "$text" "$SHOT" "$waited" "$numwait" >>"$OUT/checks.tsv"
  RESULT=$result
}

# scan_clip <clip> <holds in the order the pages are shown>
scan_clip() {
  local clip=$1
  shift
  local i=0 h
  log "=== $clip: holds $*"
  to_start || log "could not get back to the start screen"
  adb shell log -t AstarScanEval "clip $clip"
  feed "$clip" "$1"
  sleep 2
  open_capture "$clip"
  for h in "$@"; do
    [ $i -gt 0 ] && feed "$clip" "$h"
    take_page "$clip" "$i" "$h"
    i=$((i + 1))
  done
  close_capture "$clip"
  clip_list "$clip"
}

# close_capture — Back on the capture screen hands its pages to the app.
# Back once, then wait for the screen's "done" (it may first finish the
# numbers still being read): run 20 pressed Back every 4 s while the screen
# was still reading, and a late Back closed the app itself (pid exited 0,
# list lost).
close_capture() {
  local i t0 mark
  for i in 1 2 3; do
    dump
    case $(kind) in
      app-list | app-list-empty | app-start) return 0 ;;
    esac
    mark=$(events_lines)
    adb shell input keyevent KEYCODE_BACK
    t0=$SECONDS
    while [ $((SECONDS - t0)) -lt 60 ]; do
      events_since "$mark" | grep -qE 'AstarScanCapture.*: (done|closing) ' && break
      sleep 1
    done
    events_since "$mark" | grep -E 'AstarScanCapture.*: (finishing|closing with|done) ' | cut -c19- | sed 's/^/    /'
    for _ in $(seq 15); do
      sleep 2
      dump
      case $(kind) in
        app-list | app-list-empty | app-start) return 0 ;;
      esac
    done
  done
  log "$1: still not back on the list"
  return 1
}

# clip_list <clip> — the app's page list after the clip.
clip_list() {
  local clip=$1 t_end=$((SECONDS + 240)) s
  while [ $SECONDS -lt $t_end ]; do
    dump
    grep -qE '取り込み中|読み取り中|読み取り準備中' "$OUT/ui.xml" || break
    sleep 5
  done
  shot "$clip-list"
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
# Last clip (recorded): p37 (hold 3) skipped on purpose — after p39 (hold
# 4) the screen must say in red that 37 is missing; then back to hold 3
# (it must fill the gap) and on from hold 5.
record_start
scan_clip single-land-white 0 1 2 4 3 5 6 7 8 9
record_stop

log "save PDF (last clip)"
dump && tap_now '^PDF 保存' "$PKG" || log "save button not found"
sleep 8
shot pdf-saved
adb shell ls -l /sdcard/Download/AstarScan/ 2>&1 | tee -a "$OUT/steps.log"

log "pull the camera pictures of the pages"
adb pull "$EVAL_DIR" "$OUT/" 2>&1 | tail -n1 | tee -a "$OUT/steps.log"
cp "$FEED_LOG" "$OUT/feed.log" 2>/dev/null || true
adb logcat -d >"$OUT/logcat.txt" 2>&1
kill "$EVENTS_PID" 2>/dev/null || true
pkill -f 'adb logcat -v threadtime' 2>/dev/null || true
log "app crashes: $(grep -c 'FATAL EXCEPTION' "$EVENTS")"
log "done"
exit 0
