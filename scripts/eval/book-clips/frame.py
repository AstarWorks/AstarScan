"""Frame the book clips the way a user holds the phone: the paper fills the view.

    python3 -I frame.py <src-clips-dir> <out-dir> [--size 720x960] [--fill 0.88] [--crf 16] [clip ...]

The rendered clips in `clips/` (render.py, branch `eval-book-clips`) show
the whole open book on the desk in a 16:9 or 9:16 frame. A user scanning a
book does not film the desk: they hold the phone so the page (single clips:
the right page) or the open spread (spread clips) fills about 85–90 % of
the screen, all four corners in view with a little desk around them, and
re-frame after every page turn.

The Android emulator's back camera cannot go above a 1280x960 webcam frame,
of which the phone sees a 720x960 portrait window (camera-feed.py window();
run 10 tried 1440p: black preview). So the clips are framed here, ahead of
time, at exactly that window (720x960, 3:4 portrait):

- per hold (the book held still on one page / spread): the box around the
  target pages' outline (corners and curved top / bottom edges) over every
  frame of the hold — the hand shake stays inside — is centred in a 3:4
  crop sized so the box takes FILL (default 0.90) of the crop's limiting
  side. A single page (148 x 210 mm, ~0.70 : 1) is limited by the height,
  so it fills ~88–90 % of the height; a spread (~1.4 : 1) is limited by the
  width: a phone held upright over an open spread can fill only the width,
  and the spread takes ~45 % of the height. That is what a real phone held
  upright sees too, so spreads are not stretched or cut to fill more;
- during a page turn the crop moves smoothly (smoothstep) from the box of
  the hold before to the box of the hold after (the user follows the book);
- what falls outside the source frame repeats its edge pixels, as
  camera-feed.py does.

The page-number font is the one render.py drew (body size, ~10 pt on a
148 x 210 mm page); framing only scales the whole picture, the same for
the folio as for everything else. Source clips are downscaled (no upscaling
except single-land-white, ~1.1x), so the print is as sharp as the
renderer made it.

The ground truth is written in the framed clip's pixels: every corner and
edge point goes through the same crop, `W`/`H` become the window size,
`in_frame` is recomputed for the new frame, and `framing` records the crop
of every frame (x0, y0, scale: framed = (source - (x0, y0)) * scale) and the
settings. camera-feed.py sees `framing` and shows the whole clip in the
window as it is (scale 1, no second crop).
"""

import argparse
import json
import os
import subprocess
import sys

import cv2
import numpy as np

CLIPS = ["spread-land-wood", "spread-port-white", "spread-land-white-thick", "single-port-wood", "single-land-white"]


def outline(p):
    pts = list(p["corners"].values()) + p.get("edge_top", []) + p.get("edge_bottom", [])
    return [(float(x), float(y)) for x, y in pts]


def hold_boxes(gt):
    """Box (x0, y0, x1, y1) of the target pages over each hold, in source px."""
    out = []
    for s in gt["segments"]:
        if s["phase"] != "hold":
            continue
        xs, ys = [], []
        for fr in gt["frames"][s["start_frame"] : s["end_frame"]]:
            for p in fr["pages"]:
                if p.get("target"):
                    for x, y in outline(p):
                        xs.append(x)
                        ys.append(y)
        out.append((s, (min(xs), min(ys), max(xs), max(ys))))
    return out


def crop_for(box, out_w, out_h, fill):
    """3:4 crop (cx, cy, crop_w) holding `box` at `fill` of the limiting side."""
    x0, y0, x1, y1 = box
    bw, bh = x1 - x0, y1 - y0
    cw = max(bw / fill, bh / fill * out_w / out_h)
    return ((x0 + x1) / 2, (y0 + y1) / 2, cw)


def per_frame_crops(gt, out_w, out_h, fill):
    holds = [(s, crop_for(b, out_w, out_h, fill)) for s, b in hold_boxes(gt)]
    crops = []
    for i in range(gt["n_frames"]):
        prev = next_ = None
        for s, c in holds:
            if s["start_frame"] <= i < s["end_frame"]:
                prev = next_ = (s, c)
                break
            if s["end_frame"] <= i:
                prev = (s, c)
            elif next_ is None and s["start_frame"] > i:
                next_ = (s, c)
        if prev is None:
            prev = next_
        if next_ is None:
            next_ = prev
        if prev is next_:
            crops.append(prev[1])
            continue
        a, b = prev[0]["end_frame"], next_[0]["start_frame"]
        t = (i - a + 1) / max(1, b - a + 1)
        t = t * t * (3 - 2 * t)
        crops.append(tuple(pa + (pb - pa) * t for pa, pb in zip(prev[1], next_[1])))
    return crops


def inside_share(pts, w, h):
    q = np.float32(pts[:4]).reshape(-1, 2)
    area = abs(cv2.contourArea(q))
    if area <= 0:
        return 0.0
    rect = np.float32([[0, 0], [w, 0], [w, h], [0, h]])
    inter, _ = cv2.intersectConvexConvex(q, rect)
    return round(min(1.0, inter / area), 3)


