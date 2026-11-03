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
printf 'clip\tcapture\thold\tframe\tshot\tkept\n' >"$OUT/captures.tsv"
printf 'clip\tholds\tshot\tshown\ttext\n' >"$OUT/notices.tsv"

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
  log "shot $SHOT ($(preview_stats "$OUT/$SHOT.png"))"
}

# Brightness of the middle of a screenshot (the camera preview area), so
# the job log alone tells a black / frozen preview from a live one.
preview_stats() {
  python3 - "$1" <<'PY' 2>/dev/null || echo "stats n/a"
import sys
import cv2
im = cv2.imread(sys.argv[1], cv2.IMREAD_GRAYSCALE)
h, w = im.shape
c = im[h // 5 : h * 3 // 4, w // 8 : w * 7 // 8]
print(f"centre mean {c.mean():.0f} std {c.std():.0f}")
PY
}

# Once per run: what the camera screen offers and what the camera stack
# says, printed to the job log (the artifact is not always reachable).
DIAG=0
diag() {
  [ $DIAG = 1 ] && return
  DIAG=1
  log "camera screen nodes:"
  python3 "$HERE/ui.py" list "$OUT/ui.xml" | tee -a "$OUT/steps.log"
  log "camera logcat:"
  adb logcat -d 2>/dev/null | grep -iE 'camera|docscan|webcam|v4l2' | tail -40 | tee -a "$OUT/steps.log"
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
adb shell dumpsys media.camera 2>/dev/null | grep -iE 'Camera [0-9]|facing|webcam|qemu|SCALER_AVAILABLE_STREAM|availableStreamConfigurations' | head -20 | tee -a "$OUT/steps.log"
# The whole camera service dump (stream sizes the back webcam offers the
# scanner: does a bigger feed reach ML Kit?).
adb shell dumpsys media.camera >"$OUT/media-camera.txt" 2>&1 || true

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

# Run 17: Play services' processes (gms, gms.ui = the scanner, gms.unstable)
# died 55 times, every native crash a SIGSEGV on the same unmapped pointer
# 0x4abd7000 / 0x4abd7008 in every one of them (glide-source, lowpool,
# binder threads) — one bad reference shared by every process of the
# package, not a bug of one screen. The app process (same zygote) never
# crashed. The suspect is the ART app image / odex written for the Play
# services update installed a few minutes earlier. Recompile it without an
# app image (filter "verify") and restart its processes before scanning.
gms_dexopt() { adb shell dumpsys package dexopt 2>/dev/null | grep -A6 '^ *\[com.google.android.gms\]' | head -8 | tee -a "$OUT/steps.log"; }
log "Play services dexopt state before recompiling:"
gms_dexopt
log "recompiling Play services (-m verify -f): $(adb shell cmd package compile -m verify -f com.google.android.gms 2>&1 | tr -d '\r' | tail -n1)"
adb shell am force-stop com.google.android.gms 2>&1 | tee -a "$OUT/steps.log"
sleep 30
log "Play services dexopt state after recompiling:"
gms_dexopt

# ML Kit page-number probe: the same band pass the app runs on a scan,
# on page images cut from the clips at the emulator camera's size and at
# the clip's own size (probe-pages.py, ScannerPlugin.load). Tells whether
# an unread number is the camera resolution or the reader.
PROBE_DIR=/sdcard/Android/data/$PKG/files
if python3 "$HERE/probe-pages.py" "$CLIPS" "$OUT/probe" 2>&1 | tee -a "$OUT/steps.log"; then
  adb shell mkdir -p "$PROBE_DIR" 2>&1 | tee -a "$OUT/steps.log"
  adb push "$OUT/probe/ocr-probe" "$PROBE_DIR/" 2>&1 | tail -1 | tee -a "$OUT/steps.log"
  adb logcat -c
  adb shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null
  # Two passes per image; run 11 ran out of 15 min at 68 of 123 images.
  end=$((SECONDS + 1800))
  while [ $SECONDS -lt $end ]; do
    adb logcat -d -s AstarScanMlkit:I 2>/dev/null | grep -q 'probe done' && break
    sleep 10
  done
  adb logcat -d -v threadtime -s AstarScanMlkit:I >"$OUT/probe.log" 2>&1
  log "probe: $(grep -c ' probe [^ ]*\.jpg ' "$OUT/probe.log") page images read; $(grep -o 'probe done.*' "$OUT/probe.log" | head -1)"
  adb shell am force-stop "$PKG"
  adb shell rm -rf "$PROBE_DIR/ocr-probe"
  rm -rf "$OUT/probe/ocr-probe"
fi

adb logcat -c
# ML Kit's page-number reads (one "margins" line per page, ScannerPlugin.kt)
# with a marker per clip, kept apart from the big logcat (book-measure.py).
# follow_log <file> <logcat args…> — `adb logcat` streams stop when adb
# drops the device for a moment (run 16: both stopped at 06:52, 1 h before
# the end); start again from the newest line, so nothing is read twice.
follow_log() {
  local f=$1 first=1
  shift
  while :; do
    if [ $first = 1 ]; then adb logcat -v threadtime "$@" >>"$f" 2>&1; else adb logcat -v threadtime -T 1 "$@" >>"$f" 2>&1; fi
    first=0
    sleep 2
  done
}
follow_log "$OUT/pageno.log" -s AstarScanMlkit:I AstarScanEval:I &
PAGENO_PID=$!
# Crashes of Play services' scanner process for the whole run (run 15: the
# final `logcat -d` held only the last 20 min of the ring buffer, so 3 of
# its 8 lost sessions had no crash record). DEBUG = native tombstones.
follow_log "$OUT/scanner-deaths.log" -b main,system,crash -s DEBUG:F AndroidRuntime:E ActivityManager:I ActivityTaskManager:W GmsDocScanDelAct:E AstarScanMlkit:I &
DEATHS_PID=$!
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
      # "Discard this scan?" left over from an abandoned clip.
      # (button1 is "Discard"; matching the text would hit the title.)
      scanner-dialog) tap_now 'android:id/button1' "$GMS" || adb shell input keyevent KEYCODE_BACK ;;
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

# ML Kit's scanner process dies now and then (run 4/5/13c: a
# NullPointerException in its review carousel; run 13c: also native
# SIGSEGVs in its thumbnail loader), and the scan it held never reaches the
# app. The app therefore scans in sessions of NATIVE_PAGES_PER_SCAN pages
# (apps/web/app/services/native-scanner.ts, ML Kit's page limit) and opens
# the scanner again by itself after each full session. SESSION_MAX must be
# the same number: the check saves a session when it is full, and then
# finds the scanner open again for the next one.
SESSION_MAX=5

# scan_clip <clip> <hold indices to capture, in order>
scan_clip() {
  local clip=$1
  shift
  local plan=("$@") off=0
  log "=== $clip: capture holds ${plan[*]}"
  to_start || log "could not get back to the start screen"
  adb shell log -t AstarScanEval "clip $clip"
  while [ $off -lt ${#plan[@]} ]; do
    scan_session "$clip" "$off" "${plan[@]:off:SESSION_MAX}" || break
    off=$((off + SESSION_MAX))
  done
  close_scanner "$clip"
  clip_list "$clip"
}

# close_scanner — after the clip's last full session the app has opened the
# scanner again for more pages; leave it (no page taken) to see the list.
close_scanner() {
  local i
  for i in 1 2 3 4 5 6 7 8 9 10; do
    dump
    case $(kind) in
      app-list | app-list-empty | app-start) return 0 ;;
      app-waiting-scanner | app-other) sleep 3 ;;
      scanner-dialog)
        # "Discard this scan?" with no page in it.
        shot "$1-close-dialog"
        tap_now 'android:id/button1' "$GMS" || adb shell input keyevent KEYCODE_BACK
        sleep 3
        ;;
      scanner-camera | no-dump)
        log "$1: leaving the scanner the app opened for the next pages"
        adb shell input keyevent KEYCODE_BACK
        sleep 4
        ;;
      scanner-review)
        # Not expected (no page is taken here): keep what it holds.
        shot "$1-close-review"
        tap_now "$DOCSCAN/save_document_button" "$GMS"
        sleep 4
        ;;
      *) adb shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null; sleep 3 ;;
    esac
  done
  log "$1: still not back on the list"
  return 1
}

