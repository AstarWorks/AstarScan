#!/usr/bin/env python3
"""Page images for the emulator check's ML Kit page-number probe.

    python3 -I probe-pages.py <clips_dir> <out_dir> [--feeds 1280x960,1920x1440]

For the middle frame of every hold of every clip, the target page (a
"single" clip) or the open spread (a "spread" clip) is cut out with the
ground-truth corners (as page-number-ocr.py does) at several sizes:

  emu<W>   the frame as the emulator camera shows it with a <W>×<H> feed
           (camera-feed.py: clip_box() fitted into the 3:4 window the
           scanner sees), JPEG q92 like the feed
  clip     the clip frame itself

and written to <out_dir>/ocr-probe/<res>__<clip>__h<hold>.jpg, with
<out_dir>/probe-truth.json ({file: {clip, hold, res, truth}}).
emulator-check.sh pushes ocr-probe/ into the app's external files dir;
the app reads every image there with its ML Kit band pass on start
(ScannerPlugin.load, "probe" log lines), so the same ML Kit reader is
measured on the clip's own pixels and on the emulator camera's — the
difference is what the camera resolution costs.
"""

import argparse
import importlib.util
import json
import os

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("camera_feed", os.path.join(HERE, "camera-feed.py"))
camera_feed = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(camera_feed)


def warp_quad(frame, quad):
    """Same as page-number-ocr.py (which needs onnxruntime to import)."""
    tl, tr, br, bl = [np.float32(p) for p in quad]
    w = int(round((np.linalg.norm(tr - tl) + np.linalg.norm(br - bl)) / 2))
    h = int(round((np.linalg.norm(bl - tl) + np.linalg.norm(br - tr)) / 2))
    m = cv2.getPerspectiveTransform(
        np.float32([tl, tr, br, bl]), np.float32([[0, 0], [w - 1, 0], [w - 1, h - 1], [0, h - 1]])
    )
    return cv2.warpPerspective(frame, m, (w, h), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)


def holds(gt):
    """Same as page-number-ocr.py: (hold, frame, quad, truth) per hold."""
    for hi, s in enumerate(s for s in gt["segments"] if s["phase"] == "hold"):
        fi = (s["start_frame"] + s["end_frame"] - 1) // 2
        fr = gt["frames"][fi]
        tgt = [p for p in fr["pages"] if p.get("target")]
        if not tgt:
            continue
        if gt["mode"] == "spread" and len(tgt) == 2:
            left = next(p for p in tgt if p["side"] == "left")
            right = next(p for p in tgt if p["side"] == "right")
            quad = [left["corners"]["tl"], right["corners"]["tr"], right["corners"]["br"], left["corners"]["bl"]]
            truth = [left["page"], right["page"]]
        else:
            p = tgt[0]
            quad = [p["corners"][k] for k in ("tl", "tr", "br", "bl")]
            truth = [p["page"]]
        yield hi, fi, quad, truth


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("clips_dir")
    ap.add_argument("out_dir")
    ap.add_argument("--feeds", default="1280x960,1920x1440")
    a = ap.parse_args()
    feeds = [tuple(map(int, s.split("x"))) for s in a.feeds.split(",") if s]
    img_dir = os.path.join(a.out_dir, "ocr-probe")
    os.makedirs(img_dir, exist_ok=True)
    truth_out = {}
    names = sorted(f[: -len(".gt.json")] for f in os.listdir(a.clips_dir) if f.endswith(".gt.json"))
    for name in names:
        with open(os.path.join(a.clips_dir, f"{name}.gt.json")) as f:
            gt = json.load(f)
        box = camera_feed.clip_box(gt)
        cap = cv2.VideoCapture(os.path.join(a.clips_dir, f"{name}.mp4"))
        for hi, fi, quad, truth in holds(gt):
            cap.set(cv2.CAP_PROP_POS_FRAMES, fi)
            ok, frame = cap.read()
            if not ok:
                continue
            variants = {"clip": warp_quad(frame, quad)}
            for fw, fh in feeds:
                _, scale, _, _ = camera_feed.layout(gt["W"], gt["H"], fw, fh, box)
                small = cv2.resize(
                    frame, (round(frame.shape[1] * scale), round(frame.shape[0] * scale)), interpolation=cv2.INTER_AREA
                )
                small = cv2.imdecode(cv2.imencode(".jpg", small, [cv2.IMWRITE_JPEG_QUALITY, 92])[1], cv2.IMREAD_COLOR)
                variants[f"emu{fw}"] = warp_quad(small, [(x * scale, y * scale) for x, y in quad])
            for res, page in variants.items():
                fn = f"{res}__{name}__h{hi:02d}.jpg"
                cv2.imwrite(os.path.join(img_dir, fn), page, [cv2.IMWRITE_JPEG_QUALITY, 95])
                truth_out[fn] = {"clip": name, "hold": hi, "frame": fi, "res": res, "truth": truth,
                                 "w": page.shape[1], "h": page.shape[0]}
    with open(os.path.join(a.out_dir, "probe-truth.json"), "w") as f:
        json.dump(truth_out, f, indent=1)
    print(f"[probe] {len(truth_out)} page images in {img_dir}")


if __name__ == "__main__":
    main()
