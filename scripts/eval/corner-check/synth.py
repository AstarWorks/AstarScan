"""Synthetic 'A4 page on desk' clip with exact corner GT.

python3 -I synth.py OUT_DIR W H [n_pages] [--fit]
  --fit: the whole page fits inside the frame (landscape frame with an
         upright portrait page) instead of filling the frame width.
  --light: light grey desk (low paper/desk contrast) instead of wood.
Writes OUT_DIR/clip.y4m (10 fps), OUT_DIR/frames/NNNN.png, OUT_DIR/gt.json
"""
import json, os, sys, math
import numpy as np, cv2

out, W, H = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
pos = [a for a in sys.argv[1:] if not a.startswith('--')]
n_pages = int(pos[3]) if len(pos) > 3 else 4
fit = '--fit' in sys.argv
light = '--light' in sys.argv
rng = np.random.default_rng(7)
os.makedirs(out + '/frames', exist_ok=True)

def desk():
    base = np.zeros((H, W, 3), np.float32)
    base[:] = (200, 205, 210) if light else (60, 105, 150)  # BGR grey / wood
    stripes = np.sin(np.linspace(0, 60, W))[None, :, None] * 12
    noise = rng.normal(0, 6, (H, W, 1))
    return np.clip(base + stripes + noise, 0, 255).astype(np.uint8)

def page(seed):
    r = np.random.default_rng(seed)
    pw, ph = 840, 1188
    img = np.full((ph, pw, 3), 245, np.uint8)
    y = 90
    cv2.putText(img, f'STEP {seed}', (70, y), cv2.FONT_HERSHEY_DUPLEX, 2.2, (20, 20, 20), 4)
    y += 80
    while y < ph - 90:
        if r.random() < 0.15:
            h = int(r.integers(120, 260))
            x0 = int(r.integers(70, 300))
            cv2.rectangle(img, (x0, y), (x0 + int(r.integers(200, 450)), min(ph - 90, y + h)), (40, 40, 40), 3)
            cv2.circle(img, (x0 + 100, y + h // 2), int(h / 3), (60, 60, 60), 3)
            y += h + 30
        else:
            words = ''.join(chr(int(c)) for c in r.integers(97, 123, 34))
            cv2.putText(img, words, (70, y), cv2.FONT_HERSHEY_SIMPLEX, 0.95, (30, 30, 30), 2)
            y += 42
    return img

frames, gts = [], []
bg = desk()
FPS = 10
for p in range(n_pages):
    pg = page(p + 1)
    ph, pw = pg.shape[:2]
    # Page fills the frame width (like the GT clip: x 4%..100%).
    margin = 0.05 * W
    pw_s = W - 2 * margin
    if fit:
        pw_s = min(pw_s, (H - 2 * 0.05 * H) / 1.414)
    ph_s = pw_s * 1.414
    cx, cy = W / 2 + rng.uniform(-0.02, 0.02) * W, H / 2 + rng.uniform(-0.03, 0.03) * H
    ang = math.radians(rng.uniform(-4, 4))
    base = np.array([[-pw_s / 2, -ph_s / 2], [pw_s / 2, -ph_s / 2], [pw_s / 2, ph_s / 2], [-pw_s / 2, ph_s / 2]])
    rot = np.array([[math.cos(ang), -math.sin(ang)], [math.sin(ang), math.cos(ang)]])
    # Mild perspective: top edge a bit narrower.
    persp = base.copy()
    persp[0, 0] += 0.03 * pw_s; persp[1, 0] -= 0.03 * pw_s
    hold = 25  # 2.5 s
    for f in range(hold + 6):
        jitter = np.array([math.sin(f * 0.7) * 2.0, math.cos(f * 0.5) * 2.0])
        if f >= hold:  # slide out to the left
            jitter = jitter + np.array([-(f - hold + 1) * W * 0.2, 0])
        dst = (persp @ rot.T) + np.array([cx, cy]) + jitter
        M = cv2.getPerspectiveTransform(np.float32([[0, 0], [pw, 0], [pw, ph], [0, ph]]), np.float32(dst))
        fr = bg.copy()
        warped = cv2.warpPerspective(pg, M, (W, H))
        mask = cv2.warpPerspective(np.full((ph, pw), 255, np.uint8), M, (W, H))
        fr[mask > 0] = warped[mask > 0]
        fr = cv2.GaussianBlur(fr, (3, 3), 0)
        frames.append(fr)
        gts.append({'page': p + 1, 'holding': f < hold,
                    'quad': {k: {'x': float(dst[i, 0]), 'y': float(dst[i, 1])} for i, k in enumerate(['tl', 'tr', 'br', 'bl'])}})
    for f in range(8):  # empty desk between pages
        frames.append(bg.copy()); gts.append({'page': None, 'holding': False, 'quad': None})

for i, fr in enumerate(frames):
    cv2.imwrite(f'{out}/frames/{i:04d}.png', fr)
json.dump({'W': W, 'H': H, 'fps': FPS, 'frames': gts}, open(out + '/gt.json', 'w'))
print(len(frames), 'frames')
