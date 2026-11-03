"""Compare page-frame detectors on the book clips, as the emulator camera sees them.

    python3 -I corner-compare.py <clips-dir> [--size 1280x960] [--per-hold 3]
        [--docaligner model.onnx] [--json out.json] [--dump dir]

Every hold of every clip is sampled (`--per-hold` frames); each frame is
rendered exactly as scripts/android/camera-feed.py writes it to the
emulator's webcam (the 3:4 window the phone sees), each detector frames
the page(s) on it, and the frame is compared with the ground truth in clip
pixels:

- spread clips: the outer corners of the open spread;
- single clips: the target (right) page.

The detectors:

- `cv-edges`   OpenCV: Canny edges → largest convex 4-gon (CaptureDetector.kt
               first stage, the classic "document scanner" contour);
- `cv-paper`   OpenCV: bright, low-saturation paper mask (Otsu on L - S) →
               largest blob → 4-gon fitted to its hull;
- `docaligner` DocAligner heatmap model (DocsaidLab, Apache-2.0, ONNX,
               lcnet100, 256×256), when `--docaligner` gives the model file
               (scripts/android/fetch-docaligner.sh);
- `*+app`      the detector's frame, then what the capture screen does with
               it (app_frame(): GutterTrim on one page, edge fit on a spread).

Reports per clip and detector: frames framed, corner error mean / max
(clip px), and the share of frames within 2 % of the page diagonal.
"""

import argparse
import importlib.util
import json
import os
import sys

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location(
    "feed", os.path.join(HERE, "..", "..", "android", "camera-feed.py"))
feed = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(feed)

ORDER = ("tl", "tr", "br", "bl")


# --------------------------------------------------------------- geometry

def order_quad(pts):
    """4 points → tl, tr, br, bl (y down)."""
    p = np.float32(pts).reshape(4, 2)
    c = p.mean(axis=0)
    ang = np.arctan2(p[:, 1] - c[1], p[:, 0] - c[0])
    p = p[np.argsort(ang)]  # -pi..pi from the left, clockwise on screen: tl first-ish
    # rotate so that tl (min x + y) is first
    k = int(np.argmin(p.sum(axis=1)))
    return np.roll(p, -k, axis=0)


def quad_ok(q, w, h, min_area=0.10):
    q = np.float32(q).reshape(4, 2)
    if not cv2.isContourConvex(q.reshape(-1, 1, 2)):
        return False
    return cv2.contourArea(q) >= min_area * w * h


def err_px(found, gt):
    return [float(np.hypot(*(np.float32(found[i]) - np.float32(gt[i])))) for i in range(4)]


# -------------------------------------------------------------- detectors

WORK = 480  # long side the detectors work on (the app: ImageAnalysis frames)


def _small(img):
    s = WORK / max(img.shape[:2])
    return cv2.resize(img, None, fx=s, fy=s, interpolation=cv2.INTER_AREA), s


def fit_quad(cnt):
    """Contour → 4-gon: approxPolyDP with a growing epsilon, else the
    4 hull points farthest along the diagonals."""
    hull = cv2.convexHull(cnt)
    peri = cv2.arcLength(hull, True)
    for f in (0.01, 0.02, 0.03, 0.04, 0.05, 0.07):
        ap = cv2.approxPolyDP(hull, f * peri, True)
        if len(ap) == 4:
            return ap.reshape(4, 2).astype(np.float32)
    p = hull.reshape(-1, 2).astype(np.float32)
    s, d = p.sum(1), p[:, 0] - p[:, 1]
    return np.float32([p[np.argmin(s)], p[np.argmax(d)], p[np.argmax(s)], p[np.argmin(d)]])


def refine_quad(q, gray):
    """Fit each side to the strongest edge near it (line fit on gradient
    maxima along normals), then intersect the sides."""
    q = order_quad(q)
    gx = cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3)
    h, w = gray.shape
    lines = []
    for i in range(4):
        a, b = q[i], q[(i + 1) % 4]
        d = b - a
        L = float(np.hypot(*d))
        if L < 10:
            return q
        t = d / L
        n = np.float32([-t[1], t[0]])
        pts = []
        for s in np.linspace(0.1, 0.9, 25):
            c = a + d * s
            best, bv = None, 0.0
            for o in range(-6, 7):
                x, y = c + n * o
                xi, yi = int(round(x)), int(round(y))
                if 0 <= xi < w and 0 <= yi < h:
                    v = abs(gx[yi, xi] * n[0] + gy[yi, xi] * n[1])
                    if v > bv:
                        bv, best = v, (x, y)
            if best is not None and bv > 20:
                pts.append(best)
        if len(pts) < 6:
            lines.append((a, t))
            continue
        vx, vy, x0, y0 = cv2.fitLine(np.float32(pts), cv2.DIST_HUBER, 0, 0.01, 0.01).ravel()
        lines.append((np.float32([x0, y0]), np.float32([vx, vy])))
    out = []
    for i in range(4):
        (p1, d1), (p2, d2) = lines[i - 1], lines[i]
        A = np.float32([[d1[0], -d2[0]], [d1[1], -d2[1]]])
        if abs(np.linalg.det(A)) < 1e-6:
            return q
        s = np.linalg.solve(A, p2 - p1)
        out.append(p1 + d1 * s[0])
    out = np.float32(out)
    if np.max(np.abs(out - q)) > 12:
        return q
    return out