# scanner_failed_notice <clip> <holds of the session> — after Cancel on
# Play services' failed module screen: wait for the app, keep its screen
# and record in notices.tsv whether it showed its red notice (book-measure
# counts the session's untaken pages as "red notice", not silent, only then).
NOTICE_RE='スキャナーを開けませんでした|スキャナーが閉じられました|スキャナーが応答していません'

# lost_notice <clip> <holds of the session> — after a lost session: give
# the app up to 12 s to show its red notice (it shows it over the list, or
# over its waiting screen once it has the focus back), then record in
# notices.tsv whether it did.
lost_notice() {
  local i shown=0 text=
  for i in 1 2 3 4 5 6; do
    dump
    grep -qE "$NOTICE_RE" "$OUT/ui.xml" 2>/dev/null && break
    sleep 2
  done
  shot "$1-scanner-lost"
  if grep -qE "$NOTICE_RE" "$OUT/ui.xml" 2>/dev/null; then
    shown=1
    text=$(grep -oE "($NOTICE_RE)[^\"]*" "$OUT/ui.xml" | head -n1)
  fi
  log "$1: app after the lost session: red notice shown=$shown ${text:+($text)}"
  printf '%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "$SHOT" "$shown" "$text" >>"$OUT/notices.tsv"
}
scanner_failed_notice() {
  local i shown=0 text=
  for i in 1 2 3 4 5 6 7 8 9 10; do
    sleep 2
    dump
    case $(kind) in app-*) break ;; esac
  done
  shot "$1-scanner-failed-notice"
  if grep -qE "$NOTICE_RE" "$OUT/ui.xml" 2>/dev/null; then
    shown=1
    text=$(grep -oE "($NOTICE_RE)[^\"]*" "$OUT/ui.xml" | head -n1)
  fi
  log "$1: app after the failed scanner: red notice shown=$shown ${text:+($text)}"
  printf '%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "$SHOT" "$shown" "$text" >>"$OUT/notices.tsv"
}

