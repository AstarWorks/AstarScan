"""Draw the ground truth over frames of a clip, to check that the corners sit on the paper.

    python3 -I preview.py CLIP_DIR CLIP_NAME OUT_DIR [--per-hold K] [--width PX]

For each hold segment, K frames (default 1; evenly spaced inside the hold) are
decoded from CLIP_DIR/CLIP_NAME.mp4 and written as PNG with the ground truth
from CLIP_DIR/CLIP_NAME.gt.json drawn on top:
  - page outline (curved top/bottom edges + straight side edges), green = target page,
    yellow = other visible page, magenta = leaf being turned
  - corner dots labelled tl/tr/br/bl and the page number
Also writes OUT_DIR/CLIP_NAME-corners.png: 4x crops around the corners of
one hold frame, for a close look at whether each dot is on the paper corner.
"""
import json, os, sys
import numpy as np, cv2

COL = {'target': (60, 200, 60), 'other': (0, 210, 255), 'turning': (220, 60, 220)}


def overlay(img, fr, scale=1.0):
    out = img.copy()
    for p in fr['pages']:
        c = COL['turning'] if p['state'] == 'turning' else COL['target'] if p['target'] else COL['other']
        et = np.array(p['edge_top'], np.float32); eb = np.array(p['edge_bottom'], np.float32)
        poly = np.concatenate([et, eb[::-1]])
        cv2.polylines(out, [np.round(poly * 4).astype(np.int32)], True, c, 2, cv2.LINE_AA, 2)
        for k in ('tl', 'tr', 'br', 'bl'):
            x, y = p['corners'][k]
            cv2.circle(out, (int(round(x * 4)), int(round(y * 4))), 7 * 4, (0, 0, 255), 2, cv2.LINE_AA, 2)
            cv2.circle(out, (int(round(x * 4)), int(round(y * 4))), 2 * 4, (0, 0, 255), -1, cv2.LINE_AA, 2)
            cv2.putText(out, k, (int(x) + 10, int(y) - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (0, 0, 255), 2, cv2.LINE_AA)
        cx, cy = poly.mean(0)
        cv2.putText(out, f"p{p['page']} {p['side']}", (int(cx) - 70, int(cy)), cv2.FONT_HERSHEY_SIMPLEX, 1.4, c, 3,
                    cv2.LINE_AA)
    cv2.putText(out, f"frame {fr['i']}  {fr['phase']}", (20, 50), cv2.FONT_HERSHEY_SIMPLEX, 1.4, (0, 0, 255), 3,
                cv2.LINE_AA)
    if scale != 1.0:
        out = cv2.resize(out, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    return out


def corner_crops(img, fr, half=60, zoom=4):
    tiles = []
    for p in fr['pages']:
        for k in ('tl', 'tr', 'br', 'bl'):
            x, y = (int(round(v)) for v in p['corners'][k])
            pad = cv2.copyMakeBorder(img, half, half, half, half, cv2.BORDER_CONSTANT, value=(0, 0, 0))
            inside = 0 <= x < img.shape[1] and 0 <= y < img.shape[0]
            crop = pad[y:y + 2 * half, x:x + 2 * half] if inside else None
            if crop is None or crop.shape[:2] != (2 * half, 2 * half):  # corner outside the frame
                crop = np.zeros((2 * half, 2 * half, 3), np.uint8)
            crop = cv2.resize(crop, None, fx=zoom, fy=zoom, interpolation=cv2.INTER_NEAREST)
            c = half * zoom
            cv2.drawMarker(crop, (c, c), (0, 0, 255), cv2.MARKER_CROSS, 40, 2)
            cv2.putText(crop, f"p{p['page']} {k}", (8, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (0, 0, 255), 2)
            tiles.append(crop)
    rows = [np.hstack(tiles[i:i + 4]) for i in range(0, len(tiles), 4)]
    return np.vstack(rows)


def main():
    a = [x for x in sys.argv[1:] if not x.startswith('--')]
    clip_dir, name, out_dir = a[0], a[1], a[2]
    per = int(sys.argv[sys.argv.index('--per-hold') + 1]) if '--per-hold' in sys.argv else 1
    width = int(sys.argv[sys.argv.index('--width') + 1]) if '--width' in sys.argv else 0
    gt = json.load(open(os.path.join(clip_dir, name + '.gt.json')))
    os.makedirs(out_dir, exist_ok=True)
    want = []
    for s in gt['segments']:
        if s['phase'] != 'hold':
            continue
        a0, a1 = s['start_frame'] + 20, s['end_frame'] - 5  # skip the hand coming back
        for j in range(per):
            want.append(int(a0 + (a1 - a0) * (j + 1) / (per + 1)))
    cap = cv2.VideoCapture(os.path.join(clip_dir, name + '.mp4'))
    fi, written, first = 0, [], None
    while want:
        ok, img = cap.read()
        if not ok:
            break
        if fi in want:
            fr = gt['frames'][fi]
            assert fr['i'] == fi
            sc = width / img.shape[1] if width else 1.0
            path = os.path.join(out_dir, f'{name}-f{fi:04d}.png')
            cv2.imwrite(path, overlay(img, fr, sc))
            written.append(path)
            if first is None:
                first = (img, fr)
            want.remove(fi)
        fi += 1
    if first is not None:
        cv2.imwrite(os.path.join(out_dir, f'{name}-corners.png'), corner_crops(*first))
    print('\n'.join(written))


if __name__ == '__main__':
    main()
