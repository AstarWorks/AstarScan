"""Phone-resolution stills of the book clips, for the emulator's number check.

    python3 -I stills.py OUT_DIR [CLIP ...] [--px-mm 12] [--jobs 2]

The CI emulator's camera gives the app 960x1280; a phone's still is ~12 MP.
This renders the middle frame of every hold of each clip again with the
clip generator (render.py, same seeds: same book, same hand, same shake),
but at a phone's still size — 3000x4000 for a one-page clip, 4000x3000 for
a spread (camera rotated so the spread fills the long side) — and the page
texture at --px-mm px per mm (render.py's 5 is the 1080p clips'; 12 keeps
the print sharp at ~11–16 px/mm on the page in these stills).

Writes OUT_DIR/<clip>__hNN.jpg (JPEG q92, like a phone), OUT_DIR/<clip>__hNN.quad
(the target page's true corners tl tr br bl, or the spread's outer corners,
"x y x y x y x y" in still px: StillsCheck.kt uses them only when DocAligner
gives no frame) and OUT_DIR/stills.json ({file: {clip, hold, frame, truth,
size}}), which book-measure.py scores against the app's "still" log lines.
Needs numpy, opencv, pillow and the fonts render.py names.
"""
import importlib
import importlib.util
import json
import os
import sys
from multiprocessing import Pool

import cv2

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("render", os.path.join(HERE, "render.py"))
R = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(R)

# STILLS_BOOK=book2 / book3: another untuned book (book2.py / book3.py,
# ground truth in book2/ / book3/). Unset: the five clips in clips/.
SRC = "clips"
BOOK = os.environ.get("STILLS_BOOK", "")
if BOOK:
    sys.path.insert(0, HERE)
    R.CLIPS.update(getattr(importlib.import_module(BOOK), BOOK.upper()))
    SRC = BOOK


def size_for(cfg):
    return (4000, 3000) if cfg["mode"] == "spread" else (3000, 4000)


def one_clip(job):
    name, out, px_mm = job
    R.PX_MM = px_mm
    cfg = R.CLIPS[name]
    W, H = size_for(cfg)
    R.CLIPS[name] = dict(cfg, W=W, H=H)
    with open(os.path.join(HERE, SRC, f"{name}.gt.json")) as f:
        gt = json.load(f)
    mids = {}
    for hi, s in enumerate(s for s in gt["segments"] if s["phase"] == "hold"):
        mids[(s["start_frame"] + s["end_frame"] - 1) // 2] = hi
    truth = {}

    def sink(fi, img, fr):
        hi = mids[fi]
        fn = f"{name}__h{hi:02d}.jpg"
        tgt = [p for p in fr["pages"] if p.get("target")]
        if cfg["mode"] == "spread" and len(tgt) == 2:
            left = next(p for p in tgt if p["side"] == "left")
            right = next(p for p in tgt if p["side"] == "right")
            quad = [left["corners"]["tl"], right["corners"]["tr"], right["corners"]["br"], left["corners"]["bl"]]
            nums = [left["page"], right["page"]]
        elif tgt:
            quad = [tgt[0]["corners"][k] for k in ("tl", "tr", "br", "bl")]
            nums = [tgt[0]["page"]]
        else:
            print(name, "hold", hi, "frame", fi, "has no target page", flush=True)
            return
        cv2.imwrite(os.path.join(out, fn), img, [cv2.IMWRITE_JPEG_QUALITY, 92])
        with open(os.path.join(out, fn[: -len(".jpg")] + ".quad"), "w") as f:
            f.write(" ".join(f"{v:.1f}" for p in quad for v in p) + "\n")
        truth[fn] = {"clip": name, "hold": hi, "frame": fi, "truth": nums, "size": f"{W}x{H}"}
        print(name, "hold", hi, "->", fn, nums, flush=True)

    R.render(name, os.path.join(out, ".render"), only=set(mids), sink=sink)
    return truth


def main():
    args = [a for a in sys.argv[1:]]
    px_mm, jobs = 12.0, 2
    if "--px-mm" in args:
        i = args.index("--px-mm"); px_mm = float(args[i + 1]); del args[i:i + 2]
    if "--jobs" in args:
        i = args.index("--jobs"); jobs = int(args[i + 1]); del args[i:i + 2]
    out = args[0]
    names = args[1:] or list(R.CLIPS)
    os.makedirs(out, exist_ok=True)
    work = [(n, out, px_mm) for n in names]
    if jobs > 1 and len(work) > 1:
        with Pool(min(jobs, len(work))) as pool:
            parts = pool.map(one_clip, work, chunksize=1)
    else:
        parts = [one_clip(w) for w in work]
    truth = {}
    for p in parts:
        truth.update(p)
    with open(os.path.join(out, "stills.json"), "w") as f:
        json.dump(truth, f, indent=1)
    print(f"[stills] {len(truth)} stills in {out}")


if __name__ == "__main__":
    main()
