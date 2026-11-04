#!/usr/bin/env python3
"""Offline: can the app's page-number OCR (NDLOCR-Lite) read the printed
page numbers of the book clips, at the emulator's resolution and at the
clip's own resolution?

For the middle frame of every hold of every clip, the target page (a
"single" clip) or the open spread (a "spread" clip) is cut out with the
ground-truth corners — the image ML Kit's scanner would hand the app —
at two resolutions:

  emu   the frame as the emulator camera shows it (camera-feed.py:
        clip_box() fitted into the 720×960 window the scanner sees)
  clip  the clip frame itself (1920×1080 / 1080×1920)

and run through the app's page-number path (page-number-reader.ts →
NDLOCR worker, mobile mode = rec100 only): top / bottom 15 % bands
stacked, DEIM layout boxes (line_* + block_pillar + block_folio; with
--widen a folio box is widened to 6× its height as in run 6), PARSeq
rec100, confidence ≥ 0.3. Each crop is decoded twice: `app` = as the app
did up to run 6 (consecutive repeated characters collapsed), `nodedup` =
without collapsing (the app from run 7).

Writes one JSON line per (page image, resolution, decode) with the OCR
lines (text, confidence, centre normalised to the page); score them with
`bun scripts/android/page-number-score.ts <out.jsonl>`.

usage: page-number-ocr.py <clips_dir> <models_dir> <NDLmoji.yaml> <out.jsonl> [--save-dir DIR]
needs: numpy, opencv-python(-headless), onnxruntime, pyyaml
"""

import argparse
import importlib.util
import json
import os
import sys

import cv2
import numpy as np
import onnxruntime as ort
import yaml

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("camera_feed", os.path.join(HERE, "camera-feed.py"))
camera_feed = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(camera_feed)

FEED_W, FEED_H = 1280, 960
MARGIN_FRAC = 0.15  # page-number-reader.ts
PREVIEW_LONG_SIDE = 1600  # index.vue NATIVE_PREVIEW_LONG_SIDE (nativeReadPage)
LINE_CLASS_IDS = {1, 2, 3, 4, 5, 8, 9, 16}  # layout-detector.ts
FOLIO_CLASS_ID = 9
MIN_LINE_SIDE, MIN_FOLIO_SIDE = 10, 4


def jpeg(img, q):
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, q])
    return cv2.imdecode(buf, cv2.IMREAD_COLOR)


def warp_quad(frame, quad):
    tl, tr, br, bl = [np.float32(p) for p in quad]
    w = int(round((np.linalg.norm(tr - tl) + np.linalg.norm(br - bl)) / 2))
    h = int(round((np.linalg.norm(bl - tl) + np.linalg.norm(br - tr)) / 2))
    m = cv2.getPerspectiveTransform(
        np.float32([tl, tr, br, bl]), np.float32([[0, 0], [w - 1, 0], [w - 1, h - 1], [0, h - 1]])
    )
    return cv2.warpPerspective(frame, m, (w, h), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)


def fit_long_side(img, long_side):
    h, w = img.shape[:2]
    s = long_side / max(w, h)
    if s >= 1:
        return img
    return cv2.resize(img, (max(1, int(w * s)), max(1, int(h * s))), interpolation=cv2.INTER_AREA)


