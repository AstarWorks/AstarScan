"""Play the book clips on a v4l2loopback device for the emulator's back camera.

    python3 -I camera-feed.py <clips-dir> <control-file> <status-file> \
        [--device /dev/video0] [--size 1280x960] [--fps 10] [--log feed.log]

The emulator is started with `-camera-back webcam0`, so whatever this
writes to the loopback device is what the app's capture screen sees.

The emulator check (emulator-check.sh) steers playback by writing one
line to <control-file>:

    <clip> <hold-index>

and the feed then plays that clip from where it is, through the page
turn, into the <hold-index>-th "hold" segment of the ground truth (the
book held still on one spread), and keeps showing that hold (played
forward and back, so the hand shake continues and nothing jumps) until
the next command. This is a user who turns a page and then waits for the
app to take it. A new clip starts at its first hold.

- The next hold: the page turn in between is played.
- A hold further on (a page skipped on purpose): the feed jumps to the
  start of the turn just before it, so the skipped page is never held
  still in front of the camera (the app would take it).
- An earlier hold (going back for a missing page): the turn just after
  it is played backwards, like turning the leaf back.

--log gets "<unix time> <clip> <frame> <hold>" for every frame written,
so book-measure.py can tell which clip frame the app took a page from.

<status-file> gets "<clip> <frame>" for every frame written, so the
check can tell which ground-truth frame the camera showed when ML Kit
captured.

Frame layout: the part of every clip frame around the target pages
(clip_box(): like a phone held so the book fills the screen) is fitted,
upright, into the part of the webcam frame the scanner shows (window(): a
3:4 portrait window at the left of the 4:3 frame) and the rest is filled
by repeating the edge pixels (no black bars that could look like a page
edge). `layout()` is the single place that defines the mapping, and
book-measure.py imports it to map ground-truth corners into the camera
frame.
"""

import argparse
import json
import os
import subprocess
import sys
import time

import cv2
import numpy as np


# Which part of the webcam frame the phone shows: "window" (ML Kit's
# scanner: the left 3:4, see window()) or "full" (the app's own capture
# screen, CameraX: the whole frame). Set with --view / FEED_VIEW.
VIEW = os.environ.get("FEED_VIEW", "window")


def window(out_w, out_h):
    """The part of the webcam frame the phone actually sees: (x, y, w, h).

    Emulator run 2 showed that the portrait scanner takes a 3:4 portrait
    window from the left of the landscape webcam frame (a 1280×960 frame
    -> columns 0–719, all rows), upright, not rotated. Anything outside
    it never reaches ML Kit. With VIEW "full" the whole frame.
    """
    if VIEW == "full":
        return 0, 0, out_w, out_h
    w = min(out_w, round(out_h * 3 / 4))
    return 0, 0, w, out_h


BOX_MARGIN = 0.06  # share of the target box added on every side


def clip_box(gt):
    """The part of the clip the phone is held over: (x0, y0, x1, y1).

    The box around the target pages' corners over every hold of the clip
    (so hand shake stays inside), plus BOX_MARGIN on every side. A user
    fills the screen with the book (one page in a "single" clip, the open
    spread in a "spread" clip) instead of filming the whole desk; run 3
    showed the page numbers were unreadable when the whole 16:9 clip was
    squeezed into the 720 px wide window.

    Clips framed ahead of time (scripts/eval/book-clips/frame.py: per hold,
    the paper at ~88–90 % of the window's limiting side, ground truth in
    the framed clip's pixels; gt "framing") are shown whole: the box is the
    clip itself, so a 720x960 clip lands 1:1 in the 720x960 window.
    """
    if gt.get("framing"):
        return 0.0, 0.0, float(gt["W"]), float(gt["H"])
    xs, ys = [], []
    for s in gt["segments"]:
        if s["phase"] != "hold":
            continue
        for fr in gt["frames"][s["start_frame"] : s["end_frame"]]:
            for p in fr["pages"]:
                if p.get("target"):
                    for x, y in p["corners"].values():
                        xs.append(x)
                        ys.append(y)
    if not xs:
        return 0.0, 0.0, float(gt["W"]), float(gt["H"])
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    mx, my = (x1 - x0) * BOX_MARGIN, (y1 - y0) * BOX_MARGIN
    return x0 - mx, y0 - my, x1 + mx, y1 + my


def layout(clip_w, clip_h, out_w, out_h, box=None):
    """Return (rotate, scale, off_x, off_y): clip px -> output px.

    rotate is always 0 (kept for book-measure.py). The clip is scaled by
    `scale` so that `box` (default: the whole clip) fits the visible
    window(), centred in it, upright.
    """
    wx, wy, ww, wh = window(out_w, out_h)
    bx0, by0, bx1, by1 = box if box else (0, 0, clip_w, clip_h)
    scale = min(ww / (bx1 - bx0), wh / (by1 - by0))
    off_x = wx + ww / 2 - (bx0 + bx1) / 2 * scale
    off_y = wy + wh / 2 - (by0 + by1) / 2 * scale
    return 0, scale, off_x, off_y


def map_point(x, y, clip_w, clip_h, out_w, out_h, box=None):
    """Clip pixel -> output (camera frame) pixel, same as render_frame."""
    rotate, scale, ox, oy = layout(clip_w, clip_h, out_w, out_h, box)
    if rotate:
        # cv2.ROTATE_90_COUNTERCLOCKWISE: (x, y) -> (y, W - 1 - x)
        x, y = y, clip_w - 1 - x
    return x * scale + round(ox), y * scale + round(oy)


