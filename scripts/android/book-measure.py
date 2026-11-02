"""Score an emulator book-clip run (scripts/android/emulator-check.sh output).

    python3 -I book-measure.py <out-dir> <clips-dir> [--size 1280x960]

Writes <out-dir>/measure.json and <out-dir>/measure.md and prints the
markdown.

Corner error ("ずれ"): for every "Adjust corners" screenshot the four
blue handles ML Kit drew are found by colour; the captured image on that
screen is registered (ORB + RANSAC similarity) to the frame the feed was
showing, which also absorbs hand shake between the capture and the
screenshot; the ground-truth corners of that frame are then mapped onto
the screenshot and the handle-to-corner distances are converted back to
clip pixels. Candidates: the whole spread (outer corners of both pages),
the left page, the right page; the closest one is reported.

Pages ("撮れた / 赤 / 無表示"): the app's page list after each clip is
read from the UI dumps (several scroll positions). Row n of the list is
the n-th capture, i.e. hold plan[n] of captures.tsv, so every row stands
for the target pages of that hold. A target page counts as shown when a
row stands for it (撮れた, 重複, 番号を読めず, …) or a red 欠番 range
covers it; otherwise it is a silent miss ("無表示").
"""

import argparse
import csv
import glob
import importlib.util
import json
import os
import re
import sys
import xml.etree.ElementTree as ET
from itertools import permutations

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("feed", os.path.join(HERE, "camera-feed.py"))
feed = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(feed)

HANDLE_BGR = np.array([208, 87, 11], np.int16)  # ML Kit handle / outline blue
KIND_LABELS = ("撮れた", "重複候補", "抜け", "後から拾った")
STATE_LABELS = {
    "読み取り中…": "reading",
    "重複": "duplicate",
    "順番が前後": "outOfOrder",
    "番号を読めず": "unread",
    "読み取りできず": "failed",
    "欠番": "missing",
    "欠番（読み違いかも）": "suspect",
}


def bounds(s):
    m = re.match(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", s or "")
    return tuple(map(int, m.groups())) if m else None


def find_node(xml_path, rid_suffix):
    try:
        root = ET.parse(xml_path).getroot()
    except (ET.ParseError, FileNotFoundError):
        return None
    for n in root.iter("node"):
        if (n.get("resource-id") or "").endswith(rid_suffix):
            return bounds(n.get("bounds"))
    return None


def handles(img, box):
    x1, y1, x2, y2 = box
    roi = img[y1:y2, x1:x2].astype(np.int16)
    d = np.abs(roi - HANDLE_BGR).sum(axis=2)
    mask = (d < 60).astype(np.uint8)
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (19, 19))
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, k)
    n, _, stats, cents = cv2.connectedComponentsWithStats(mask)
    blobs = [(stats[i, cv2.CC_STAT_AREA], cents[i]) for i in range(1, n) if stats[i, cv2.CC_STAT_AREA] > 150]
    blobs.sort(key=lambda b: -b[0])
    return [(float(c[0]) + x1, float(c[1]) + y1) for _, c in blobs[:4]]


def image_rect(img, box):
    """Bounding box of the captured image inside the (dark) preview area."""
    x1, y1, x2, y2 = box
    roi = img[y1:y2, x1:x2].astype(np.int16)
    bg = np.median(np.concatenate([roi[:4].reshape(-1, 3), roi[-4:].reshape(-1, 3)]), axis=0)
    diff = np.abs(roi - bg).sum(axis=2) > 30
    rows = np.where(diff.mean(axis=1) > 0.3)[0]
    cols = np.where(diff.mean(axis=0) > 0.3)[0]
    if len(rows) < 10 or len(cols) < 10:
        return box
    return (x1 + int(cols[0]), y1 + int(rows[0]), x1 + int(cols[-1]) + 1, y1 + int(rows[-1]) + 1)


def rot_pts(pts, k, w, h):
    """Rotate points by k quarter turns counter-clockwise (np.rot90)."""
    out = []
    for x, y in pts:
        cw, ch = w, h
        for _ in range(k):
            x, y = y, cw - 1 - x
            cw, ch = ch, cw
        out.append((x, y))
    return out