def det_cv_edges(img, refine=True):
    small, s = _small(img)
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    g = cv2.GaussianBlur(gray, (5, 5), 0)
    med = float(np.median(g))
    edges = cv2.Canny(g, int(max(0, 0.66 * med) * 0.5), int(min(255, 1.33 * med) * 0.6))
    edges = cv2.dilate(edges, cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3)))
    cnts, _ = cv2.findContours(edges, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    h, w = gray.shape
    best, ba = None, 0
    for c in sorted(cnts, key=cv2.contourArea, reverse=True)[:8]:
        q = fit_quad(c)
        a = cv2.contourArea(q)
        if a > ba and quad_ok(q, w, h):
            best, ba = q, a
    if best is None:
        return None
    if refine:
        best = refine_quad(best, g)
    return order_quad(best / s)


def det_cv_paper(img, refine=True):
    small, s = _small(img)
    hls = cv2.cvtColor(small, cv2.COLOR_BGR2HLS)
    L = hls[:, :, 1].astype(np.int16)
    S = hls[:, :, 2].astype(np.int16)
    v = np.clip(L - S // 2, 0, 255).astype(np.uint8)
    v = cv2.GaussianBlur(v, (7, 7), 0)
    _, m = cv2.threshold(v, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (15, 15)))
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (7, 7)))
    cnts, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not cnts:
        return None
    c = max(cnts, key=cv2.contourArea)
    h, w = m.shape
    q = fit_quad(c)
    if not quad_ok(q, w, h):
        return None
    if refine:
        q = refine_quad(q, cv2.cvtColor(small, cv2.COLOR_BGR2GRAY))
    return order_quad(q / s)


class DocAligner:
    """DocAligner heatmap model, as CaptureDetector.kt runs it: the frame is
    padded to a square (black), resized to 256×256 BGR in [0, 1] (the
    channel order DocAligner was trained on: capybara.imread); every
    corner is the arg-max of its 128×128 heatmap, refined to the weighted
    centroid of the 5×5 cells around it. `peaks` (0..1) is how sure the
    model is of each corner; the app frames a page only when all four are
    ≥ MIN_PEAK."""

    MIN_PEAK = 0.3

    def __init__(self, path):
        import onnxruntime as ort
        self.sess = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
        self.inp = self.sess.get_inputs()[0].name

    def detect(self, img):
        h, w = img.shape[:2]
        S = max(h, w)
        sq = np.zeros((S, S, 3), np.uint8)
        ox, oy = (S - w) // 2, (S - h) // 2
        sq[oy:oy + h, ox:ox + w] = img
        x = cv2.resize(sq, (256, 256), interpolation=cv2.INTER_AREA)
        x = np.transpose(x, (2, 0, 1)).astype(np.float32)[None] / 255.0
        hm = self.sess.run(None, {self.inp: x})[0][0]
        gh, gw = hm.shape[1:]
        pts, peaks = [], []
        for i in range(4):
            m = hm[i]
            y, xx = divmod(int(np.argmax(m)), gw)
            peaks.append(float(m[y, xx]))
            y0, y1, x0, x1 = max(0, y - 2), min(gh, y + 3), max(0, xx - 2), min(gw, xx + 3)
            win = np.clip(m[y0:y1, x0:x1], 0, None)
            yy, xg = np.mgrid[y0:y1, x0:x1]
            sw = max(float(win.sum()), 1e-6)
            cx, cy = float((win * xg).sum()) / sw, float((win * yy).sum()) / sw
            pts.append(((cx + 0.5) * S / gw - ox, (cy + 0.5) * S / gh - oy))
        return np.float32(pts), peaks

    def __call__(self, img):
        q, peaks = self.detect(img)
        if min(peaks) < self.MIN_PEAK:
            return None
        q = order_quad(q)
        return q if quad_ok(q, img.shape[1], img.shape[0], 0.05) else None


# ------------------------------------------------- the app's page frame