class Ndlocr:
    def __init__(self, models_dir, yaml_path, widen=False):
        self.widen = widen
        opts = ort.SessionOptions()
        opts.log_severity_level = 3
        self.layout = ort.InferenceSession(os.path.join(models_dir, "deim-s-1024x1024.onnx"), opts)
        self.rec = ort.InferenceSession(os.path.join(models_dir, "parseq-ndl-100.onnx"), opts)
        with open(yaml_path, encoding="utf-8") as f:
            self.charset = list(yaml.safe_load(f)["model"]["charset_train"])

    def detect(self, rgb):
        h, w = rgb.shape[:2]
        mx = max(w, h)
        s = 800 / mx
        canvas = np.zeros((800, 800, 3), np.uint8)
        small = cv2.resize(rgb, (round(w * s), round(h * s)), interpolation=cv2.INTER_AREA)
        canvas[: small.shape[0], : small.shape[1]] = small
        x = (canvas.astype(np.float32) - [123.675, 116.28, 103.53]) / [58.395, 57.12, 57.375]
        x = x.transpose(2, 0, 1)[None].astype(np.float32)
        names = [i.name for i in self.layout.get_inputs()]
        feeds = {names[0]: x}
        if len(names) > 1:
            feeds[names[1]] = np.array([[800, 800]], np.int64)
        labels, boxes, scores, chars = self.layout.run(None, feeds)
        labels, boxes, scores, chars = labels.reshape(-1), boxes.reshape(-1, 4), scores.reshape(-1), chars.reshape(-1)
        k = mx / 800
        out = []
        for lab, b, sc, cc in zip(labels, boxes, scores, chars):
            if sc < 0.3:
                continue
            cid = int(lab) - 1
            if cid not in LINE_CLASS_IDS:
                continue
            x1, y1, x2, y2 = (float(v) * k for v in b)
            bh = y2 - y1
            d = bh * 0.02
            if self.widen and cid == FOLIO_CLASS_ID and x2 - x1 < bh * 6:
                cx = (x1 + x2) / 2
                x1, x2 = cx - bh * 3, cx + bh * 3
            fx1, fy1 = max(0, round(x1)), max(0, round(y1 - d))
            fx2, fy2 = min(w, round(x2)), min(h, round(y2 + d))
            ms = MIN_FOLIO_SIDE if cid == FOLIO_CLASS_ID else MIN_LINE_SIDE
            if fx2 - fx1 >= ms and fy2 - fy1 >= ms:
                out.append(dict(x=fx1, y=fy1, w=fx2 - fx1, h=fy2 - fy1, conf=float(sc), cls=cid))
        return nms(out)

    def recognize(self, crop):
        if crop.shape[0] > crop.shape[1]:
            crop = cv2.rotate(crop, cv2.ROTATE_90_COUNTERCLOCKWISE)
        x = cv2.resize(crop, (768, 16), interpolation=cv2.INTER_LINEAR).astype(np.float32) / 255.0
        x = (2.0 * (x - 0.5)).transpose(2, 0, 1)[None].astype(np.float32)
        logits = self.rec.run(None, {self.rec.get_inputs()[0].name: x})[0][0]
        ids, confs = [], []
        for row in logits:
            mi = int(np.argmax(row))
            if mi == 0:
                break
            if mi < 4:
                continue
            confs.append(float(1.0 / np.exp(row - row[mi]).sum()))
            ids.append(mi - 1)
        raw = "".join(self.charset[i] for i in ids if 0 <= i < len(self.charset))
        dd_chars, dd_conf, prev = [], [], -1
        for i, c in zip(ids, confs):
            if i != prev and 0 <= i < len(self.charset):
                dd_chars.append(self.charset[i])
                dd_conf.append(c)
                prev = i
        return (
            ("".join(dd_chars).strip(), float(np.mean(dd_conf)) if dd_conf else 0.0),
            (raw.strip(), float(np.mean(confs)) if confs else 0.0),
            [round(c, 3) for c in confs],
        )


def nms(dets, thr=0.5):
    keep = []
    for d in sorted(dets, key=lambda d: -d["conf"]):
        if all(iou(k, d) < thr for k in keep):
            keep.append(d)
    return keep


def iou(a, b):
    ix = max(0, min(a["x"] + a["w"], b["x"] + b["w"]) - max(a["x"], b["x"]))
    iy = max(0, min(a["y"] + a["h"], b["y"] + b["h"]) - max(a["y"], b["y"]))
    inter = ix * iy
    return 0 if inter == 0 else inter / (a["w"] * a["h"] + b["w"] * b["h"] - inter)


