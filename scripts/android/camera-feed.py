"""Play the book clips on a v4l2loopback device for the emulator's back camera.

    python3 -I camera-feed.py <clips-dir> <control-file> <status-file> \
        [--device /dev/video0] [--size 1280x960] [--fps 10] [--rotate-landscape]

The emulator is started with `-camera-back webcam0`, so whatever this
writes to the loopback device is what ML Kit's scanner sees.

The emulator check (emulator-check.sh) steers playback by writing one
line to <control-file>:

    <clip> <hold-index>

and the feed then plays that clip from where it is, through the page
turn, into the <hold-index>-th "hold" segment of the ground truth (the
book held still on one spread), and keeps showing that hold (played
forward and back, so the hand shake continues and nothing jumps) until
the next command. This is a user who turns a page and then waits for the
scanner to take it. A new clip starts at its first hold.

<status-file> gets "<clip> <frame>" for every frame written, so the
check can tell which ground-truth frame the camera showed when ML Kit
captured.

Frame layout: every clip frame is fitted into the output size (4:3) and
the border is filled by repeating the edge pixels (no black bars that
could look like a page edge). Portrait clips are rotated a quarter turn
so the book fills the sensor's landscape frame the same way a phone
held upright sees it. `layout()` is the single place that defines the
mapping, and book-measure.py imports it to map ground-truth corners into
the camera frame.
"""

import argparse
import json
import os
import subprocess
import sys
import time

import cv2
import numpy as np


def layout(clip_w, clip_h, out_w, out_h):
    """Return (rotate, scale, off_x, off_y): clip px -> output px.

    rotate: 0 or 90 (counter-clockwise quarter turn applied first for
    portrait clips: the back camera sensor is mounted at 90°, so the
    phone shows the sensor frame turned clockwise). Then the (rotated) clip is scaled by `scale` and placed at
    (off_x, off_y).
    """
    rotate = 90 if clip_h > clip_w else 0
    rw, rh = (clip_h, clip_w) if rotate else (clip_w, clip_h)
    scale = min(out_w / rw, out_h / rh)
    off_x = (out_w - rw * scale) / 2
    off_y = (out_h - rh * scale) / 2
    return rotate, scale, off_x, off_y


def map_point(x, y, clip_w, clip_h, out_w, out_h):
    """Clip pixel -> output (camera frame) pixel, same as render_frame."""
    rotate, scale, ox, oy = layout(clip_w, clip_h, out_w, out_h)
    if rotate:
        # cv2.ROTATE_90_COUNTERCLOCKWISE: (x, y) -> (y, W - 1 - x)
        x, y = y, clip_w - 1 - x
    return x * scale + ox, y * scale + oy


def render_frame(frame, out_w, out_h):
    h, w = frame.shape[:2]
    rotate, scale, ox, oy = layout(w, h, out_w, out_h)
    if rotate:
        frame = cv2.rotate(frame, cv2.ROTATE_90_COUNTERCLOCKWISE)
    rh, rw = frame.shape[:2]
    nw, nh = round(rw * scale), round(rh * scale)
    small = cv2.resize(frame, (nw, nh), interpolation=cv2.INTER_AREA)
    left = round(ox)
    top = round(oy)
    return cv2.copyMakeBorder(
        small, top, out_h - nh - top, left, out_w - nw - left, cv2.BORDER_REPLICATE
    )


class Clip:
    def __init__(self, clips_dir, name, out_w, out_h, fps):
        with open(os.path.join(clips_dir, f"{name}.gt.json")) as f:
            gt = json.load(f)
        self.name = name
        self.src_fps = gt["fps"]
        self.holds = [s for s in gt["segments"] if s["phase"] == "hold"]
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
                out = render_frame(fr, out_w, out_h)
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
    a = ap.parse_args()
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
                hold, direction = h, 1
                print(f"[feed] -> {name} hold {h}", flush=True)
            except (IndexError, ValueError, OSError) as e:
                print(f"[feed] bad command {cmd!r}: {e}", flush=True)

        seg = clip.holds[hold]
        start, end = seg["start_frame"], seg["end_frame"] - 1
        if pos < start or pos > end:
            # Play the page turn (forward) or jump back to an earlier hold.
            pos = pos + clip.step if pos < start else start
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

        t_next += period
        delay = t_next - time.monotonic()
        if delay > 0:
            time.sleep(delay)
        else:
            t_next = time.monotonic()


if __name__ == "__main__":
    sys.exit(main())