def register(crop, fed):
    """Similarity transform fed(rotated k) -> crop. Returns (k, M, inliers)."""
    orb = cv2.ORB_create(4000)
    g1 = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    k1, d1 = orb.detectAndCompute(g1, None)
    best = (0, None, 0)
    if d1 is None:
        return best
    bf = cv2.BFMatcher(cv2.NORM_HAMMING)
    for k in range(4):
        f = np.ascontiguousarray(np.rot90(fed, k))
        # bring to roughly the crop's scale so ORB scales overlap
        s = crop.shape[1] / f.shape[1]
        fs = cv2.resize(f, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
        k2, d2 = orb.detectAndCompute(cv2.cvtColor(fs, cv2.COLOR_BGR2GRAY), None)
        if d2 is None:
            continue
        good = []
        for pair in bf.knnMatch(d2, d1, k=2):
            if len(pair) == 2 and pair[0].distance < 0.8 * pair[1].distance:
                good.append(pair[0])
        if len(good) < 8:
            continue
        src = np.float32([k2[m.queryIdx].pt for m in good]) / s
        dst = np.float32([k1[m.trainIdx].pt for m in good])
        M, inl = cv2.estimateAffinePartial2D(src, dst, method=cv2.RANSAC, ransacReprojThreshold=4.0)
        if M is not None and int(inl.sum()) > best[2]:
            best = (k, M, int(inl.sum()))
    return best


def quad_err(found, gt):
    """Min over assignments of the per-corner distances (found order free)."""
    best = None
    for p in permutations(range(4)):
        d = [float(np.hypot(found[p[i]][0] - gt[i][0], found[p[i]][1] - gt[i][1])) for i in range(4)]
        if best is None or sum(d) < sum(best):
            best = d
    return best


def gt_candidates(frame):
    pages = {p["side"]: p for p in frame["pages"] if p["state"] == "static"}
    c = {}
    order = ("tl", "tr", "br", "bl")
    for side in ("left", "right"):
        if side in pages:
            c[side] = [tuple(pages[side]["corners"][k]) for k in order]
    if "left" in pages and "right" in pages:
        L, R = pages["left"]["corners"], pages["right"]["corners"]
        c["spread"] = [tuple(L["tl"]), tuple(R["tr"]), tuple(R["br"]), tuple(L["bl"])]
    return c


def inside(pt, quad, tol):
    q = np.float32(quad).reshape(-1, 1, 2)
    return cv2.pointPolygonTest(q, (float(pt[0]), float(pt[1])), True) >= -tol


def measure_capture(out, clips, row, gts, size):
    clip, shot = row["clip"], row["shot"]
    gt = gts[clip]
    png = os.path.join(out, shot + ".png")
    img = cv2.imread(png)
    res = {"clip": clip, "capture": int(row["capture"]), "hold": row["hold"], "shot": shot}
    if img is None:
        res["error"] = "no screenshot"
        return res
    box = find_node(os.path.join(out, shot + ".xml"), "quad_editor") or (45, 341, 1035, 1944)
    hs = handles(img, box)
    res["handles"] = hs
    if len(hs) != 4:
        res["error"] = f"{len(hs)} handles found"
        return res
    try:
        fi = int(row["frame"])
    except ValueError:
        res["error"] = "no feed frame"
        return res
    res["frame"] = fi
    W, H = size
    cap = cv2.VideoCapture(os.path.join(clips, clip + ".mp4"))
    cap.set(cv2.CAP_PROP_POS_FRAMES, fi)
    ok, fr = cap.read()
    if not ok:
        res["error"] = "frame read failed"
        return res
    fed = feed.render_frame(fr, W, H)
    rx1, ry1, rx2, ry2 = image_rect(img, box)
    crop = img[ry1:ry2, rx1:rx2]
    k, M, inl = register(crop, fed)
    res["registration"] = {"rot90_ccw": k, "inliers": inl}
    if M is None or inl < 12:
        # Fallback: image fitted into the crop after the expected rotation
        # (sensor mounted at 90°: shown turned a quarter turn clockwise).
        k = 3
        fw, fh = (H, W)
        s = min((rx2 - rx1) / fw, (ry2 - ry1) / fh)
        M = np.float32([[s, 0, 0], [0, s, 0]])
        res["registration"]["assumed"] = True
    scale_total = float(np.hypot(M[0, 0], M[1, 0]))  # rotated-fed px -> screenshot px
    frame = gt["frames"][fi]
    cands = gt_candidates(frame)
    found_clip = None
    best = None
    for name, quad in cands.items():
        fq = [feed.map_point(x, y, gt["W"], gt["H"], W, H) for x, y in quad]
        rq = rot_pts(fq, k, W, H)
        sq = [(M[0, 0] * x + M[0, 1] * y + M[0, 2] + rx1, M[1, 0] * x + M[1, 1] * y + M[1, 2] + ry1) for x, y in rq]
        _, lscale, _, _ = feed.layout(gt["W"], gt["H"], W, H)
        to_clip = 1.0 / (scale_total * lscale)
        d = [e * to_clip for e in quad_err(hs, sq)]
        diag = float(np.hypot(quad[0][0] - quad[2][0], quad[0][1] - quad[2][1]))
        entry = {"target": name, "err_px": [round(e, 1) for e in d], "mean_px": round(sum(d) / 4, 1),
                 "max_px": round(max(d), 1), "max_rel": round(max(d) / diag, 4), "screen_quad": sq}
        if best is None or entry["mean_px"] < best["mean_px"]:
            best = entry
        if name == "spread" or found_clip is None:
            found_clip = (sq, to_clip)
    res["best"] = best
    # Which target pages lie inside the found frame (tolerance 2% of the
    # page height, in screenshot px).
    covered = []
    for p in frame["pages"]:
        if not p.get("target"):
            continue
        quad = [p["corners"][c] for c in ("tl", "tr", "br", "bl")]
        fq = [feed.map_point(x, y, gt["W"], gt["H"], W, H) for x, y in quad]
        rq = rot_pts(fq, k, W, H)
        sq = [(M[0, 0] * x + M[0, 1] * y + M[0, 2] + rx1, M[1, 0] * x + M[1, 1] * y + M[1, 2] + ry1) for x, y in rq]
        ph = float(np.hypot(sq[0][0] - sq[3][0], sq[0][1] - sq[3][1]))
        order = sorted(hs, key=lambda h: np.arctan2(h[1] - np.mean([q[1] for q in hs]), h[0] - np.mean([q[0] for q in hs])))
        if all(inside(pt, order, 0.02 * ph) for pt in sq):
            covered.append(p["page"])
    res["pages_in_frame"] = covered
    res["target_pages"] = [p["page"] for p in frame["pages"] if p.get("target")]
    return res


def parse_list(xml_paths):
    """Rows of the app's page list, merged over scroll positions."""
    rows = {}
    for path in xml_paths:
        try:
            root = ET.parse(path).getroot()
        except (ET.ParseError, FileNotFoundError):
            continue
        texts = [(n.get("text") or n.get("content-desc") or "").strip() for n in root.iter("node")
                 if (n.get("package") or "") == "com.astarworks.astarscan"]
        texts = [t for t in texts if t]
        starts = [i for i in range(1, len(texts)) if texts[i] in KIND_LABELS and re.fullmatch(r"\d+|—", texts[i - 1])]
        for j, i in enumerate(starts):
            stop = starts[j + 1] - 1 if j + 1 < len(starts) else len(texts)
            no, kind = texts[i - 1], texts[i]
            nums, rng, state, dup = None, None, None, None
            for t in texts[i + 1:stop]:
                if re.fullmatch(r"=\s*\d+", t):
                    dup = int(t.lstrip("= "))
                elif re.fullmatch(r"\d+(・\d+)*", t):
                    nums = [int(x) for x in t.split("・")]
                elif re.fullmatch(r"\d+〜\d+", t):
                    a, b = map(int, t.split("〜"))
                    rng = [a, b]
                elif t in STATE_LABELS:
                    state = STATE_LABELS[t]
            if kind == "抜け" or state in ("missing", "suspect"):
                if nums and not rng:
                    rng = [nums[0], nums[0]]
                key = ("gap", tuple(rng or []))
            else:
                key = ("row", no)
            rows[key] = {"no": None if no == "—" else int(no), "kind": kind, "nums": nums, "range": rng,
                         "state": state or ("ok" if nums else None), "dup_of": dup}
    out = [r for k, r in rows.items() if k[0] == "row"]
    out.sort(key=lambda r: r["no"] or 0)
    gaps = [r for k, r in rows.items() if k[0] == "gap"]
    return out, gaps


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("clips")
    ap.add_argument("--size", default="1280x960")
    a = ap.parse_args()
    size = tuple(map(int, a.size.split("x")))
    with open(os.path.join(a.out, "captures.tsv")) as f:
        caps = list(csv.DictReader(f, delimiter="\t"))
    gts = {}
    for p in glob.glob(os.path.join(a.clips, "*.gt.json")):
        with open(p) as f:
            g = json.load(f)
        gts[g["clip"]] = g

    results = [measure_capture(a.out, a.clips, r, gts, size) for r in caps if r["clip"] in gts]
    clips_out = []
    for name in [c for c in dict.fromkeys(r["clip"] for r in caps)] + [g for g in gts if g not in {r["clip"] for r in caps}]:
        g = gts[name]
        holds = [s for s in g["segments"] if s["phase"] == "hold"]
        hold_pages = []
        for s in holds:
            fr = g["frames"][(s["start_frame"] + s["end_frame"]) // 2]
            hold_pages.append([p["page"] for p in fr["pages"] if p.get("target")])
        plan = [r for r in caps if r["clip"] == name]
        plan_holds = [int(r["hold"]) for r in plan if r["hold"].isdigit()]
        xmls = sorted(glob.glob(os.path.join(a.out, f"*-{name}-list*.xml")))
        rows, gaps = parse_list(xmls)
        shown = set()
        misread = []
        for r in rows:
            h = plan_holds[r["no"] - 1] if r["no"] and r["no"] - 1 < len(plan_holds) else None
            truth = hold_pages[h] if h is not None and h < len(hold_pages) else []
            r["truth"] = truth
            if r["nums"]:
                shown.update(r["nums"])
                if truth and sorted(r["nums"]) != sorted(truth):
                    misread.append({"no": r["no"], "read": r["nums"], "truth": truth})
            if r["state"] in ("unread", "failed", "duplicate", "outOfOrder", "reading") or not r["nums"]:
                shown.update(truth)
        red_missing = set()
        for gp in gaps:
            if gp["range"]:
                red_missing.update(range(gp["range"][0], gp["range"][1] + 1))
        targets = sorted({p for hp in hold_pages for p in hp})
        silent = [p for p in targets if p not in shown and p not in red_missing]
        caps_c = [r for r in results if r["clip"] == name]
        errs = [r["best"]["mean_px"] for r in caps_c if r.get("best")]
        clips_out.append({
            "clip": name, "mode": g["mode"], "target_pages": targets, "captures": len(caps_c),
            "rows": rows, "gaps": gaps, "silent_missing": silent, "misread": misread,
            "red_missing": sorted(red_missing),
            "ok_rows": sum(1 for r in rows if r["state"] == "ok"),
            "dup_rows": sum(1 for r in rows if r["state"] == "duplicate" or r["kind"] == "重複候補"),
            "unread_rows": sum(1 for r in rows if r["state"] in ("unread", "failed")),
            "pages_in_frames": sorted({p for r in caps_c for p in r.get("pages_in_frame", [])}),
            "corner_mean_px": round(float(np.mean(errs)), 1) if errs else None,
            "corner_max_px": round(float(max(r["best"]["max_px"] for r in caps_c if r.get("best"))), 1) if errs else None,
            "frame_targets": {t: sum(1 for r in caps_c if r.get("best", {}).get("target") == t) for t in ("spread", "left", "right")},
        })

    with open(os.path.join(a.out, "measure.json"), "w") as f:
        json.dump({"captures": results, "clips": clips_out}, f, ensure_ascii=False, indent=1)

    md = ["| clip | target pages | captures | pages inside ML Kit frames | frame matched (spread/left/right) | corner err mean / max (clip px) | list rows ok / 重複 / 番号読めず | red 欠番 | misread | silent misses (無表示) |",
          "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"]
    tot = {"t": 0, "inf": 0, "silent": 0, "caps": 0}
    for c in clips_out:
        ft = c["frame_targets"]
        md.append(f"| {c['clip']} | {len(c['target_pages'])} | {c['captures']} | {len(c['pages_in_frames'])} | "
                  f"{ft['spread']}/{ft['left']}/{ft['right']} | {c['corner_mean_px']} / {c['corner_max_px']} | "
                  f"{c['ok_rows']} / {c['dup_rows']} / {c['unread_rows']} | {c['red_missing'] or '-'} | {len(c['misread'])} | "
                  f"{c['silent_missing'] or 0} |")
        tot["t"] += len(c["target_pages"])
        tot["inf"] += len(c["pages_in_frames"])
        tot["silent"] += len(c["silent_missing"])
        tot["caps"] += c["captures"]
    md.append("")
    md.append(f"Total: {tot['t']} target pages, {tot['caps']} captures, {tot['inf']} pages inside ML Kit's frames, "
              f"{tot['silent']} silent misses.")
    md.append("")
    md.append("| capture | hold | frame | handles | registration | best target | err per corner (clip px) | pages in frame |")
    md.append("| --- | --- | --- | --- | --- | --- | --- | --- |")
    for r in results:
        b = r.get("best") or {}
        md.append(f"| {r['clip']} c{r['capture']} | {r['hold']} | {r.get('frame', '')} | {len(r.get('handles', []))} | "
                  f"{r.get('registration', r.get('error', ''))} | {b.get('target', r.get('error', ''))} | {b.get('err_px', '')} | "
                  f"{r.get('pages_in_frame', '')} / {r.get('target_pages', '')} |")
    text = "\n".join(md) + "\n"
    with open(os.path.join(a.out, "measure.md"), "w") as f:
        f.write(text)
    print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