def render_frame(frame, out_w, out_h, box=None):
    h, w = frame.shape[:2]
    rotate, scale, ox, oy = layout(w, h, out_w, out_h, box)
    if rotate:
        frame = cv2.rotate(frame, cv2.ROTATE_90_COUNTERCLOCKWISE)
    rh, rw = frame.shape[:2]
    nw, nh = round(rw * scale), round(rh * scale)
    small = cv2.resize(frame, (nw, nh), interpolation=cv2.INTER_AREA)
    # Whole-pixel shift; what falls outside the clip repeats its edge
    # pixels (no black bars that could look like a page edge).
    m = np.float32([[1, 0, round(ox)], [0, 1, round(oy)]])
    return cv2.warpAffine(
        small, m, (out_w, out_h), flags=cv2.INTER_NEAREST, borderMode=cv2.BORDER_REPLICATE
    )


class Clip:
    def __init__(self, clips_dir, name, out_w, out_h, fps):
        with open(os.path.join(clips_dir, f"{name}.gt.json")) as f:
            gt = json.load(f)
        self.name = name
        self.src_fps = gt["fps"]
        self.holds = [s for s in gt["segments"] if s["phase"] == "hold"]
        self.box = clip_box(gt)
        # Keep every k-th source frame (as JPEG, to keep memory small).
        self.step = max(1, round(self.src_fps / fps))
        cap = cv2.VideoCapture(os.path.join(clips_dir, f"{name}.mp4"))
        self.frames = {}
        i = 0
        while True:
            ok, fr = cap.read()
            if not ok:
                break
            if i % self.step == 0:
                out = render_frame(fr, out_w, out_h, self.box)
                self.frames[i] = cv2.imencode(".jpg", out, [cv2.IMWRITE_JPEG_QUALITY, 92])[1]
            i += 1
        self.n = i
        print(f"[feed] loaded {name}: {i} frames, {len(self.holds)} holds", flush=True)

    def image(self, i):
        i = min(max(0, i - i % self.step), max(self.frames))
        return cv2.imdecode(self.frames[i], cv2.IMREAD_COLOR)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("clips")
    ap.add_argument("control")
    ap.add_argument("status")
    ap.add_argument("--device", default="/dev/video0")
    ap.add_argument("--size", default="1280x960")
    ap.add_argument("--fps", type=int, default=10)
    ap.add_argument("--first", default="spread-land-wood")
    ap.add_argument("--log")
    ap.add_argument("--view", choices=("window", "full"))
    a = ap.parse_args()
    global VIEW
    if a.view:
        VIEW = a.view
    print(f"[feed] view {VIEW}", flush=True)
    out_w, out_h = map(int, a.size.split("x"))

    ff = subprocess.Popen(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "warning",
            "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{out_w}x{out_h}",
            "-r", str(a.fps), "-i", "-",
            "-f", "v4l2", "-pix_fmt", "yuyv422", a.device,
        ],
        stdin=subprocess.PIPE,
    )

    clips = {}

    def get(name):
        if name not in clips:
            clips.clear()  # one clip in memory at a time
            clips[name] = Clip(a.clips, name, out_w, out_h, a.fps)
        return clips[name]

    clip = get(a.first)
    hold = 0
    pos = clip.holds[0]["start_frame"]
    direction = 1
    log = open(a.log, "a", buffering=1) if a.log else None
    last_cmd = None
    period = 1.0 / a.fps
    t_next = time.monotonic()
    while True:
        try:
            with open(a.control) as f:
                cmd = f.read().strip()
        except FileNotFoundError:
            cmd = ""
        if cmd and cmd != last_cmd:
            last_cmd = cmd
            parts = cmd.split()
            try:
                name, h = parts[0], int(parts[1])
                new = get(name)
                h = min(max(0, h), len(new.holds) - 1)
                if new is not clip:
                    clip, pos = new, new.holds[h]["start_frame"]
                elif h > hold + 1:
                    # Skip: straight to the turn before hold h.
                    pos = new.holds[h - 1]["end_frame"]
                elif h < hold:
                    # Back: from the start of hold h + 1, the turn played backwards.
                    pos = new.holds[h + 1]["start_frame"]
                hold, direction = h, 1
                print(f"[feed] -> {name} hold {h}", flush=True)
            except (IndexError, ValueError, OSError) as e:
                print(f"[feed] bad command {cmd!r}: {e}", flush=True)

        seg = clip.holds[hold]
        start, end = seg["start_frame"], seg["end_frame"] - 1
        if pos < start or pos > end:
            # Play the page turn: forward to a later hold, backwards to an earlier one.
            pos = min(pos + clip.step, start) if pos < start else max(pos - clip.step, end)
            direction = 1
        else:
            nxt = pos + direction * clip.step
            if nxt > end or nxt < start:
                direction = -direction
                nxt = pos + direction * clip.step
            pos = min(max(nxt, start), end)

        try:
            ff.stdin.write(clip.image(pos).tobytes())
            ff.stdin.flush()
        except BrokenPipeError:
            print("[feed] ffmpeg exited", file=sys.stderr, flush=True)
            return 1
        tmp = a.status + ".tmp"
        with open(tmp, "w") as f:
            f.write(f"{clip.name} {pos}\n")
        os.replace(tmp, a.status)
        if log:
            log.write(f"{time.time():.3f} {clip.name} {pos} {hold}\n")

        t_next += period
        delay = t_next - time.monotonic()
        if delay > 0:
            time.sleep(delay)
        else:
            t_next = time.monotonic()


if __name__ == "__main__":
    sys.exit(main())