def read_page(ocr, page_bgr):
    """page-number-reader.ts readPageNumbers, up to the OCR lines."""
    page = jpeg(fit_long_side(page_bgr, PREVIEW_LONG_SIDE), 85)
    h, w = page.shape[:2]
    band = max(1, round(h * MARGIN_FRAC))
    comp = jpeg(np.vstack([page[:band], page[h - band :]]), 90)
    rgb = cv2.cvtColor(comp, cv2.COLOR_BGR2RGB)
    out = {"app": [], "nodedup": []}
    for r in ocr.detect(rgb):
        crop = rgb[r["y"] : r["y"] + r["h"], r["x"] : r["x"] + r["w"]]
        (t_dd, c_dd), (t_raw, c_raw), per_char = ocr.recognize(crop)
        cy = r["y"] + r["h"] / 2
        cy_page = cy if cy < band else h - 2 * band + cy
        pos = {"cx": (r["x"] + r["w"] / 2) / w, "cy": cy_page / h, "cls": r["cls"], "boxH": r["h"]}
        if c_dd >= 0.3:
            out["app"].append({"text": t_dd, "conf": c_dd, **pos})
        if c_raw >= 0.3:
            out["nodedup"].append({"text": t_raw, "conf": c_raw, "charConf": per_char, **pos})
    return out, (w, h)


def holds(gt):
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
    ap.add_argument("models_dir")
    ap.add_argument("charset_yaml")
    ap.add_argument("out")
    ap.add_argument("--save-dir")
    ap.add_argument("--widen", action="store_true", help="widen block_folio boxes to 6x their height (app in run 6)")
    a = ap.parse_args()
    ocr = Ndlocr(a.models_dir, a.charset_yaml, widen=a.widen)
    names = sorted(f[: -len(".gt.json")] for f in os.listdir(a.clips_dir) if f.endswith(".gt.json"))
    with open(a.out, "w", encoding="utf-8") as out:
        for name in names:
            with open(os.path.join(a.clips_dir, f"{name}.gt.json")) as f:
                gt = json.load(f)
            box = camera_feed.clip_box(gt)
            _, scale, _, _ = camera_feed.layout(gt["W"], gt["H"], FEED_W, FEED_H, box)
            cap = cv2.VideoCapture(os.path.join(a.clips_dir, f"{name}.mp4"))
            for hi, fi, quad, truth in holds(gt):
                cap.set(cv2.CAP_PROP_POS_FRAMES, fi)
                ok, frame = cap.read()
                if not ok:
                    print(f"{name}: frame {fi} unreadable", file=sys.stderr)
                    continue
                small = cv2.resize(
                    frame, (round(frame.shape[1] * scale), round(frame.shape[0] * scale)), interpolation=cv2.INTER_AREA
                )
                variants = {
                    "emu": warp_quad(small, [(x * scale, y * scale) for x, y in quad]),
                    "clip": warp_quad(frame, quad),
                }
                for res, page in variants.items():
                    if a.save_dir:
                        os.makedirs(a.save_dir, exist_ok=True)
                        cv2.imwrite(os.path.join(a.save_dir, f"{name}-h{hi}-{res}.jpg"), page)
                    lines, (pw, ph) = read_page(ocr, page)
                    for decode, ls in lines.items():
                        rec = dict(
                            clip=name, hold=hi, frame=fi, res=res, decode=decode, truth=truth,
                            pageW=page.shape[1], pageH=page.shape[0], readW=pw, readH=ph,
                            scale=round(scale if res == "emu" else 1.0, 3), lines=ls,
                        )
                        out.write(json.dumps(rec, ensure_ascii=False) + "\n")
                print(f"{name} hold {hi} frame {fi} truth {truth} emu {variants['emu'].shape[1]}x{variants['emu'].shape[0]}"
                      f" clip {variants['clip'].shape[1]}x{variants['clip'].shape[0]}", file=sys.stderr)


if __name__ == "__main__":
    main()
