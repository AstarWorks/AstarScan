# Android (ML Kit scanner) — book clips on the emulator camera

The CI job `android-emulator` plays the five synthetic book clips of
`scripts/eval/book-clips/clips` (60 target pages, ground truth in the
`*.gt.json` next to them) on the Android emulator's back camera and
scans them with the AstarScan app (Google ML Kit Document Scanner).

## How the book reaches the camera

`v4l2loopback` + `ffmpeg`: `scripts/android/camera-feed.py` writes the
clip frames to `/dev/video0` (a loopback webcam, label `BookCam`), and
the emulator is started with `-camera-back webcam0`. The check script
(`scripts/android/emulator-check.sh`) tells the feed which spread to
hold, and turns the page after each capture.

Why not virtualscene with a replaced poster: the poster is a small
texture far away in the virtual room and the camera there moves with
the device sensors; the book would never fill the frame like a phone
held over it, and the corner ground truth could not be mapped to the
frame. The loopback webcam gives the exact clip frame (fitted to
1280×960), so `book-measure.py` can map the ground-truth corners onto
what ML Kit saw. GitHub's `ubuntu-latest` runner loads `v4l2loopback`
(run 1 log: `Camera 'BookCam' can be specified by label as 'webcam0'`).

## Runs

| Run | Commit | What changed | Pages captured / 60 | Corner error (clip px) | Silent misses (無表示) |
| --- | --- | --- | --- | --- | --- |
| 1 | a1b5917 | first run with the loopback webcam | 0 (ML Kit never auto-captured; the blind shutter tap at 540,2005 did not capture; 2 pages appeared later in the review of clip 2, origin unknown) | 未確認 (no adjust-corners screen) | 60 (no page reached the list) |
