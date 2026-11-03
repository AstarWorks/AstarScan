"""Score an emulator book-clip run (scripts/android/emulator-check.sh output).

    python3 -I book-measure.py <out-dir> <clips-dir> [--size 1280x960]

Writes <out-dir>/measure.json and <out-dir>/measure.md and prints the
markdown.

What the screen said, per page of the plan (checks.tsv): 撮れた (taken /
filled in a gap), 赤 (a missing page), 灰 (番号なし), 黄 (yellow notice
while nothing was taken), 撮影済み (the same page again), or 何も出ない
(nothing at all for the whole wait).

Corner error: for every page the screen took (events.log "capture … t=…
found=… kept=…") its camera picture (eval/<page>-frame.jpg) is registered
(ORB + RANSAC similarity) to the clip frame the feed was showing at that
time (feed.log, host clock = device clock + clock-offset.txt; the best of
the frames shown in the 1.5 s before), the ground-truth corners of that
frame are mapped onto the picture and compared with the frame the app
kept, in clip px. The target is the open spread on spread clips and the
right page on single clips (corners outside the clip moved to where the
page edge leaves the frame, as before).

Page numbers: the number(s) the screen kept for a page against the
printed numbers of the hold shown; a number is right when it equals the
truth (one of the two numbers of a spread also counts).

Page list (after each clip): rows, red rows (欠番) and whether they are
real, grey rows (番号なし), and any leftover "受け取れていません" notice.
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

KIND_LABELS = ("撮れた", "重複候補", "抜け", "後から拾った")
STATE_LABELS = {
    "読み取り中…": "reading",
    "重複": "duplicate",
    "順番が前後": "outOfOrder",
    "番号なし": "unread",  # unread and failed share this label (grey)
    "番号を読めず": "unread",  # earlier label
    "読み取りできず": "failed",  # earlier label
    "欠番": "missing",
    "欠番（読み違いかも）": "suspect",
    "欠番？": "missingOrUnread",
    "欠番？（未読を挟む）": "missingOrUnread",  # earlier label
    "欠番？（間に番号を読めないページ）": "missingOrUnread",  # run 12 label
}



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


def visible_quad(quad, w, h):
    """GT corners (tl, tr, br, bl) moved into the clip frame: a corner outside
    the frame is replaced by the point where its top / bottom page edge
    crosses the frame border — the corner the camera can actually see.
    single-port-wood has the target page's tl 0-27 px left of the clip's
    edge on 5 of 12 holds (run 10 finding); the feed fills that strip with
    repeated edge pixels, so no detector can find the hidden corner.
    Returns (quad, names of the corners moved)."""
    names = ("tl", "tr", "br", "bl")
    pair = {0: 1, 1: 0, 2: 3, 3: 2}  # along the top / bottom edge
    out, moved = [], []
    for i, (x, y) in enumerate(quad):
        if -1 <= x <= w and -1 <= y <= h:
            out.append((x, y))
            continue
        nx, ny = quad[pair[i]]
        bx = 0.0 if x < 0 else float(w - 1) if x > w else x
        if bx != x and nx != x:
            t = (bx - x) / (nx - x)
            x, y = bx, y + t * (ny - y)
        y = min(max(y, 0.0), float(h - 1))
        out.append((x, y))
        moved.append(names[i])
    return out, moved


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
        def kind_of(t):
            return next((k for k in KIND_LABELS if t.startswith(k)), None)

        starts = [i for i in range(1, len(texts)) if kind_of(texts[i]) and re.fullmatch(r"\d+|—", texts[i - 1])]
        for j, i in enumerate(starts):
            stop = starts[j + 1] - 1 if j + 1 < len(starts) else len(texts)
            no, kind = texts[i - 1], kind_of(texts[i])
            nums, rng, state, dup = None, None, None, None
            # The app joins some texts: "重複候補 = 1", "5順番が前後",
            # "2〜5欠番", "1重複".
            m = re.search(r"=\s*(\d+)", texts[i])
            if m:
                dup = int(m.group(1))
            for t in texts[i + 1:stop]:
                if re.fullmatch(r"=\s*\d+", t):
                    dup = int(t.lstrip("= "))
                    continue
                m = re.fullmatch(r"(\d+〜\d+|\d+(?:・\d+)*)?\s*(.*)", t)
                num, label = m.group(1), m.group(2).strip()
                if num and "〜" in num:
                    a, b = map(int, num.split("〜"))
                    rng = [a, b]
                elif num:
                    nums = [int(x) for x in num.split("・")]
                if label in STATE_LABELS:
                    state = STATE_LABELS[label]
            if kind == "抜け" or state in ("missing", "suspect", "missingOrUnread"):
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


def number_right(nums, truth):
    return bool(nums) and bool(truth) and (
        sorted(nums) == sorted(truth) or (len(nums) == 1 and nums[0] in truth))




SAID = {"taken": "撮れた", "filled": "撮れた（抜けを埋めた）", "gap": "赤（抜け）", "gap-notice": "赤（抜け・撮れず）",
        "unread": "灰（番号なし）", "duplicate": "撮影済み", "yellow": "黄", "none": "何も出ない"}


def read_tsv(path):
    try:
        with open(path, encoding="utf-8") as f:
            return list(csv.DictReader(f, delimiter="\t"))
    except FileNotFoundError:
        return []


def parse_quad(s):
    try:
        pts = [tuple(map(float, p.split(","))) for p in s.split(";")]
    except ValueError:
        return None
    return pts if len(pts) == 4 else None


def read_events(path):
    """Captures and pages from events.log, each with the clip it belongs to."""
    caps, pages, clip = {}, {}, None
    try:
        f = open(path, encoding="utf-8", errors="replace")
    except FileNotFoundError:
        return [], {}
    with f:
        for line in f:
            m = re.search(r"AstarScanEval\s*:\s*clip (\S+)", line)
            if m:
                clip = m.group(1)
                continue
            m = re.search(r"AstarScanCapture\s*:\s*capture (\S+) t=(\d+) photo=(\d+)x(\d+) source=(\S+) spread=(\S+) found=(\S+) kept=(\S+)", line)
            if m and clip:
                caps[m.group(1)] = {"name": m.group(1), "clip": clip, "t": int(m.group(2)) / 1000.0,
                                    "photo": (int(m.group(3)), int(m.group(4))), "source": m.group(5),
                                    "spread": m.group(6) == "true", "found": parse_quad(m.group(7)),
                                    "kept": parse_quad(m.group(8))}
                continue
            m = re.search(r"AstarScanCapture\s*:\s*page (\S+) kind=(\S+) nums=\[([\d, ]*)\]", line)
            if m:
                pages[m.group(1)] = {"kind": m.group(2), "nums": [int(x) for x in m.group(3).replace(" ", "").split(",") if x]}
    out = []
    for name, c in caps.items():
        c.update(pages.get(name, {"kind": None, "nums": []}))
        out.append(c)
    out.sort(key=lambda c: c["t"])
    return out, pages


def read_feed(path):
    rows = []
    try:
        with open(path) as f:
            for line in f:
                p = line.split()
                if len(p) == 4:
                    rows.append((float(p[0]), p[1], int(p[2]), int(p[3])))
    except FileNotFoundError:
        pass
    return rows


def target_quad(frame, mode):
    pages = {p["side"]: p for p in frame["pages"] if p["state"] == "static"}
    order = ("tl", "tr", "br", "bl")
    if mode == "spread":
        if "left" in pages and "right" in pages:
            L, R = pages["left"]["corners"], pages["right"]["corners"]
            return [tuple(L["tl"]), tuple(R["tr"]), tuple(R["br"]), tuple(L["bl"])]
        return None
    t = [p for p in frame["pages"] if p.get("target") and p["state"] == "static"]
    return [tuple(t[0]["corners"][k]) for k in order] if t else None


class Video:
    def __init__(self, clips):
        self.clips, self.name, self.cap = clips, None, None

    def frame(self, clip, i):
        if clip != self.name:
            self.cap = cv2.VideoCapture(os.path.join(self.clips, clip + ".mp4"))
            self.name = clip
        self.cap.set(cv2.CAP_PROP_POS_FRAMES, i)
        ok, fr = self.cap.read()
        return fr if ok else None


def measure(c, out, gts, feedlog, offset, size, video):
    """Corner error of one page the screen took (see the module doc)."""
    gt = gts.get(c["clip"])
    res = {}
    if gt is None:
        return {"error": "no ground truth"}
    host_t = c["t"] + offset
    shown = [r for r in feedlog if r[1] == c["clip"] and host_t - 1.5 <= r[0] <= host_t + 0.3]
    if not shown:
        return {"error": "no feed frame at that time"}
    holds = {}
    for r in shown:
        holds[r[3]] = holds.get(r[3], 0) + 1
    res["hold"] = max(holds, key=holds.get)
    photo = cv2.imread(os.path.join(out, "eval", c["name"].replace(".jpg", "-frame.jpg")))
    if photo is None:
        res["error"] = "no camera picture"
        return res
    W, H = size
    box = feed.clip_box(gt)
    frames = sorted({r[2] for r in shown})
    if len(frames) > 8:
        frames = [frames[int(i * (len(frames) - 1) / 7)] for i in range(8)]
    best = None
    for fi in frames:
        fr = video.frame(c["clip"], fi)
        if fr is None:
            continue
        k, M, inl = register(photo, feed.render_frame(fr, W, H, box))
        if M is not None and (best is None or inl > best[3]):
            best = (fi, k, M, inl)
    if best is None or best[3] < 12:
        res["error"] = f"registration failed ({best[3] if best else 0} inliers)"
        return res
    fi, k, M, inl = best
    res.update(frame=fi, rot90=k, inliers=inl)
    q = target_quad(gt["frames"][fi], gt["mode"])
    if q is None:
        res["error"] = "no target in that frame"
        return res
    q, moved = visible_quad(q, gt["W"], gt["H"])
    fq = [feed.map_point(x, y, gt["W"], gt["H"], W, H, box) for x, y in q]
    rq = rot_pts(fq, k, W, H)
    sq = [(M[0, 0] * x + M[0, 1] * y + M[0, 2], M[1, 0] * x + M[1, 1] * y + M[1, 2]) for x, y in rq]
    _, lscale, _, _ = feed.layout(gt["W"], gt["H"], W, H, box)
    to_clip = 1.0 / (float(np.hypot(M[0, 0], M[1, 0])) * lscale)
    for key in ("found", "kept"):
        if c.get(key):
            d = [e * to_clip for e in quad_err(c[key], sq)]
            res[key] = {"err_px": [round(e, 1) for e in d], "mean_px": round(sum(d) / 4, 1), "max_px": round(max(d), 1)}
    res["out_of_clip"] = moved
    return res


def hold_truth(gt):
    out = []
    for s in gt["segments"]:
        if s["phase"] != "hold":
            continue
        fr = gt["frames"][(s["start_frame"] + s["end_frame"]) // 2]
        out.append([p["page"] for p in fr["pages"] if p.get("target")])
    return out


def list_check(out, clip, gts):
    xmls = sorted(glob.glob(os.path.join(out, f"*-{clip}-list*.xml")))
    rows, gaps = parse_list(xmls)
    leftover = 0
    for x in xmls:
        try:
            if "受け取れていません" in open(x, encoding="utf-8", errors="replace").read():
                leftover += 1
        except OSError:
            pass
    return rows, gaps, leftover


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("clips")
    ap.add_argument("--size", default="1280x960")
    a = ap.parse_args()
    size = tuple(map(int, a.size.split("x")))
    gts = {}
    for p in glob.glob(os.path.join(a.clips, "*.gt.json")):
        with open(p) as f:
            g = json.load(f)
        gts[g["clip"]] = g
    try:
        offset = float(open(os.path.join(a.out, "clock-offset.txt")).read().strip())
    except (OSError, ValueError):
        offset = 0.0
    checks = read_tsv(os.path.join(a.out, "checks.tsv"))
    notices = read_tsv(os.path.join(a.out, "notices.tsv"))
    caps, _ = read_events(os.path.join(a.out, "events.log"))
    feedlog = read_feed(os.path.join(a.out, "feed.log"))
    video = Video(a.clips)
    for c in caps:
        c["measure"] = measure(c, a.out, gts, feedlog, offset, size, video)

    md, clips_out = [], []
    per_page = ["| clip | step | hold | printed | screen said | corner err (clip px, tl tr br bl) | number kept | number | shot |",
                "| --- | --- | --- | --- | --- | --- | --- | --- | --- |"]
    for name in dict.fromkeys(r["clip"] for r in checks):
        g = gts.get(name)
        if not g:
            continue
        truth = hold_truth(g)
        cc = [c for c in caps if c["clip"] == name]
        said = {}
        stats = {"right": 0, "wrong": 0, "unread": 0, "errs": [], "maxes": [], "wrong_list": []}
        for r in [r for r in checks if r["clip"] == name]:
            h = int(r["hold"])
            said[r["result"]] = said.get(r["result"], 0) + 1
            pages_h = truth[h] if h < len(truth) else []
            mine = [c for c in cc if c["measure"].get("hold") == h and c.get("kind") not in (None, "duplicate")]
            c = mine[0] if mine else None
            err, num, verdict = "", "", ""
            if c:
                kept = c["measure"].get("kept")
                if kept:
                    err = f"{kept['mean_px']} / {kept['max_px']} {kept['err_px']}"
                    stats["errs"].append(kept["mean_px"])
                    stats["maxes"].append(kept["max_px"])
                else:
                    err = c["measure"].get("error", "")
                num = "・".join(map(str, c["nums"])) or "—"
                if not c["nums"]:
                    verdict = "番号なし"
                    stats["unread"] += 1
                elif number_right(c["nums"], pages_h):
                    verdict = "正"
                    stats["right"] += 1
                else:
                    verdict = "誤"
                    stats["wrong"] += 1
                    stats["wrong_list"].append({"hold": h, "read": c["nums"], "truth": pages_h})
            per_page.append(f"| {name} | {r['step']} | {h} | {'・'.join(map(str, pages_h))} | {SAID.get(r['result'], r['result'])} {r['text']} | "
                            f"{err} | {num} | {verdict} | {r['shot']} |")
        rows, gaps, leftover = list_check(a.out, name, gts)
        shown = {p for c in cc if c.get("kind") not in (None, "duplicate") for p in (truth[c["measure"]["hold"]] if "hold" in c["measure"] and c["measure"]["hold"] < len(truth) else [])}
        book = set(g["pages"])
        false_red = [gp["range"] for gp in gaps if gp["range"] and not any(p in book and p not in shown and p in g["target_pages"] for p in range(gp["range"][0], gp["range"][1] + 1))]
        red_n = sum(1 for n in notices if n["clip"] == name and n["kind"] == "gap")
        yel_n = sum(1 for n in notices if n["clip"] == name and n["kind"] == "yellow")
        c_out = {
            "clip": name, "mode": g["mode"], "steps": sum(said.values()), "said": said,
            "corner_mean_px": round(float(np.mean(stats["errs"])), 1) if stats["errs"] else None,
            "corner_max_px": round(float(max(stats["maxes"])), 1) if stats["maxes"] else None,
            "numbers_right": stats["right"], "numbers_wrong": stats["wrong"], "numbers_unread": stats["unread"],
            "wrong": stats["wrong_list"], "list_rows": len(rows), "list_red": [gp["range"] for gp in gaps],
            "list_false_red": false_red, "list_grey": sum(1 for r in rows if r["state"] in ("unread", "failed")),
            "leftover_not_received": leftover, "notices_red": red_n, "notices_yellow": yel_n,
        }
        clips_out.append(c_out)
    md.append("| clip | pages in plan | 撮れた | 赤 | 灰（番号なし） | 黄 | 撮影済み | 何も出ない | corner err mean / max (clip px) | numbers right / wrong / unread | list: rows, red rows (false), grey | 「受け取れていません」 left | notices.tsv red / yellow |")
    md.append("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    tot = {"none": 0, "wrong": 0}
    for c in clips_out:
        s = c["said"]
        md.append(f"| {c['clip']} | {c['steps']} | {s.get('taken', 0) + s.get('filled', 0)} | {s.get('gap', 0) + s.get('gap-notice', 0)} | "
                  f"{s.get('unread', 0)} | {s.get('yellow', 0)} | {s.get('duplicate', 0)} | {s.get('none', 0)} | "
                  f"{c['corner_mean_px']} / {c['corner_max_px']} | {c['numbers_right']} / {c['numbers_wrong']} / {c['numbers_unread']} | "
                  f"{c['list_rows']}, {c['list_red'] or '-'} ({c['list_false_red'] or 0}), {c['list_grey']} | {c['leftover_not_received']} | "
                  f"{c['notices_red']} / {c['notices_yellow']} |")
        tot["none"] += s.get("none", 0)
        tot["wrong"] += c["numbers_wrong"]
    md.append("")
    skip = [r for r in checks if r["clip"] == "single-land-white" and r["hold"] in ("4", "3")]
    skip_txt = "; ".join(f"hold {r['hold']}: {SAID.get(r['result'], r['result'])} {r['text']}" for r in skip) or "not run"
    md.append(f"Total: {sum(c['steps'] for c in clips_out)} pages in the plan, {tot['none']} with nothing shown, {tot['wrong']} numbers wrong. "
              f"Skipped page (single-land-white p37): {skip_txt}.")
    md.append("")
    md += per_page
    text = "\n".join(md) + "\n"
    with open(os.path.join(a.out, "measure.md"), "w") as f:
        f.write(text)
    with open(os.path.join(a.out, "measure.json"), "w") as f:
        json.dump({"clips": clips_out, "captures": caps}, f, ensure_ascii=False, indent=1, default=float)
    print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