# GutterTrim.kt, line for line (constants and steps), on a warped page.
PORTRAIT_MIN, SEARCH_FROM, SEARCH_TO = 1.05, 0.03, 0.30
SHADOW_MAX, BEYOND_RISE, BEYOND_WIDTH = 0.80, 0.35, 0.01
BANDS = ((0.08, 0.40), (0.60, 0.92))


def _band_profile(lum, ya, yb):
    w = lum.shape[1]
    raw = np.sort(lum[ya:yb], axis=0)[min(yb - ya - 1, int(np.ceil((yb - ya) * 0.8)) - 1)]
    r = max(1, int(w * 0.005))
    return np.convolve(np.pad(raw.astype(np.float64), r, mode="edge"), np.ones(2 * r + 1) / (2 * r + 1), mode="valid")


def _fold(p, from_right):
    w = len(p)
    at = (lambda d: p[w - 1 - d]) if from_right else (lambda d: p[d])
    mid = sorted(p[int(np.ceil(w * 0.35)):int(w * 0.65) + 1])
    if not mid:
        return None
    paper = mid[len(mid) // 2]
    if paper < 60:
        return None
    a, b = int(w * SEARCH_FROM), int(w * SEARCH_TO)
    best = min(range(a, b + 1), key=lambda d: (at(d), d))
    if at(best) > paper * SHADOW_MAX:
        return None
    floor = at(best) + (paper - at(best)) * BEYOND_RISE
    if sum(1 for i in range(best) if at(i) >= floor) < w * BEYOND_WIDTH:
        return None
    return best / w


def _corners(a, b, ya, yb):
    if a is None and b is None:
        return 0.0, 0.0
    if a is None:
        return 0.0, b
    if b is None:
        return a, 0.0
    s = (b - a) / (yb - ya)
    return min(max(a - s * ya, 0.0), SEARCH_TO), min(max(a + s * (1 - ya), 0.0), SEARCH_TO)


def gutter_cut(lum):
    h = lum.shape[0]
    per = [_band_profile(lum, int(h * a), int(h * b)) for a, b in BANDS]
    y0, y1 = sum(BANDS[0]) / 2, sum(BANDS[1]) / 2
    lt, lb = _corners(_fold(per[0], False), _fold(per[1], False), y0, y1)
    rt, rb = _corners(_fold(per[0], True), _fold(per[1], True), y0, y1)
    return lt, lb, rt, rb


def quad_size(q):
    w = (np.hypot(*(q[1] - q[0])) + np.hypot(*(q[2] - q[3]))) / 2
    h = (np.hypot(*(q[3] - q[0])) + np.hypot(*(q[2] - q[1]))) / 2
    return float(w), float(h)


def app_frame(img, q):
    """The frame the capture screen keeps from a detected frame (PageFrame.kt):
    a portrait frame (one page) goes through GutterTrim — cut back to the
    gutter when it ran past it; a wide frame (a spread) gets its sides
    fitted to the strongest paper edge nearby."""
    q = order_quad(q)
    W, H = quad_size(q)
    if W <= 0:
        return q
    if H >= W * PORTRAIT_MIN:
        s = min(1.0, 800 / max(W, H))
        W2, H2 = max(8, int(W * s)), max(8, int(H * s))
        M = cv2.getPerspectiveTransform(q, np.float32([[0, 0], [W2, 0], [W2, H2], [0, H2]]))
        lum = cv2.cvtColor(cv2.warpPerspective(img, M, (W2, H2)), cv2.COLOR_BGR2GRAY)
        lt, lb, rt, rb = gutter_cut(lum)
        if lt or lb or rt or rb:
            Hm = cv2.getPerspectiveTransform(np.float32([[0, 0], [1, 0], [1, 1], [0, 1]]), q)
            pts = np.float32([[lt, 0], [1 - rt, 0], [1 - rb, 1], [lb, 1]]).reshape(-1, 1, 2)
            q = cv2.perspectiveTransform(pts, Hm).reshape(-1, 2)
        return q
    gray = cv2.GaussianBlur(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY), (3, 3), 0)
    return refine_quad(q, gray)


# ------------------------------------------------------------------- main

