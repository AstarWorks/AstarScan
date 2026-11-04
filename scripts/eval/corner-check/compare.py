"""Compare corner error of: model keypoints / model box / OpenCV Otsu (full frame) / Otsu inside model box.
python3 -I compare.py MODEL CLIP_DIR
"""
import json, sys, math
import numpy as np, cv2, onnxruntime as ort

model, clip = sys.argv[1], sys.argv[2]
gt = json.load(open(clip + '/gt.json'))
sess = ort.InferenceSession(model, providers=['CPUExecutionProvider'])
K = ['tl', 'tr', 'br', 'bl']

def run(img):
    h, w = img.shape[:2]; s = min(640 / w, 640 / h); nw, nh = round(w * s), round(h * s)
    px, py = (640 - nw) // 2, (640 - nh) // 2
    c = np.full((640, 640, 3), 114, np.uint8); c[py:py + nh, px:px + nw] = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_AREA)
    o = sess.run(None, {'images': (c[:, :, ::-1].astype(np.float32) / 255).transpose(2, 0, 1)[None]})[0][0]
    a = int(np.argmax(o[4])); cx, cy, bw, bh = o[:4, a]
    kp = [((o[5 + 3 * k, a] - px) / s, (o[6 + 3 * k, a] - py) / s) for k in range(4)]
    box = ((cx - bw / 2 - px) / s, (cy - bh / 2 - py) / s, (cx + bw / 2 - px) / s, (cy + bh / 2 - py) / s)
    return float(o[4, a]), kp, box

def order(pts):
    pts = list(pts)
    return [min(pts, key=lambda p: p[0] + p[1]), min(pts, key=lambda p: p[1] - p[0]),
            max(pts, key=lambda p: p[0] + p[1]), max(pts, key=lambda p: p[1] - p[0])]

def otsu(img, roi=None):
    x0, y0 = 0, 0
    if roi is not None:
        h, w = img.shape[:2]; bx0, by0, bx1, by1 = roi; m = 0.08 * max(bx1 - bx0, by1 - by0)
        x0, y0 = int(max(0, bx0 - m)), int(max(0, by0 - m)); x1, y1 = int(min(w, bx1 + m)), int(min(h, by1 + m))
        img = img[y0:y1, x0:x1]
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    _, b = cv2.threshold(g, 0, 255, cv2.THRESH_BINARY | cv2.THRESH_OTSU)
    k = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
    b = cv2.morphologyEx(cv2.morphologyEx(b, cv2.MORPH_CLOSE, k), cv2.MORPH_OPEN, k)
    cs, _ = cv2.findContours(b, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    A = g.shape[0] * g.shape[1]
    cs = [c for c in cs if 0.1 * A <= cv2.contourArea(c) <= 0.98 * A]
    if not cs: return None
    c = max(cs, key=cv2.contourArea)
    return order([(p[0] + x0, p[1] + y0) for p in cv2.boxPoints(cv2.minAreaRect(c))])

def iou(p, q):
    W, H = gt['W'] + 400, gt['H'] + 400
    a = np.zeros((H, W), np.uint8); b = np.zeros((H, W), np.uint8)
    cv2.fillPoly(a, [np.int32(np.array(p) + 200)], 1); cv2.fillPoly(b, [np.int32(np.array(q) + 200)], 1)
    return (a & b).sum() / max(1, (a | b).sum()), (a & b).sum() / max(1, b.sum())

transpose = '--transpose' in sys.argv  # rotate 90deg CCW -> landscape frame
errs = {'keypoints': [], 'box': [], 'otsu': [], 'otsu_in_box': []}
ious, covs, confs = [], [], []
for i, g in enumerate(gt['frames']):
    if not g['holding']: continue
    img = cv2.imread(f'{clip}/frames/{i:04d}.png')
    q = [(g['quad'][k]['x'], g['quad'][k]['y']) for k in K]
    if transpose:
        Wd = img.shape[1]
        img = cv2.rotate(img, cv2.ROTATE_90_COUNTERCLOCKWISE)
        q = order([(y, Wd - 1 - x) for x, y in q])
    conf, kp, box = run(img)
    confs.append(conf)
    u, c = iou(kp, q); ious.append(u); covs.append(c)
    cands = {'keypoints': kp, 'box': [(box[0], box[1]), (box[2], box[1]), (box[2], box[3]), (box[0], box[3])],
             'otsu': otsu(img), 'otsu_in_box': otsu(img, box)}
    for n, p in cands.items():
        if p is not None:
            errs[n].append(np.mean([math.dist(p[j], q[j]) for j in range(4)]))
print(f'model conf median {np.median(confs):.2f} (>=0.5: {sum(c >= 0.5 for c in confs)}/{len(confs)})  '
      f'keypoint quad IoU vs GT median {np.median(ious):.2f}  page area covered median {np.median(covs)*100:.0f}%')
for n, e in errs.items():
    print(f'{n:12s} n={len(e):3d} mean {np.mean(e):6.1f}px  median {np.median(e):6.1f}px  max {np.max(e):6.1f}px')