def frame_clip(src_dir, out_dir, name, out_w, out_h, fill, crf):
    with open(os.path.join(src_dir, f"{name}.gt.json")) as f:
        gt = json.load(f)
    crops = per_frame_crops(gt, out_w, out_h, fill)
    xf = []
    for cx, cy, cw in crops:
        k = out_w / cw
        xf.append((cx - cw / 2, cy - cw * out_h / out_w / 2, k))

    cap = cv2.VideoCapture(os.path.join(src_dir, f"{name}.mp4"))
    mp4 = os.path.join(out_dir, f"{name}.mp4")
    enc = subprocess.Popen(
        [
            "ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{out_w}x{out_h}",
            "-r", str(gt["fps"]), "-i", "-", "-c:v", "libx264", "-preset", "slow", "-crf", str(crf),
            "-g", "60", "-pix_fmt", "yuv420p", "-movflags", "+faststart", mp4,
        ],
        stdin=subprocess.PIPE,
    )
    i = 0
    while True:
        ok, fr = cap.read()
        if not ok:
            break
        x0, y0, k = xf[min(i, len(xf) - 1)]
        m = np.float32([[k, 0, -x0 * k], [0, k, -y0 * k]])
        interp = cv2.INTER_AREA if k < 1 else cv2.INTER_CUBIC
        if k < 1:
            # INTER_AREA is not supported by warpAffine: shrink first, then shift.
            small = cv2.resize(fr, None, fx=k, fy=k, interpolation=cv2.INTER_AREA)
            m = np.float32([[1, 0, -x0 * k], [0, 1, -y0 * k]])
            out = cv2.warpAffine(small, m, (out_w, out_h), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        else:
            out = cv2.warpAffine(fr, m, (out_w, out_h), flags=interp, borderMode=cv2.BORDER_REPLICATE)
        enc.stdin.write(out.tobytes())
        i += 1
    enc.stdin.close()
    if enc.wait() != 0:
        raise SystemExit(f"ffmpeg failed for {name}")
    if i != gt["n_frames"]:
        print(f"[frame] {name}: {i} frames decoded, gt has {gt['n_frames']}", file=sys.stderr)

    def tr(pt, j):
        x0, y0, k = xf[j]
        return [round((pt[0] - x0) * k, 1), round((pt[1] - y0) * k, 1)]

    for fr in gt["frames"]:
        j = fr["i"]
        for p in fr["pages"]:
            p["corners"] = {c: tr(v, j) for c, v in p["corners"].items()}
            for key in ("edge_top", "edge_bottom"):
                if key in p:
                    p[key] = [tr(v, j) for v in p[key]]
            order = [p["corners"][c] for c in ("tl", "tr", "br", "bl")]
            p["in_frame"] = inside_share(order, out_w, out_h)
    src_w, src_h = gt["W"], gt["H"]
    gt["W"], gt["H"] = out_w, out_h
    fills = []
    for s, b in hold_boxes(gt):
        fr = gt["frames"][(s["start_frame"] + s["end_frame"]) // 2]
        xs = [x for p in fr["pages"] if p.get("target") for x, _ in outline(p)]
        ys = [y for p in fr["pages"] if p.get("target") for _, y in outline(p)]
        fills.append([round((max(xs) - min(xs)) / out_w, 3), round((max(ys) - min(ys)) / out_h, 3)])
    gt["framing"] = {
        "source": f"clips/{name}.mp4 ({src_w}x{src_h})",
        "how": "frame.py: per hold, the target pages' outline box at FILL of the 3:4 crop's limiting side; smoothstep between holds",
        "fill": fill,
        "hold_fill_wh": fills,
        "crop_x0_y0_scale": [[round(a, 2), round(b, 2), round(k, 5)] for a, b, k in xf],
    }
    with open(os.path.join(out_dir, f"{name}.gt.json"), "w") as f:
        json.dump(gt, f, ensure_ascii=False, separators=(",", ":"))
    print(f"[frame] {name}: {i} frames, scale {min(k for _, _, k in xf):.3f}–{max(k for _, _, k in xf):.3f}, "
          f"hold fill (w, h) {fills[0]} … {fills[-1]}, {os.path.getsize(mp4) / 1e6:.1f} MB", flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("out")
    ap.add_argument("clips", nargs="*")
    ap.add_argument("--size", default="720x960")
    ap.add_argument("--fill", type=float, default=0.90)
    ap.add_argument("--crf", type=int, default=18)
    a = ap.parse_args()
    out_w, out_h = map(int, a.size.split("x"))
    os.makedirs(a.out, exist_ok=True)
    for name in a.clips or CLIPS:
        frame_clip(a.src, a.out, name, out_w, out_h, a.fill, a.crf)


if __name__ == "__main__":
    sys.exit(main())
