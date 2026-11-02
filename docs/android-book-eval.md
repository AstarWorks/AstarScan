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

| Run | Commit  | What changed                                                                                                                              | Pages captured / 60                                                                                                                                                                                                                     | Corner error (clip px)                                                                                                                                                                           | Silent misses (無表示)         |
| --- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------ |
| 1   | a1b5917 | first run with the loopback webcam                                                                                                        | 0 (ML Kit never auto-captured; the blind shutter tap at 540,2005 did not capture; 2 pages appeared later in the review of clip 2, origin unknown)                                                                                       | 未確認 (no adjust-corners screen)                                                                                                                                                                | 60 (no page reached the list)  |
| 2   | 66df62f | shutter found from the UI dump; a clip is given up after 3 presses; camera diagnostics in the job log; screenshot zip reaches the release | 1 (ML Kit auto-captured p2 of spread-land-wood within ~10 s; the check then mistook the new "Crop and rotate" screen for the camera and pressed its Apply as the shutter, and kept that one page through every clip via "Keep editing") | not scored (the screen was not recognised); by eye: the frame is on the left page, its two right handles sit on the right edge of the visible image, not the gutter — the right page was cut off | 59 (nothing saved to the list) |

Run 2 finding: the portrait scanner shows only a 3:4 window at the left
of the 1280×960 webcam frame (columns 0–719), upright. The feed had
centred the spread in the full 4:3 frame, so the right page fell
outside. ![run 2 crop screen](images/android-book-eval/run2-crop-spread-land-wood-p2.png)
