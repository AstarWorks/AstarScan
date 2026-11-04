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




SAID = {"shot": "撮れた（番号は出ず）", "taken": "撮れた", "filled": "撮れた（抜けを埋めた）", "gap": "赤（抜け）", "gap-notice": "赤（抜け・撮れず）",
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
    caps, pages, clip, hold = {}, {}, None, None
    try:
        f = open(path, encoding="utf-8", errors="replace")
    except FileNotFoundError:
        return [], {}
    with f:
        for line in f:
            m = re.search(r"AstarScanEval\s*:\s*clip (\S+)", line)
            if m:
                clip, hold = m.group(1), None
                continue
            # emulator-check.sh feed(): the hold the camera is turned to.
            m = re.search(r"AstarScanEval\s*:\s*hold (\S+) (\d+)", line)
            if m:
                clip, hold = m.group(1), int(m.group(2))
                continue
            m = re.search(r"AstarScanCapture\s*:\s*capture (\S+) t=(\d+) photo=(\d+)x(\d+) source=(\S+) spread=(\S+) found=(\S+) kept=(\S+)", line)
            if m and clip:
                caps[m.group(1)] = {"name": m.group(1), "clip": clip, "t": int(m.group(2)) / 1000.0,
                                    "photo": (int(m.group(3)), int(m.group(4))), "source": m.group(5),
                                    "spread": m.group(6) == "true", "found": parse_quad(m.group(7)),
                                    "kept": parse_quad(m.group(8)), "hold_mark": hold}
                continue
            m = re.search(r"AstarScanCapture\s*:\s*page (\S+) kind=(\S+) nums=\[([\d, ]*)\]", line)
            if m:
                pages.setdefault(m.group(1), {}).update(
                    {"kind": m.group(2), "nums": [int(x) for x in m.group(3).replace(" ", "").split(",") if x]})
                continue
            m = re.search(r"AstarScanCapture\s*:\s*timing (\S+) queued=(\d+)ms read=(\d+)ms confirm=(\d+)ms total=(\d+)ms", line)
            if m:
                pages.setdefault(m.group(1), {}).update(
                    {"queued_ms": int(m.group(2)), "read_ms": int(m.group(3)), "confirm_ms": int(m.group(4)), "number_ms": int(m.group(5))})
                continue
            m = re.search(r"AstarScanCapture\s*:\s*timing-shot (\S+) .*total=(\d+)ms", line)
            if m:
                pages.setdefault(m.group(1), {})["shot_ms"] = int(m.group(2))
    out = []
    for name, c in caps.items():
        c.update({"kind": None, "nums": []})
        c.update(pages.get(name, {}))
        out.append(c)
    out.sort(key=lambda c: c["t"])
    return out, pages


def read_ocr_calls(path):
    """Every ML Kit call the app made ("ocr <pass> [tiles] WxH Nms ok|failed")."""
    out = []
    try:
        f = open(path, encoding="utf-8", errors="replace")
    except FileNotFoundError:
        return out
    with f:
        for line in f:
            # The phone-resolution stills come after the live clips: not counted here.
            if re.search(r"AstarScanMlkit\s*:\s*stills start", line):
                break
            m = re.search(r"AstarScanMlkit\s*:\s*ocr (\S+)(?: \d+)? (\d+)x(\d+) (\d+)ms (\S+)", line)
            if m:
                out.append({"pass": m.group(1), "w": int(m.group(2)), "h": int(m.group(3)), "ms": int(m.group(4)), "ok": m.group(5) == "ok"})
    return out


def ms_stats(v):
    if not v:
        return "—"
    v = sorted(v)
    return f"{v[len(v) // 2]} / {v[-1]} ms (n={len(v)})"


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
    mark = c.get("hold_mark")
    if mark is not None:
        # The hold comes from the log order (emulator-check.sh feed()); the
        # feed frames from that hold nearest in time (the clocks may drift).
        res["hold"] = mark
        same = [r for r in shown if r[3] == mark]
        if not same:
            near = sorted((r for r in feedlog if r[1] == c["clip"] and r[3] == mark), key=lambda r: abs(r[0] - host_t))
            same = near[:15]
        shown = same
    if not shown:
        res["error"] = "no feed frame at that time"
        return res
    if mark is None:
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


def save_report(out, caps=()):
    """PDF / Markdown save and the curvature correction, after the last clip
    (emulator-check.sh: saved/save.tsv, the pulled files, flatten lines)."""
    md, res = [], {"flatten": {}, "files": []}
    flat, not_flat = [], {}
    try:
        for line in open(os.path.join(out, "events.log"), encoding="utf-8", errors="replace"):
            m = re.search(r"AstarScanCapture\s*:\s*flatten (\S+) (\d+)x(\d+) bow top=(-?[\d.]+) bottom=(-?[\d.]+)", line)
            if m:
                flat.append((m.group(1), float(m.group(4)), float(m.group(5))))
                continue
            m = re.search(r"AstarScanCapture\s*:\s*flatten (\S+) (\S+) none(?: \((.*?)\))?(?: spread=(\S+))?", line)
            if m:
                # The same page logged again (opened from the list) counts once.
                not_flat[m.group(1)] = {"size": m.group(2), "why": re.sub(r"^straight cut kept:\s*", "", m.group(3) or "edges not found"),
                                        "spread": m.group(4)}
    except OSError:
        pass
    flat_names = {n for n, _, _ in flat}
    flat = list({n: (n, t, b) for n, t, b in flat}.values())
    not_flat = {n: v for n, v in not_flat.items() if n not in flat_names}
    none = len(not_flat)
    where = {c["name"]: c for c in caps}
    res["flatten_none"] = []
    for n, v in not_flat.items():
        c = where.get(n, {})
        hold = c.get("measure", {}).get("hold", c.get("hold_mark"))
        res["flatten_none"].append({"page": n, "clip": c.get("clip"), "hold": hold, **v})
    flat_files = sorted(glob.glob(os.path.join(out, "eval", "*-flat.jpg")))
    res["flatten"] = {"corrected": len(flat), "straight_kept": none, "flat_images": len(flat_files)}
    rows = []
    try:
        with open(os.path.join(out, "saved", "save.tsv"), encoding="utf-8") as f:
            rows = [l.rstrip("\n").split("\t") for l in f if l.strip()]
    except OSError:
        pass
    md.append("Save and dewarp (after the last clip, single-land-white):")
    md.append("")
    md.append("| what | result |")
    md.append("| --- | --- |")
    bows = [max(abs(t), abs(b)) for _, t, b in flat]
    md.append(f"| curvature-corrected pages (flatten found both edges) | {len(flat)} of {len(flat) + none} pages; "
              f"largest edge bow corrected median {sorted(bows)[len(bows) // 2] * 100:.2f} % / max {max(bows) * 100:.2f} % of the page height; "
              f"{len(flat_files)} eval/*-flat.jpg |" if flat else f"| curvature-corrected pages | 0 of {none} pages |")
    for x in res["flatten_none"]:
        md.append(f"| not flattened: {x['clip'] or '?'} hold {x['hold'] if x['hold'] is not None else '?'} ({x['page']}, "
                  f"{'spread' if x['spread'] == 'true' else 'page' if x['spread'] == 'false' else ''} {x['size']}) | "
                  f"straight cut kept: {x['why']}; camera picture eval/{x['page'][:-4]}-frame.jpg |")
    opened = [r[1] for r in rows if r and r[0] == "page-open" and len(r) > 1]
    md.append(f"| one page opened from the list (screenshot) | {opened[0] + '.png' if opened else 'not opened'} |")
    for kind in ("pdf", "markdown"):
        r = next((r for r in rows if r and r[0] == kind), None)
        if not r or len(r) < 3 or r[1] != "saved":
            md.append(f"| {kind} save | {' '.join(r[1:]) if r else 'not run'} |")
            res["files"].append({"kind": kind, "ok": False})
            continue
        path = os.path.join(out, "saved", r[2])
        size = os.path.getsize(path) if os.path.exists(path) else 0
        info = {"kind": kind, "file": r[2], "bytes": size, "app": r[3] if len(r) > 3 else "", "ok": size > 0}
        if kind == "pdf" and size:
            data = open(path, "rb").read()
            info["pages"] = len(re.findall(rb"/Type\s*/Page(?![s\w])", data))
            md.append(f"| PDF save | {r[2]}: {info['pages']} pages, {size} bytes (app: {info['app']}) |")
        elif kind == "markdown" and size:
            text = open(path, encoding="utf-8", errors="replace").read()
            info["pages"] = len(re.findall(r"^## ", text, re.M))
            info["head"] = text.splitlines()[:14]
            md.append(f"| Markdown save | {r[2]}: {info['pages']} page headings, {size} bytes (app: {info['app']}) |")
        else:
            md.append(f"| {kind} save | {r[2]}: empty or not pulled |")
        res["files"].append(info)
    head = next((f.get("head") for f in res["files"] if f.get("kind") == "markdown" and f.get("head")), None)
    if head:
        md.append("")
        md.append("Head of the Markdown:")
        md.append("")
        md.append("```markdown")
        md += head
        md.append("```")
    md.append("")
    return md, res


def stills_report(out):
    """Phone-resolution stills (emulator-check.sh, after the live clips):
    the capture screen's page cut and number read (StillsCheck.kt) on the
    middle frame of every hold rendered at 3000x4000 / 4000x3000
    (scripts/eval/book-clips/stills.py). A number counts as read when the
    pick is strong (what the screen keeps); right = exactly the printed
    number(s), wrong = any number not printed there."""
    try:
        with open(os.path.join(out, "stills", "stills.json")) as f:
            truth = json.load(f)
    except (OSError, ValueError):
        return [], {}
    got, failed = {}, {}
    try:
        for line in open(os.path.join(out, "events.log"), encoding="utf-8", errors="replace"):
            m = re.search(r"AstarScanMlkit\s*:\s*still (\S+) (\d+)x(\d+) source=(\S+) spread=(\S+) page=(\S+) nums=\[([\d, ]*)\] "
                          r"strong=(\S+) framed=(\S+) cut=(\d+)ms read=(\d+)ms", line)
            if m:
                got[m.group(1)] = {"source": m.group(4), "spread": m.group(5) == "true", "page": m.group(6),
                                   "nums": [int(x) for x in m.group(7).replace(" ", "").split(",") if x],
                                   "strong": m.group(8) == "true", "framed": m.group(9) == "true",
                                   "cut_ms": int(m.group(10)), "read_ms": int(m.group(11))}
                continue
            m = re.search(r"AstarScanMlkit\s*:\s*still (\S+) (?:\d+x\d+: no frame|failed)", line)
            if m:
                failed[m.group(1)] = line.strip()[-160:]
    except OSError:
        pass
    clips, rows = {}, []
    for fn in sorted(truth):
        t = truth[fn]
        c = clips.setdefault(t["clip"], {"stills": 0, "right": 0, "wrong": 0, "unread": 0, "not_run": 0, "truth_frame": 0, "framed": 0,
                                         "size": t.get("size", "")})
        c["stills"] += 1
        g = got.get(fn)
        if g is None:
            c["not_run"] += 1
            c["unread"] += 1
            rows.append(f"| {t['clip']} | {t['hold']} | {'・'.join(map(str, t['truth']))} | {failed.get(fn, 'not read (no log line)')} | | |")
            continue
        nums = g["nums"] if g["strong"] else []
        if g["source"] == "truth":
            c["truth_frame"] += 1
        if not nums:
            verdict = "番号なし" + (f" (weak {g['nums']})" if g["nums"] else "")
            c["unread"] += 1
        elif any(n not in t["truth"] for n in nums):
            verdict = "誤"
            c["wrong"] += 1
        elif sorted(nums) == sorted(t["truth"]):
            verdict = "正"
            c["right"] += 1
            c["framed"] += 1 if g["framed"] else 0
        else:
            verdict = "番号なし (one of the spread's two)"
            c["unread"] += 1
        rows.append(f"| {t['clip']} | {t['hold']} | {'・'.join(map(str, t['truth']))} | {'・'.join(map(str, g['nums'])) or '—'} {verdict} | "
                    f"{g['source']} {g['page']} | {g['read_ms']} |")
    md = ["### Phone-resolution stills (not the live camera)", "",
          "The capture screen's own page cut and number read (DocAligner frame, gutter cut, page warp ≤ 2400 px, bands + folio "
          "pieces in one ML Kit call) on the middle frame of every hold, rendered by the clip generator at a phone's still size "
          "(3000x4000 for one page, 4000x3000 for a spread) instead of the emulator camera's 960x1280. Read = a strong pick "
          "(the number the screen keeps).", "",
          "| clip | still size | stills | right | wrong | unread | read rate | frame from the truth (model gave none) |",
          "| --- | --- | --- | --- | --- | --- | --- | --- |"]
    tot = {"stills": 0, "right": 0, "wrong": 0, "unread": 0}
    for name, c in clips.items():
        rate = c["right"] / c["stills"] * 100 if c["stills"] else 0
        md.append(f"| {name} | {c['size']} | {c['stills']} | {c['right']} | {c['wrong']} | {c['unread']} | {rate:.0f} % | {c['truth_frame']} |")
        for k in tot:
            tot[k] += c[k]
    if tot["stills"]:
        md.append(f"| all | | {tot['stills']} | {tot['right']} | {tot['wrong']} | {tot['unread']} | {tot['right'] / tot['stills'] * 100:.0f} % | |")
    md += ["", "| clip | hold | printed | read | frame, page px | read (ms) |", "| --- | --- | --- | --- | --- | --- |"] + rows + [""]
    return md, clips


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
    per_page = ["| clip | step | hold | printed | screen said | corner err (clip px, tl tr br bl) | number kept | number | 撮れた until (ms) | number read (ms) | shot |",
                "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"]
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
            err, num, verdict, shot_ms, read_ms = "", "", "", "", ""
            if c:
                kept = c["measure"].get("kept")
                if kept:
                    err = f"{kept['mean_px']} / {kept['max_px']} {kept['err_px']}"
                    stats["errs"].append(kept["mean_px"])
                    stats["maxes"].append(kept["max_px"])
                else:
                    err = c["measure"].get("error", "")
                num = "・".join(map(str, c["nums"])) or "—"
                shot_ms = str(c.get("shot_ms", ""))
                read_ms = str(c.get("number_ms", "")) if "number_ms" in c else "（出ず）"
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
                            f"{err} | {num} | {verdict} | {shot_ms} | {read_ms} | {r['shot']} |")
        rows, gaps, leftover = list_check(a.out, name, gts)
        shown = {p for c in cc if c.get("kind") not in (None, "duplicate") for p in (truth[c["measure"]["hold"]] if "hold" in c["measure"] and c["measure"]["hold"] < len(truth) else [])}
        book = set(g["pages"])
        false_red = [gp["range"] for gp in gaps if gp["range"] and not any(p in book and p not in shown and p in g["target_pages"] for p in range(gp["range"][0], gp["range"][1] + 1))]
        kept_caps = [c for c in cc if c.get("kind") != "duplicate"]
        per_hold = {}
        for c in kept_caps:
            per_hold[c["measure"].get("hold")] = per_hold.get(c["measure"].get("hold"), 0) + 1
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
            "pages_taken": len(kept_caps), "pages_extra": len(kept_caps) - len([h for h in per_hold if h is not None]),
            "pages_dropped_as_taken": sum(1 for c in cc if c.get("kind") == "duplicate"),
        }
        clips_out.append(c_out)
    md.append("### Live camera (the emulator camera's 960x1280 picture)")
    md.append("")
    md.append("| clip | pages in plan | 撮れた | 赤 | 灰（番号なし） | 黄 | 撮影済み | 何も出ない | pages taken (same hold again) | corner err mean / max (clip px) | numbers right / wrong / unread | list: rows, red rows (false), grey | 「受け取れていません」 left | notices.tsv red / yellow |")
    md.append("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    tot = {"none": 0, "wrong": 0}
    for c in clips_out:
        s = c["said"]
        md.append(f"| {c['clip']} | {c['steps']} | {s.get('taken', 0) + s.get('filled', 0) + s.get('shot', 0)} | {s.get('gap', 0) + s.get('gap-notice', 0)} | "
                  f"{s.get('unread', 0)} | {s.get('yellow', 0)} | {s.get('duplicate', 0)} | {s.get('none', 0)} | "
                  f"{c['pages_taken']} ({c['pages_extra']}) | "
                  f"{c['corner_mean_px']} / {c['corner_max_px']} | {c['numbers_right']} / {c['numbers_wrong']} / {c['numbers_unread']} | "
                  f"{c['list_rows']}, {c['list_red'] or '-'} ({c['list_false_red'] or 0}), {c['list_grey']} | {c['leftover_not_received']} | "
                  f"{c['notices_red']} / {c['notices_yellow']} |")
        tot["none"] += s.get("none", 0)
        tot["unread_said"] = tot.get("unread_said", 0) + s.get("unread", 0)
        tot["wrong"] += c["numbers_wrong"]
        tot["right"] = tot.get("right", 0) + c["numbers_right"]
        tot["extra"] = tot.get("extra", 0) + c["pages_extra"]
        tot["rows"] = tot.get("rows", 0) + c["list_rows"]
    md.append("")
    skip = [r for r in checks if r["clip"] == "single-land-white" and r["hold"] in ("4", "3")]
    skip_txt = "; ".join(f"hold {r['hold']}: {SAID.get(r['result'], r['result'])} {r['text']}" for r in skip) or "not run"
    md.append(f"Total: {sum(c['steps'] for c in clips_out)} pages in the plan, {tot['none']} with nothing shown, "
              f"{tot.get('extra', 0)} pages taken again in the same hold, {tot.get('rows', 0)} list rows, "
              f"{tot.get('right', 0)} numbers right, {tot['wrong']} numbers wrong. "
              f"Skipped page (single-land-white p37): {skip_txt}.")
    md.append("")
    # How long reading a page number takes (it runs while the user turns on).
    ocr = read_ocr_calls(os.path.join(a.out, "events.log"))
    md.append("Number reading time (median / max):")
    md.append("")
    md.append("| what | time |")
    md.append("| --- | --- |")
    md.append(f"| page held still → 「✓ 撮れた」 (still picture, frame, cut) | {ms_stats([c['shot_ms'] for c in caps if 'shot_ms' in c])} |")
    md.append(f"| one page's number (first read, + second read when needed) | {ms_stats([c['number_ms'] for c in caps if 'number_ms' in c])} |")
    md.append(f"| first read only | {ms_stats([c['read_ms'] for c in caps if 'read_ms' in c])} |")
    md.append(f"| waiting behind earlier pages | {ms_stats([c['queued_ms'] for c in caps if 'queued_ms' in c])} |")
    kept = [c for c in caps if c.get("kind") not in (None, "duplicate")]
    fast = [c for c in kept if c["nums"] and c.get("shot_ms", 0) + c.get("number_ms", 10**9) <= 30000]
    md.append(f"| pages whose number was up within 30 s of the shot (「✓ N ページ」) | {len(fast)} of {len(kept)} |")
    label = {"margins": "bands + folio pieces, one picture (while taking pages)", "band": "band (while taking pages)",
             "folio": "folio (while taking pages)",
             "extra": "other folio renderings, only when the first picture gave no number (single pages)",
             "warmup": "warmup (screen opening)",
             "solo": "margin picture alone (camera stopped, on close)"}
    for ps in ("margins", "extra", "band", "folio", "warmup", "solo"):
        calls = [o for o in ocr if o["pass"] == ps]
        if not calls and ps in ("band", "folio"):
            continue
        bad = sum(1 for o in calls if not o["ok"])
        md.append(f"| one ML Kit call, {label[ps]} | {ms_stats([o['ms'] for o in calls])}{f', {bad} failed' if bad else ''} |")
    waits = []
    try:
        for line in open(os.path.join(a.out, "events.log"), encoding="utf-8", errors="replace"):
            m = re.search(r"AstarScanMlkit\s*:\s*waited (\d+)ms for the previous call", line)
            if m:
                waits.append(int(m.group(1)))
    except OSError:
        pass
    md.append(f"| a call waiting for the previous one (timed out, still in ML Kit) | {ms_stats(waits)} |")
    timeouts = 0
    try:
        timeouts = sum(1 for line in open(os.path.join(a.out, "events.log"), encoding="utf-8", errors="replace") if "text recognition timed out" in line)
    except OSError:
        pass
    md.append(f"| calls that timed out (20 s) | {timeouts} |")
    md.append("")
    save_md, save_res = save_report(a.out, caps)
    md += save_md
    stills_md, stills_res = stills_report(a.out)
    md += stills_md
    md += ["### Live camera, per page", ""]
    md += per_page
    text = "\n".join(md) + "\n"
    with open(os.path.join(a.out, "measure.md"), "w") as f:
        f.write(text)
    with open(os.path.join(a.out, "measure.json"), "w") as f:
        json.dump({"clips": clips_out, "save": save_res, "stills": stills_res, "captures": caps, "ocr_calls": read_ocr_calls(os.path.join(a.out, "events.log"))}, f, ensure_ascii=False, indent=1, default=float)
    print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