# scan_session <clip> <index of its first capture in the clip> <holds>
# One ML Kit scan (at most SESSION_MAX pages), saved into the app. Returns
# 1 when nothing was saved.
scan_session() {
  local clip=$1 off=$2
  shift 2
  local plan=("$@")
  local want=${#plan[@]} m=0 adj=0 cam_shot=-1 cam_since=$SECONDS opens=0 saved=0 saved_at=0 presses=0 stop=0 pending= crop_closed=0
  local soft end
  log "--- $clip: session from capture $off, holds ${plan[*]}"
  feed "$clip" "${plan[0]}"
  # Time budget: ~75 s per page (run 3: a page that needs the manual
  # shutter takes ~60 s), at least 10 min. When it runs out, or the clip
  # is given up, whatever the scanner holds is saved so those pages still
  # reach the list; 2 more minutes are allowed for that. A session taken
  # again after a lost scan gets a budget of its own (run 13c: the third
  # try of single-port-wood started with 20 s left and saved nothing).
  budget() {
    soft=$((SECONDS + (want * 75 > 600 ? want * 75 : 600)))
    end=$((soft + 120))
  }
  budget
  # lost — the scanner closed without handing its pages to the app (Play
  # services' scanner process died: logcat has its crash). Its pages are on
  # record as not kept, and the session is taken again from its first hold.
  lost() {
    log "$clip: the scanner closed with $adj page(s) taken; they are lost, starting the session again"
    lost_notice "$clip" "${plan[*]}"
    printf '%s' "$pending" | sed 's/$/\t0/' >>"$OUT/captures.tsv"
    pending=
    adj=0
    m=0
    cam_shot=-1
    crop_closed=0
    feed "$clip" "${plan[0]}"
    budget
  }
  while [ $SECONDS -lt $end ]; do
    if [ $stop = 0 ] && [ $SECONDS -ge "$soft" ]; then
      log "$clip: time budget used up with $m / $want pages, saving what the scanner has"
      stop=1
    fi
    dump
    local k
    k=$(kind)
    case $k in
      app-start)
        [ $saved = 1 ] && break
        [ $stop = 1 ] && { log "$clip: stopped at the start screen (nothing saved)"; break; }
        [ "$adj" -gt 0 ] && lost
        opens=$((opens + 1))
        [ $opens -gt 6 ] && { log "gave up opening the scanner"; break; }
        tap_now '^スキャン$' "$PKG"
        m=0
        adj=0
        cam_since=$SECONDS
        sleep 5
        ;;
      app-waiting-scanner)
        # Saved: the app takes the pages in and opens the scanner again.
        [ $saved = 1 ] && break
        [ "$adj" -gt 0 ] && lost
        if [ $((SECONDS - cam_since)) -gt 90 ]; then
          tap_now 'もう一度スキャンを開く' "$PKG"
          cam_since=$SECONDS
        fi
        sleep 3
        ;;
      app-list | app-list-empty)
        if [ $saved = 1 ] || [ $stop = 1 ]; then
          log "$clip: back in the app"
          break
        fi
        # A later session of the clip lost to a scanner crash lands here
        # (the list holds the earlier sessions).
        [ "$adj" -gt 0 ] && lost
        opens=$((opens + 1))
        [ $opens -gt 6 ] && { log "gave up opening the scanner"; break; }
        tap_now '^追加スキャン$' "$PKG"
        m=0
        adj=0
        cam_since=$SECONDS
        sleep 5
        ;;
      dialog-full-screen) tap_now '^Got it$' ;;
      other-permissioncontroller)
        shot "$clip-permission"
        tap_now '(permission_allow_foreground_only_button|permission_allow_button|While using the app|^Allow$)' 'permissioncontroller'
        ;;
      scanner-dialog)
        shot "$clip-dialog"
        if [ $crop_closed = 1 ] && has '^Discard changes' "$GMS"; then
          # Close on Crop and rotate always asks "Discard changes?" (run
          # 14), even with nothing changed: discarding keeps the page as
          # ML Kit framed it. (This is not "Discard this scan?".)
          tap_now 'android:id/button1' "$GMS"
          crop_closed=2
        elif has '^Keep editing$' "$GMS"; then
          tap_now '^Keep editing$' "$GMS"
        else
          tap_now 'android:id/button1' "$GMS"
        fi
        ;;
      scanner-adjust-corners)
        if [ $crop_closed != 0 ]; then
          # Close did not leave the screen: apply it unchanged instead.
          log "$clip: Crop and rotate still open after Close, applying it unchanged"
          tap_now "$DOCSCAN/confirm_crop(_and_rotate)?_button" "$GMS"
          crop_closed=0
          sleep 2
          continue
        fi
        local fr
        fr=$(feed_frame)
        shot "$clip-c$adj-adjust"
        pending+=$(printf '%s\t%s\t%s\t%s\t%s' "$clip" "$((off + adj))" "${plan[$adj]:-}" "$fr" "$SHOT")$'\n'
        adj=$((adj + 1))
        # The screen is opened only to put ML Kit's frame on record; leave
        # it with Close, not Apply. Apply re-crops the page and the review
        # reloads its image: 6 of the 9 native crashes of run 13c came
        # within 1 s of an Apply here.
        if tap_now "$DOCSCAN/close_button" "$GMS"; then
          crop_closed=1
        else
          tap_now "$DOCSCAN/confirm_crop(_and_rotate)?_button" "$GMS"
        fi
        sleep 2
        ;;
      scanner-review)
        crop_closed=0
        if [ $saved = 1 ]; then
          # Save tapped; the scanner is closing.
          sleep 2
          continue
        fi
        m=$(page_count)
        if [ "$adj" -lt "$m" ]; then
          # ML Kit went straight to the review: open the newest page's
          # corners so its frame is on record too.
          tap_now "Page $m of $m" "$GMS" || true
          sleep 1
          dump
          if ! tap_now "$DOCSCAN/edit_menu_crop_and_rotate_button" "$GMS"; then adj=$m; fi
          sleep 2
        elif [ "$m" -lt "$want" ] && [ $stop = 0 ]; then
          [ "$m" -le 1 ] && shot "$clip-review"
          feed "$clip" "${plan[$m]}"
          tap_now "$DOCSCAN/add_page" "$GMS" || tap_now '^Add page' "$GMS"
          cam_since=$SECONDS
          sleep 2
        else
          shot "$clip-review-final"
          tap_now "$DOCSCAN/save_document_button" "$GMS"
          saved=1
          saved_at=$SECONDS
          printf '%s' "$pending" | sed 's/$/\t1/' >>"$OUT/captures.tsv"
          pending=
          sleep 4
        fi
        ;;
      *)
        if [ $saved = 1 ]; then
          # The scan is saved; a scanner camera now is the one the app
          # opened for the next session (or the closing scanner, a few s).
          if [ "$k" = scanner-camera ] || [ $((SECONDS - saved_at)) -gt 10 ]; then
            log "$clip: saved; the app opened the scanner again ($k)"
            break
          fi
          sleep 2
          continue
        fi
        # Play services updating the scanner module in front of it: wait
        # while it downloads; when it fails ("Something went wrong", run
        # 16: the check stood there for the whole 10 min budget), cancel it
        # so the app gets the scan back closed and opens the scanner again.
        if [ "$k" = other-gms ]; then
          if has '^Something went wrong' "$GMS"; then
            shot "$clip-module-update-failed"
            log "$clip: Play services could not update the scanner module; cancelling to open the scanner again"
            tap_now '^Cancel$' "$GMS" || adb shell input keyevent KEYCODE_BACK
            scanner_failed_notice "$clip" "${plan[*]}"
          else
            sleep 5
          fi
          continue
        fi
        # ML Kit's live camera (usually not dumpable while the preview runs).
        crop_closed=0
        if [ $stop = 1 ]; then
          # Out of time / gave up: back to the review to save the pages
          # taken so far (none taken: nothing to save).
          [ "$m" -eq 0 ] && [ "$adj" -eq 0 ] && { log "$clip: stopping with no page taken"; break; }
          shot "$clip-stop-camera"
          # The page-count thumbnail opens the review (Back would ask to
          # discard the scan).
          tap_now "$DOCSCAN/preview_thumbnail" "$GMS" || adb shell input keyevent KEYCODE_BACK
          sleep 3
        elif [ "$cam_shot" != "$m" ] && [ $((SECONDS - cam_since)) -ge 2 ]; then
          shot "$clip-c$m-camera"
          cam_shot=$m
          presses=0
          diag
        elif [ $((SECONDS - cam_since)) -gt 15 ]; then
          # No auto-capture within 15 s: press the shutter (manual). Give
          # the clip up after a few presses that took nothing, so one
          # stuck clip cannot eat the whole job (the pages taken so far
          # are still saved).
          shot "$clip-c$m-no-autocapture"
          # The screenshot's fresh dump may show the review (ML Kit took
          # the page meanwhile): never press a "shutter" there (run 13c
          # pressed the carousel's "Page 4 of 6" as one).
          k=$(kind)
          if [ "$k" != no-dump ] && [ "$k" != scanner-camera ]; then
            log "$clip c$m: the screen is $k now, not the camera; no shutter press"
            continue
          fi
          presses=$((presses + 1))
          if [ "$presses" -gt 3 ]; then
            log "$clip c$m: nothing captured after 3 shutter presses, giving the clip up"
            stop=1
            continue
          fi
          local p
          if p=$(python3 "$HERE/ui.py" shutter "$OUT/ui.xml" 2>>"$OUT/steps.log"); then
            log "$clip c$m: no auto-capture in 15 s, pressing the shutter at $p ($(tail -n1 "$OUT/steps.log"))"
            # shellcheck disable=SC2086
            adb shell input tap $p
          else
            log "$clip c$m: no auto-capture in 15 s and no shutter in the dump, tapping 540 2150"
            adb shell input tap 540 2150
          fi
          cam_since=$SECONDS
        fi
        sleep 1
        ;;
    esac
  done
  log "$clip: scanner loop ended (pages in scanner: $m / $want, saved=$saved)"
  # Pages of a scan that never reached the app: on record, marked not kept.
  [ -n "$pending" ] && printf '%s' "$pending" | sed 's/$/\t0/' >>"$OUT/captures.tsv"
  [ $saved = 1 ]
}

# clip_list <clip> — the app's page list after the clip.
clip_list() {
  local clip=$1
  # Wait for the page-number OCR, then keep the list at a few scroll
  # positions (book-measure.py merges them).
  # The app first takes the last session's pages in (取り込み中, on its
  # start screen: run 15 shot 3 of spread-port-white's 7 list screens
  # there), then reads their numbers.
  local t_end=$((SECONDS + 420))
  while [ $SECONDS -lt $t_end ]; do
    dump
    grep -qE '取り込み中|読み取り中|読み取り準備中' "$OUT/ui.xml" || break
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
kill "$PAGENO_PID" "$DEATHS_PID" 2>/dev/null || true
pkill -f 'adb logcat -v threadtime' 2>/dev/null || true
log "scanner process deaths: $(grep -c 'gms.ui (pid [0-9]*) has died' "$OUT/scanner-deaths.log"); native crashes: $(grep -c 'F DEBUG *: pid:.*gms.ui' "$OUT/scanner-deaths.log"); Java crashes: $(grep -c 'FATAL EXCEPTION' "$OUT/scanner-deaths.log")"
log "done"
exit 0
