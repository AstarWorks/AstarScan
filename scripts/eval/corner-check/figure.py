"""python3 -I figure.py MODEL CLIP_DIR FRAME_IDX OUT.jpg [--transpose]
Panel: frame with GT (green) + model keypoints (red) + model box (blue) | crop the app would save (model quad) | crop of GT quad.
"""
import json, sys
import numpy as np, cv2, onnxruntime as ort
model, clip, idx, outp = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4]
tr = '--transpose' in sys.argv
gt = json.load(open(clip + '/gt.json'))
sess = ort.InferenceSession(model, providers=['CPUExecutionProvider'])
img = cv2.imread(f'{clip}/frames/{idx:04d}.png')
K = ['tl', 'tr', 'br', 'bl']
q = [(gt['frames'][idx]['quad'][k]['x'], gt['frames'][idx]['quad'][k]['y']) for k in K]
if tr:
    Wd = img.shape[1]; img = cv2.rotate(img, cv2.ROTATE_90_COUNTERCLOCKWISE)
    pts = [(y, Wd - 1 - x) for x, y in q]
    q = [min(pts, key=lambda p: p[0] + p[1]), min(pts, key=lambda p: p[1] - p[0]), max(pts, key=lambda p: p[0] + p[1]), max(pts, key=lambda p: p[1] - p[0])]
h, w = img.shape[:2]; s = min(640 / w, 640 / h); nw, nh = round(w * s), round(h * s); px, py = (640 - nw) // 2, (640 - nh) // 2
c = np.full((640, 640, 3), 114, np.uint8); c[py:py + nh, px:px + nw] = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_AREA)
o = sess.run(None, {'images': (c[:, :, ::-1].astype(np.float32) / 255).transpose(2, 0, 1)[None]})[0][0]
a = int(np.argmax(o[4])); cx, cy, bw, bh = o[:4, a]
kp = [((o[5 + 3 * k, a] - px) / s, (o[6 + 3 * k, a] - py) / s) for k in range(4)]
vis = img.copy()
cv2.polylines(vis, [np.int32(q)], True, (0, 200, 0), 5)
cv2.rectangle(vis, (int((cx - bw / 2 - px) / s), int((cy - bh / 2 - py) / s)), (int((cx + bw / 2 - px) / s), int((cy + bh / 2 - py) / s)), (255, 120, 0), 2)
cv2.polylines(vis, [np.int32(kp)], True, (0, 0, 255), 5)
cv2.putText(vis, f'conf {o[4, a]:.2f}', (15, 40), cv2.FONT_HERSHEY_SIMPLEX, 1.1, (0, 0, 255), 3)
def warp(quad, W=420, H=594):
    M = cv2.getPerspectiveTransform(np.float32(quad), np.float32([[0, 0], [W, 0], [W, H], [0, H]]))
    if tr:  # landscape frame holds a sideways page; keep the crop upright-ish for display
        M = cv2.getPerspectiveTransform(np.float32(quad), np.float32([[0, 0], [H, 0], [H, W], [0, W]])); return cv2.warpPerspective(img, M, (H, W))
    return cv2.warpPerspective(img, M, (W, H))
def fit(im, H):
    return cv2.resize(im, (int(im.shape[1] * H / im.shape[0]), H))
Hh = 640
panels = [fit(vis, Hh), fit(warp(kp), Hh), fit(warp(q), Hh)]
labels = ['frame: GT green / model red / box blue', 'saved crop (model corners)', 'crop from true corners']
row = []
for p, l in zip(panels, labels):
    p = cv2.copyMakeBorder(p, 36, 0, 0, 12, cv2.BORDER_CONSTANT, value=(255, 255, 255))
    cv2.putText(p, l, (6, 25), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 0), 2)
    row.append(p)
cv2.imwrite(outp, np.hstack(row), [cv2.IMWRITE_JPEG_QUALITY, 85])