def gt_quad(frame, mode):
    pages = {p["side"]: p for p in frame["pages"] if p["state"] == "static"}
    if mode == "spread":
        if "left" not in pages or "right" not in pages:
            return None
        L, R = pages["left"]["corners"], pages["right"]["corners"]
        return [L["tl"], R["tr"], R["br"], L["bl"]]
    t = [p for p in frame["pages"] if p.get("target") and p["state"] == "static"]
    if not t:
        return None
    return [t[0]["corners"][k] for k in ORDER]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("clips")
    ap.add_argument("--size", default="1280x960")
    ap.add_argument("--per-hold", type=int, default=4)
    ap.add_argument("--docaligner")
    ap.add_argument("--json")
    ap.add_argument("--dump")
    ap.add_argument("--view", choices=("window", "full"), default="window",
                    help="what the camera feed shows (camera-feed.py VIEW): window = the 3:4 part ML Kit's "
                         "scanner showed; full = the book fitted into the whole webcam frame (the capture screen)")
    a = ap.parse_args()
    W, H = map(int, a.size.split("x"))
    feed.VIEW = a.view
    wx, wy, ww, wh = feed.window(W, H)
    dets = {
        "cv-edges": det_cv_edges,
        "cv-paper": det_cv_paper,
    }
    if a.docaligner:
        dets["docaligner"] = DocAligner(a.docaligner)
    else:
        print("(no --docaligner model: OpenCV detectors only)", file=sys.stderr)
    names = []
    for n in dets:
        names += [n, n + "+app"]
    rows = {}
    per = {}
    for gtp in sorted(f for f in os.listdir(a.clips) if f.endswith(".gt.json")):
        with open(os.path.join(a.clips, gtp)) as f:
            gt = json.load(f)
        clip, mode = gt["clip"], gt["mode"]
        box = feed.clip_box(gt)
        _, scale, _, _ = feed.layout(gt["W"], gt["H"], W, H, box)
        cap = cv2.VideoCapture(os.path.join(a.clips, clip + ".mp4"))
        holds = [s for s in gt["segments"] if s["phase"] == "hold"]
        for hi, s in enumerate(holds):
            n = s["end_frame"] - s["start_frame"]
            for k in range(a.per_hold):
                fi = s["start_frame"] + int((k + 0.5) * n / a.per_hold)
                cap.set(cv2.CAP_PROP_POS_FRAMES, fi)
                ok, fr = cap.read()
                if not ok:
                    continue
                cam = feed.render_frame(fr, W, H, box)[wy:wy + wh, wx:wx + ww]
                g = gt_quad(gt["frames"][fi], mode)
                if g is None:
                    continue
                gq, _moved = visible(g, gt["W"], gt["H"])
                gcam = [feed.map_point(x, y, gt["W"], gt["H"], W, H, box) for x, y in gq]
                gcam = [(x - wx, y - wy) for x, y in gcam]
                diag = float(np.hypot(gq[0][0] - gq[2][0], gq[0][1] - gq[2][1]))
                for dn, fn in dets.items():
                    q = fn(cam)
                    for name, qq in ((dn, q), (dn + "+app", app_frame(cam, q) if q is not None else None)):
                        r = rows.setdefault((clip, name), [])
                        if qq is None:
                            r.append(None)
                            continue
                        e = [v / scale for v in err_px(order_quad(qq), gcam)]
                        r.append((sum(e) / 4, max(e), max(e) / diag))
                        per.setdefault(clip, {}).setdefault(name, []).append(
                            {"hold": hi, "frame": fi, "err": [round(v, 1) for v in e]})
                        if a.dump and name == "docaligner+app":
                            os.makedirs(a.dump, exist_ok=True)
                            im = cam.copy()
                            cv2.polylines(im, [np.int32(gcam).reshape(-1, 1, 2)], True, (255, 0, 0), 2)
                            cv2.polylines(im, [np.int32(order_quad(qq)).reshape(-1, 1, 2)], True, (0, 200, 0), 2)
                            cv2.imwrite(os.path.join(a.dump, f"{clip}-h{hi}-{fi}.jpg"), im)
    clips = sorted({c for c, _ in rows})
    out = ["| clip | detector | framed | mean err (clip px) | max err | within 2 % of diag |", "| --- | --- | --- | --- | --- | --- |"]
    summary = {}
    for c in clips:
        for n in names:
            r = rows.get((c, n), [])
            got = [x for x in r if x]
            if not r:
                continue
            mean = np.mean([x[0] for x in got]) if got else float("nan")
            mx = max(x[1] for x in got) if got else float("nan")
            good = sum(1 for x in got if x[2] <= 0.02)
            summary.setdefault(c, {})[n] = {"framed": len(got), "of": len(r), "mean": round(float(mean), 1),
                                            "max": round(float(mx), 1), "within2pct": good}
            out.append(f"| {c} | {n} | {len(got)}/{len(r)} | {mean:.1f} | {mx:.1f} | {good}/{len(r)} |")
    print("\n".join(out))
    if a.json:
        with open(a.json, "w") as f:
            json.dump({"summary": summary, "frames": per}, f, indent=1)
    return 0


def visible(quad, w, h):
    spec = importlib.util.spec_from_file_location(
        "bm", os.path.join(HERE, "..", "..", "android", "book-measure.py"))
    global _bm
    if "_bm" not in globals():
        _bm = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(_bm)
    return _bm.visible_quad([tuple(p) for p in quad], w, h)


if __name__ == "__main__":
    sys.exit(main())
