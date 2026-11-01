"""Synthetic 'open book, pages turned by hand' clips with per-frame ground truth.

    python3 -I render.py CLIP_NAME OUT_DIR [--frames N] [--png]
    python3 -I render.py all OUT_DIR

Writes OUT_DIR/<clip>.mp4 (H.264, 30 fps) and OUT_DIR/<clip>.gt.json.
--frames N renders only the first N frames (quick look); --png also dumps
every frame as PNG to OUT_DIR/<clip>-frames/.

How it works (no Blender needed): the book is a small 3D model in mm.
Each page is a ruled surface (straight along the spine, curved across it:
the gutter dips toward the spine, the leaf being turned bends around it).
Surfaces are cut into thin strips across the page; each strip is planar,
so it is drawn with one perspective warp of the matching texture columns.
A pinhole camera with hand-held shake looks down at the book; desk, cover,
fanned page-block edges, a hand, its shadow, a fluorescent-tube glare and
sensor noise are composited on top. Ground truth corners come from the
same projection, so they are exact (up to the 0.1 px rounding in JSON).
See README.md for the clip list and the JSON format.
"""
import json, math, os, subprocess, sys
os.environ.setdefault('OMP_NUM_THREADS', '1')  # one clip per core; avoid oversubscription
import numpy as np, cv2
cv2.setNumThreads(1)
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
FPS = 30
PX_MM = 5.0                 # page texture resolution
PW, PH = 148.0, 210.0       # page size in mm (A5-ish book page)
COVER = 3.0                 # cover board overhang (mm)
BOARD = 2.5                 # cover board thickness (mm)

FONT_SERIF = '/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf'
FONT_SERIF_B = '/usr/share/fonts/truetype/liberation/LiberationSerif-Bold.ttf'
FONT_SERIF_I = '/usr/share/fonts/truetype/liberation/LiberationSerif-Italic.ttf'
FONT_JA = '/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf'

# ---------------------------------------------------------------- clips
CLIPS = {
    # 7 spreads = 14 pages. Wood desk, fluorescent glare, normal hand shake.
    'spread-land-wood': dict(
        W=1920, H=1080, mode='spread', desk='wood', text='carroll-alice.txt', lang='en',
        title="ALICE'S ADVENTURES IN WONDERLAND", spreads=7, first_page=2, offset=0,
        glare=0.8, shadow=0.35, shake=1.0, thick=(9.0, 11.0), left_thumb=True,
        cover=(70, 45, 110), seed=11),
    # 6 spreads = 12 pages. White desk, strong side shadow, Japanese text.
    'spread-port-white': dict(
        W=1080, H=1920, mode='spread', desk='white', text='ja', lang='ja',
        title='紙資料電子化規程（評価用）', spreads=6, first_page=2, offset=0,
        glare=0.35, shadow=0.75, shake=0.8, thick=(6.0, 7.0), left_thumb=True,
        cover=(60, 60, 60), seed=22),
    # One page at a time: camera on the right page, 12 right pages.
    'single-port-wood': dict(
        W=1080, H=1920, mode='single', desk='wood', text='melville-moby_dick.txt', lang='en',
        title='MOBY DICK; OR, THE WHALE', spreads=12, first_page=2, offset=0,
        glare=0.55, shadow=0.4, shake=1.2, thick=(12.0, 10.0), left_thumb=False,
        cover=(40, 70, 40), seed=33),
    # Thick book (deep gutter), strong glare and strong shake.
    'spread-land-white-thick': dict(
        W=1920, H=1080, mode='spread', desk='white', text='melville-moby_dick.txt', lang='en',
        title='MOBY DICK; OR, THE WHALE', spreads=6, first_page=60, offset=27,
        glare=1.0, shadow=0.5, shake=1.9, thick=(22.0, 26.0), left_thumb=True,
        cover=(30, 30, 90), seed=44),
    # One page at a time in a landscape frame, white desk, Japanese text.
    'single-land-white': dict(
        W=1920, H=1080, mode='single', desk='white', text='ja', lang='ja',
        title='紙資料電子化規程（評価用）', spreads=10, first_page=30, offset=14,
        glare=0.6, shadow=0.55, shake=1.0, thick=(8.0, 8.0), left_thumb=False,
        cover=(60, 60, 60), seed=55),
}

# ---------------------------------------------------------------- text → page textures

def ja_source(seed):
    """Long Japanese text built from the hand-written sample (texts/ja-sample-contract.txt):
    articles with shuffled sentences, so that every page is different."""
    raw = open(os.path.join(HERE, 'texts', 'ja-sample-contract.txt'), encoding='utf-8').read()
    body = [l for l in raw.splitlines() if l and not l.startswith(('［', '第', '附則'))]
    sents = [s + '。' for l in body for s in l.split('。') if s.strip()]
    titles = [l.split('（')[1].rstrip('）') for l in raw.splitlines() if l.startswith('第') and '（' in l]
    kan = '〇一二三四五六七八九'

    def num(n):
        if n < 10: return kan[n]
        t, o = divmod(n, 10)
        return ('' if t == 1 else kan[t]) + '十' + (kan[o] if o else '') if n < 100 else str(n)

    r = np.random.default_rng(seed)
    paras = []
    for a in range(1, 160):
        if a % 9 == 1:
            paras.append(('h', f'第{num(a // 9 + 1)}章　{titles[(a // 9) % len(titles)]}に関する定め'))
        paras.append(('b', f'第{num(a)}条（{titles[a % len(titles)]}）'))
        k = int(r.integers(2, 6))
        paras.append(('p', ''.join(sents[int(i)] for i in r.choice(len(sents), k, replace=False))))
    return paras


def en_source(fname):
    raw = open(os.path.join(HERE, 'texts', fname), encoding='utf-8').read()
    paras = []
    for block in raw.split('\n\n'):
        s = ' '.join(block.split())
        if not s or s.startswith('['):
            continue
        if s.startswith('CHAPTER') or (s.isupper() and len(s) < 40):
            paras.append(('h', s))
        else:
            paras.append(('p', s))
    return paras


class Typesetter:
    def __init__(self, lang):
        self.lang = lang
        s = int(3.5 * PX_MM)  # ~10 pt body text
        if lang == 'ja':
            self.f = ImageFont.truetype(FONT_JA, s)
            self.fb = ImageFont.truetype(FONT_JA, s)
            self.fh = ImageFont.truetype(FONT_JA, int(s * 1.35))
        else:
            self.f = ImageFont.truetype(FONT_SERIF, s + 1)
            self.fb = ImageFont.truetype(FONT_SERIF_B, s + 1)
            self.fh = ImageFont.truetype(FONT_SERIF_B, int(s * 1.4))
        self.fs = ImageFont.truetype(FONT_JA if lang == 'ja' else FONT_SERIF_I, int(s * 0.8))
        self.lh = int(s * (1.75 if lang == 'ja' else 1.45))
        self.mt, self.mb, self.mi, self.mo = 20, 22, 19, 15  # margins (mm)
        self.tw = int((PW - self.mi - self.mo) * PX_MM)

    def wrap(self, text, font):
        toks = list(text) if self.lang == 'ja' else text.split(' ')
        sep = '' if self.lang == 'ja' else ' '
        lines, cur = [], []
        for t in toks:
            trial = sep.join(cur + [t])
            if cur and font.getlength(trial) > self.tw:
                lines.append(cur); cur = [t]
            else:
                cur.append(t)
        if cur: lines.append(cur)
        return [(l, i < len(lines) - 1) for i, l in enumerate(lines)]  # (tokens, justify)

    def layout(self, paras, n_pages_min):
        """Returns a list of pages; each page is a list of (kind, payload) line items."""
        items = []
        fig_every = 7
        for k, (kind, s) in enumerate(paras):
            if kind == 'h':
                items += [('gap', None), ('h', s), ('gap', None)]
            elif kind == 'b':
                items.append(('b', s))
            else:
                for j, (toks, just) in enumerate(self.wrap(s, self.f)):
                    items.append(('l', (toks, just, j == 0)))
            if k % fig_every == fig_every - 1:
                items.append(('fig', k))
        per = int(((PH - self.mt - self.mb) * PX_MM) // self.lh)
        pages, cur, used = [], [], 0
        for it in items:
            cost = {'fig': 9, 'h': 2}.get(it[0], 1)
            if used + cost > per:
                pages.append(cur); cur, used = [], 0
                if it[0] == 'gap': continue
            cur.append(it); used += cost
        if cur: pages.append(cur)
        return pages

    def draw(self, items, page_no, verso, title, seed):
        w, h = int(PW * PX_MM), int(PH * PX_MM)
        r = np.random.default_rng(seed)
        img = Image.new('RGB', (w, h), (246, 242, 232))
        d = ImageDraw.Draw(img)
        x0 = int((self.mo if verso else self.mi) * PX_MM)
        y = int(self.mt * PX_MM)
        ink = (32, 30, 28)
        for kind, p in items:
            if kind == 'gap':
                y += self.lh
            elif kind == 'h':
                tw = self.fh.getlength(p)
                d.text((x0 + (self.tw - tw) / 2, y), p, font=self.fh, fill=ink)
                y += self.lh * 2
            elif kind == 'b':
                d.text((x0, y), p, font=self.fb, fill=ink)
                y += self.lh
            elif kind == 'l':
                toks, just, first = p
                ind = (self.f.getlength('　') if self.lang == 'ja' else 4 * PX_MM) if first else 0
                if self.lang == 'ja':
                    s = ''.join(toks)
                    gap = (self.tw - ind - self.f.getlength(s)) / max(1, len(toks) - 1) if just else 0
                    x = x0 + ind
                    for c in toks:
                        d.text((x, y), c, font=self.f, fill=ink); x += self.f.getlength(c) + gap
                else:
                    wl = [self.f.getlength(t) for t in toks]
                    sp = self.f.getlength(' ')
                    gap = (self.tw - ind - sum(wl)) / max(1, len(toks) - 1) if just and len(toks) > 1 else sp
                    x = x0 + ind
                    for t, wt in zip(toks, wl):
                        d.text((x, y), t, font=self.f, fill=ink); x += wt + gap
                y += self.lh
            elif kind == 'fig':
                fh = self.lh * 9
                bx0, by0, bx1, by1 = x0 + 20, y + 10, x0 + self.tw - 20, y + fh - 30
                d.rectangle((bx0, by0, bx1, by1), outline=ink, width=3)
                pts = [(bx0 + (bx1 - bx0) * i / 12, by1 - (by1 - by0) * (0.15 + 0.7 * float(r.random())))
                       for i in range(13)]
                d.line(pts, fill=ink, width=3)
                for i in range(1, 4):
                    yy = by0 + (by1 - by0) * i / 4
                    d.line((bx0, yy, bx1, yy), fill=(150, 150, 150), width=1)
                cap = (f'図{page_no}　作業の流れ' if self.lang == 'ja' else f'Fig. {page_no}.')
                d.text((x0 + 20, by1 + 6), cap, font=self.fs, fill=ink)
                y += fh
        # running head and folio
        hy = int(9 * PX_MM)
        head = title if verso else (title.split('；')[0].split(';')[0])
        hw = self.fs.getlength(head)
        d.text(((w - hw) / 2, hy), head, font=self.fs, fill=(70, 66, 60))
        folio = f'— {page_no} —' if self.lang == 'ja' else str(page_no)
        fw = self.f.getlength(folio)
        fy = h - int(13 * PX_MM)
        fx = (w - fw) / 2 if self.lang == 'ja' else (x0 if verso else x0 + self.tw - fw)
        d.text((fx, fy), folio, font=self.f, fill=ink)
        a = np.asarray(img).astype(np.float32)[:, :, ::-1].copy()  # → BGR
        # paper fibres / uneven tone
        low = cv2.resize(r.normal(0, 1, (12, 9)).astype(np.float32), (w, h), interpolation=cv2.INTER_CUBIC)
        a += low[:, :, None] * 2.5 + r.normal(0, 2.0, (h, w, 1)).astype(np.float32)
        return a


def page_textures(cfg):
    lang = cfg['lang']
    ts = Typesetter(lang)
    paras = ja_source(cfg['seed']) if cfg['text'] == 'ja' else en_source(cfg['text'])
    laid = ts.layout(paras, 0)
    n = 2 * cfg['spreads'] + 2
    out = {}
    for k in range(n):
        no = cfg['first_page'] + k
        verso = (k % 2 == 0)
        items = laid[(cfg['offset'] + k) % len(laid)]
        out[no] = ts.draw(items, no, verso, cfg['title'], cfg['seed'] * 1000 + no)
    # show-through of the other side of the leaf (mirrored, faint)
    final = {}
    for no, a in out.items():
        back = no - 1 if (no - cfg['first_page']) % 2 == 0 else no + 1
        if back in out:
            ink = 246.0 - out[back][:, ::-1].mean(axis=2, keepdims=True)
            a = a - 0.05 * np.clip(ink, 0, 255)
        final[no] = np.clip(a, 0, 255).astype(np.uint8)
    return final

# ---------------------------------------------------------------- desk

def desk_texture(kind, r, mm=1400, ppm=2.0):
    n = int(mm * ppm)
    yy, xx = np.mgrid[0:n, 0:n].astype(np.float32)
    def low(sz, amp):
        return cv2.resize(r.normal(0, 1, (sz, sz)).astype(np.float32), (n, n), interpolation=cv2.INTER_CUBIC) * amp
    if kind == 'wood':
        warp = low(7, 18.0) + low(23, 3.0)
        t = (yy / ppm) * 0.9 + warp
        rings = np.sin(t * 0.55) * 0.5 + 0.5
        streak = cv2.resize(r.normal(0, 1, (n, 40)).astype(np.float32), (n, n), interpolation=cv2.INTER_LINEAR)
        base = np.array([55, 98, 150], np.float32)  # BGR medium oak
        img = base[None, None, :] * (0.78 + 0.22 * rings[..., None]) + streak[..., None] * 5 + low(15, 6)[..., None]
        plank = (yy / ppm) % 160.0
        img[plank < 1.2] *= 0.55
        # varnish: slight sheen
        img += r.normal(0, 3, (n, n, 1)).astype(np.float32)
    else:
        base = np.array([226, 229, 230], np.float32)
        img = base[None, None, :] + low(5, 4)[..., None] + r.normal(0, 2.5, (n, n, 1)).astype(np.float32)
    return np.clip(img, 0, 255).astype(np.uint8), mm, ppm

# ---------------------------------------------------------------- geometry

def rest_z(u, T):
    """Height (above the board top) of a page resting on a stack of thickness T, at
    arc position u (mm from the spine). Pinched at the spine, rising steeply, a little arched."""
    zs = 0.08 * T
    return zs + (T - zs) * (1 - np.exp(-u / 7.0)) + 2.2 * np.sin(np.pi * np.clip(u / PW, 0, 1)) * (0.4 + T / 30)


def surface_rest(us, side, T):
    x = us * side
    z = BOARD + rest_z(us, T)
    return x, z


def surface_leaf(us, t, TL, TR):
    """Leaf being turned from right (t=0) to left (t=1)."""
    e = t * t * (3 - 2 * t)
    th = math.pi * e
    bend = 0.95 * math.sin(2 * math.pi * t)  # outer edge leads, then trails
    phi = np.clip(th + bend * (us / PW) ** 1.3, 0.0, math.pi)
    du = np.diff(us, prepend=us[0])
    x = np.cumsum(np.cos(phi) * du)
    z = np.cumsum(np.sin(phi) * du)
    zr = rest_z(us, TR) + 0.15
    zl = rest_z(us, TL) + 0.15
    return x, BOARD + z + (1 - e) * zr + e * zl

# ---------------------------------------------------------------- camera

def rot(ax, a):
    c, s = math.cos(a), math.sin(a)
    if ax == 'x': return np.array([[1, 0, 0], [0, c, -s], [0, s, c]])
    if ax == 'y': return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])


class Shake:
    def __init__(self, r, amp):
        self.p = r.uniform(0, 2 * math.pi, (6, 4))
        self.fq = np.array([0.23, 0.51, 1.1, 7.3])
        self.w = np.array([1.0, 0.6, 0.3, 0.04])
        self.amp = amp

    def __call__(self, t):
        v = (np.sin(2 * math.pi * self.fq[None, :] * t + self.p) * self.w[None, :]).sum(1) / self.w.sum()
        a = self.amp
        return dict(roll=math.radians(1.3 * a) * v[0], pitch=math.radians(1.0 * a) * v[1],
                    yaw=math.radians(1.0 * a) * v[2], dx=3.0 * a * v[3], dy=3.0 * a * v[4],
                    dist=0.025 * a * v[5])


class Camera:
    def __init__(self, W, H, f, target, dist, base_tilt, base_roll, sh):
        self.W, self.H, self.f = W, H, f
        R0 = np.diag([1.0, 1.0, -1.0])  # world (x right, y toward page bottom, z up) → cam
        Rb = rot('z', base_roll) @ rot('x', base_tilt[0]) @ rot('y', base_tilt[1])
        Rs = rot('z', sh['roll']) @ rot('x', sh['pitch']) @ rot('y', sh['yaw'])
        self.R = Rs @ Rb @ R0
        fw = (Rb @ R0).T @ np.array([0, 0, 1.0])  # unshaken viewing direction in world
        self.C = np.asarray(target, float) - fw * dist * (1 + sh['dist']) + np.array([sh['dx'], sh['dy'], 0])

    def project(self, P):
        P = np.asarray(P, float).reshape(-1, 3)
        pc = (P - self.C) @ self.R.T
        z = pc[:, 2]
        return np.stack([self.f * pc[:, 0] / z + self.W / 2, self.f * pc[:, 1] / z + self.H / 2], 1)

# ---------------------------------------------------------------- drawing helpers

LIGHT = np.array([-0.35, -0.45, 1.0]); LIGHT /= np.linalg.norm(LIGHT)


def shade_profile(x, z, C, ao_side):
    dx = np.gradient(x); dz = np.gradient(z)
    n = np.stack([-dz, np.zeros_like(dx), dx], 1)
    n /= np.linalg.norm(n, axis=1, keepdims=True) + 1e-9
    P = np.stack([x, np.zeros_like(x), z], 1)
    flip = ((C[None, :] - P) * n).sum(1) < 0
    n[flip] *= -1
    lam = np.clip(n @ LIGHT, 0, 1)
    flat = LIGHT[2]
    s = (0.45 + 0.55 * lam) / (0.45 + 0.55 * flat)
    if ao_side is not None:
        s *= 1 - 0.5 * np.exp(-np.abs(x) / 7.0)
    return np.clip(s, 0.5, 1.15)


def draw_surface(frame, mask, cam, x, z, tex_front, tex_back, col_front, col_back, shade):
    """Draw the strips of a ruled surface; columns map u → texture column for each face."""
    Ht = tex_front.shape[0]
    y0, y1 = -PH / 2, PH / 2
    P = np.concatenate([np.stack([x, np.full_like(x, y0), z], 1), np.stack([x, np.full_like(x, y1), z], 1)])
    q = cam.project(P)
    n = len(x)
    top, bot = q[:n], q[n:]
    H, W = frame.shape[:2]
    for i in range(n - 1):
        quad = np.float32([top[i], top[i + 1], bot[i + 1], bot[i]])
        e1, e2 = quad[1] - quad[0], quad[3] - quad[0]
        cross = e1[0] * e2[1] - e1[1] * e2[0]
        if abs(cross) < 2.0:
            continue
        x0 = max(0, int(math.floor(quad[:, 0].min())) - 2); x1 = min(W, int(math.ceil(quad[:, 0].max())) + 3)
        yA = max(0, int(math.floor(quad[:, 1].min())) - 2); yB = min(H, int(math.ceil(quad[:, 1].max())) + 3)
        if x1 <= x0 or yB <= yA:
            continue
        # front face: the projected strip keeps the winding it has when the page lies flat.
        face_front = cross > 0 if col_front['sign'] > 0 else cross < 0
        if face_front or tex_back is None:
            tex, cmap = tex_front, col_front['f']
        else:
            tex, cmap = tex_back, col_back['f']
        c0, c1 = cmap(i), cmap(i + 1)
        lo = max(0, int(math.floor(min(c0, c1))) - 2); hi = min(tex.shape[1], int(math.ceil(max(c0, c1))) + 3)
        sub = tex[:, lo:hi].astype(np.float32)
        cols = np.arange(lo, hi, dtype=np.float32)
        ramp = np.interp(cols, [min(c0, c1), max(c0, c1)],
                         [shade[i], shade[i + 1]] if c0 <= c1 else [shade[i + 1], shade[i]])
        sub = np.clip(sub * ramp[None, :, None], 0, 255).astype(np.uint8)
        src = np.float32([[c0 - lo, 0], [c1 - lo, 0], [c1 - lo, Ht], [c0 - lo, Ht]])
        M = cv2.getPerspectiveTransform(src, quad - np.float32([x0, yA]))
        roi = frame[yA:yB, x0:x1].copy()
        cv2.warpPerspective(sub, M, (x1 - x0, yB - yA), dst=roi, flags=cv2.INTER_LINEAR,
                            borderMode=cv2.BORDER_TRANSPARENT)
        frame[yA:yB, x0:x1] = roi
        cv2.fillPoly(mask, [np.round(quad * 4).astype(np.int32)], 255, lineType=cv2.LINE_8, shift=2)
    return top, bot


def poly_fill(img, pts, color):
    cv2.fillPoly(img, [np.round(np.asarray(pts) * 4).astype(np.int32)], color, lineType=cv2.LINE_AA, shift=2)

# ---------------------------------------------------------------- hand

SKIN = np.array([120, 150, 200], np.float32)  # BGR


def capsule_2d(layer, alpha, p0, p1, r0, r1, base):
    """Shaded capsule (finger / palm) from p0 (tip) to p1, radius r0 at the tip, r1 at p1."""
    p0, p1 = np.asarray(p0, float), np.asarray(p1, float)
    d = p1 - p0; L = np.linalg.norm(d) + 1e-6; d /= L; nrm = np.array([-d[1], d[0]])
    steps = 7
    for k in range(steps):  # dark rim → light core
        f = 1 - k / steps
        col = base * (0.62 + 0.45 * (k / steps))
        a0, a1 = r0 * f, r1 * f
        poly = [p0 + nrm * a0, p1 + nrm * a1, p1 - nrm * a1, p0 - nrm * a0]
        poly_fill(layer, poly, tuple(float(c) for c in col))
        cv2.circle(layer, tuple(np.round(p0 * 4).astype(int)), int(a0 * 4), tuple(float(c) for c in col), -1, cv2.LINE_AA, 2)
        if k == 0:
            poly_fill(alpha, poly, 255)
            cv2.circle(alpha, tuple(np.round(p0 * 4).astype(int)), int(a0 * 4), 255, -1, cv2.LINE_AA, 2)
            cv2.circle(alpha, tuple(np.round(p1 * 4).astype(int)), int(a1 * 4), 255, -1, cv2.LINE_AA, 2)
            cv2.circle(layer, tuple(np.round(p1 * 4).astype(int)), int(a1 * 4), tuple(float(c) for c in col), -1, cv2.LINE_AA, 2)


def draw_hand(cam, tip3, out_dir3, Hh, Ww, nail=True):
    """A thumb whose tip rests at tip3 (world mm) plus the palm further along out_dir3."""
    layer = np.zeros((Hh, Ww, 3), np.float32); alpha = np.zeros((Hh, Ww), np.uint8)
    o = np.asarray(out_dir3, float); o /= np.linalg.norm(o)
    tip = np.asarray(tip3, float)
    knuckle = tip + o * 42
    o = o * np.array([1, 1, 0.35]); o /= np.linalg.norm(o)
    palm0 = tip + o * 70 + np.array([0, 0, 8]); palm1 = tip + o * 140 + np.array([0, 0, 12])
    q = cam.project(np.stack([tip, knuckle, palm0, palm1, tip + np.array([9.0, 0, 0])]))
    pxmm = np.linalg.norm(q[4] - q[0]) / 9.0
    capsule_2d(layer, alpha, q[2], q[3], 32 * pxmm, 40 * pxmm, SKIN * 0.95)
    capsule_2d(layer, alpha, q[0], q[1], 8.5 * pxmm, 10.5 * pxmm, SKIN)
    if nail:
        d = q[1] - q[0]; d /= np.linalg.norm(d) + 1e-6
        c = q[0] + d * 6 * pxmm
        ang = math.degrees(math.atan2(d[1], d[0]))
        cv2.ellipse(layer, (tuple(np.round(c * 4).astype(int))), (int(6 * pxmm * 4), int(4.5 * pxmm * 4)), ang, 0, 360,
                    (175, 185, 225), -1, cv2.LINE_AA, 2)
    return layer, alpha

# ---------------------------------------------------------------- timeline

def timeline(cfg, r):
    segs, t = [], 0.0
    for k in range(cfg['spreads']):
        d = float(r.uniform(1.5, 3.0))
        segs.append(('hold', k, t, t + d)); t += d
        if k < cfg['spreads'] - 1:
            d = float(r.uniform(0.5, 1.0))
            segs.append(('turn', k, t, t + d)); t += d
    return segs, t

# ---------------------------------------------------------------- render


def render(name, out_dir, max_frames=None, dump_png=False, only=None):
    cfg = CLIPS[name]
    W, H = cfg['W'], cfg['H']
    r = np.random.default_rng(cfg['seed'])
    tex = page_textures(cfg)
    desk, desk_mm, desk_ppm = desk_texture(cfg['desk'], r)
    segs, total = timeline(cfg, r)
    n_frames = int(round(total * FPS))
    if max_frames: n_frames = min(n_frames, max_frames)
    TL, TR = cfg['thick']
    f = 0.80 * max(W, H)
    if cfg['mode'] == 'spread':
        fit = min(W * 0.84 / (2 * PW + 2 * COVER), H * 0.84 / (PH + 2 * COVER))
        target = np.array([0.0, 0.0, BOARD + max(TL, TR)])
    else:
        fit = min(W * 0.90 / PW, H * 0.86 / PH)
        target = np.array([PW / 2 + 3.0, 0.0, BOARD + TR])
    dist = f / fit
    base_tilt = (math.radians(float(r.uniform(-3, 3))), math.radians(float(r.uniform(-3, 3))))
    base_roll = math.radians(float(r.uniform(-4, 4)))
    shake = Shake(r, cfg['shake'])
    glare_c = np.array([r.uniform(0.35, 0.65) * W, r.uniform(0.25, 0.45) * H])
    glare_ang = float(r.uniform(-25, 25))
    shadow_c = np.array([r.choice([-0.1, 1.1]) * W, r.uniform(0.3, 0.9) * H])
    us_static = np.linspace(0, PW, 37)
    us_leaf = np.linspace(0, PW, 61)
    Ht = int(PH * PX_MM)
    colR = {'sign': 1, 'f': lambda i, us=us_static: us[i] * PX_MM}
    colL = {'sign': -1, 'f': lambda i, us=us_static: (PW - us[i]) * PX_MM}
    leafF = {'sign': 1, 'f': lambda i, us=us_leaf: us[i] * PX_MM}
    leafB = {'sign': -1, 'f': lambda i, us=us_leaf: (PW - us[i]) * PX_MM}
    fp = cfg['first_page']
    YY, XX = np.mgrid[0:H, 0:W].astype(np.float32)

    os.makedirs(out_dir, exist_ok=True)
    mp4 = os.path.join(out_dir, name + '.mp4')
    enc = subprocess.Popen(['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-s', f'{W}x{H}',
                            '-r', str(FPS), '-i', '-', '-c:v', 'libx264', '-preset', 'slow', '-crf', '27',
                            '-maxrate', '5M', '-bufsize', '10M', '-g', '60', '-pix_fmt', 'yuv420p',
                            '-movflags', '+faststart', mp4], stdin=subprocess.PIPE)
    if dump_png: os.makedirs(os.path.join(out_dir, name + '-frames'), exist_ok=True)
    gt_frames = []
    hold_tip_R = np.array([0.80 * PW, PH / 2 - 7.0])
    hold_tip_L = np.array([-0.72 * PW, PH / 2 - 6.0])
    for fi in range(n_frames):
        if only is not None and fi not in only:
            continue
        t = fi / FPS
        seg = next(s for s in segs if s[2] <= t < s[3]) if t < segs[-1][3] else segs[-1]
        kind, k, ts, te = seg
        sh = shake(t)
        cam = Camera(W, H, f, target, dist, base_tilt, base_roll, sh)
        # ---- desk + book shadow
        Hd = cv2.getPerspectiveTransform(
            np.float32([[0, 0], [desk.shape[1], 0], [desk.shape[1], desk.shape[0]], [0, desk.shape[0]]]),
            np.float32(cam.project([[-desk_mm / 2, -desk_mm / 2, 0], [desk_mm / 2, -desk_mm / 2, 0],
                                    [desk_mm / 2, desk_mm / 2, 0], [-desk_mm / 2, desk_mm / 2, 0]])))
        frame = cv2.warpPerspective(desk, Hd, (W, H), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)
        bx, by = PW + COVER, PH / 2 + COVER
        foot = np.array([[-bx, -by, 0], [bx, -by, 0], [bx, by, 0], [-bx, by, 0]], float)
        sm = np.zeros((H, W), np.uint8)
        poly_fill(sm, cam.project(foot + np.array([6.0, 8.0, 0])), 255)
        sm = cv2.GaussianBlur(sm, (0, 0), 0.012 * max(W, H)).astype(np.float32) / 255
        frame = (frame * (1 - 0.45 * sm[..., None])).astype(np.uint8)
        # ---- cover boards
        cov = np.array(cfg['cover'], float)
        poly_fill(frame, cam.project(foot), tuple(cov * 0.6))
        poly_fill(frame, cam.project(foot + np.array([0, 0, BOARD])), tuple(cov))
        paper = np.zeros((H, W), np.uint8)
        # ---- page blocks: fanned fore-edge / head / tail bands
        for side, T in ((1, TR), (-1, TL)):
            zt = BOARD + rest_z(PW, T)
            us = np.linspace(0, PW, 25)
            zz = BOARD + rest_z(us, T)
            edge_col = np.array([200, 212, 222], float)
            for yy, sgn in ((-PH / 2, -1), (PH / 2, 1)):
                pts = [(side * u, yy, z) for u, z in zip(us, zz)] + \
                      [(side * u, yy + sgn * 1.2, BOARD) for u in us[::-1]]
                poly_fill(frame, cam.project(pts), tuple(edge_col * 0.85))
            fan = 2.5
            band = [(side * PW, -PH / 2, zt), (side * PW, PH / 2, zt),
                    (side * (PW + fan), PH / 2 + 1.2, BOARD), (side * (PW + fan), -PH / 2 - 1.2, BOARD)]
            qb = cam.project(band)
            poly_fill(frame, qb, tuple(edge_col))
            poly_fill(paper, qb, 255)
            for j in range(1, 9):
                a = j / 9
                l0 = cam.project([(side * (PW + fan * a), -PH / 2 - 1.2 * a, zt + (BOARD - zt) * a)])[0]
                l1 = cam.project([(side * (PW + fan * a), PH / 2 + 1.2 * a, zt + (BOARD - zt) * a)])[0]
                cv2.line(frame, tuple(np.round(l0 * 4).astype(int)), tuple(np.round(l1 * 4).astype(int)),
                         tuple(edge_col * (0.78 if j % 2 else 0.9)), 1, cv2.LINE_AA, 2)
        # ---- pages
        nL, nR = fp + 2 * k, fp + 2 * k + 1
        if kind == 'turn':
            right_no, left_no = nR + 2, nL
        else:
            right_no, left_no = nR, nL
        pages_gt = []
        Cw = cam.C
        for side, no, T, colm in ((-1, left_no, TL, colL), (1, right_no, TR, colR)):
            x, z = surface_rest(us_static, side, T)
            sh_ = shade_profile(x, z, Cw, True)
            top, bot = draw_surface(frame, paper, cam, x, z, tex[no], None, colm, None, sh_)
            pages_gt.append(page_gt(no, 'left' if side < 0 else 'right', 'static', top, bot, side))
        leaf_info = None
        if kind == 'turn':
            tt = (t - ts) / (te - ts)
            x, z = surface_leaf(us_leaf, tt, TL, TR)
            sh_ = shade_profile(x, z, Cw, True)
            top, bot = draw_surface(frame, paper, cam, x, z, tex[nR], tex[nR + 1], leafF, leafB, sh_)
            # which face does the camera see (majority of strips)?
            cr = [cross2(top[i], top[i + 1], bot[i]) for i in range(len(top) - 1)]
            front = sum(1 for c in cr if c > 0) >= sum(1 for c in cr if c < 0)
            leaf_info = (x, z, tt)
            pages_gt.append(page_gt(nR if front else nR + 1, 'turning', 'turning', top, bot, 1 if front else -1,
                                    leaf=[nR, nR + 1]))
        # ---- hands
        hands = []
        if kind == 'turn':
            x, z, tt = leaf_info
            j = int(np.argmin(np.abs(us_leaf - 0.80 * PW)))
            tip = np.array([x[j], hold_tip_R[1], z[j] + 3.0])
            outd = np.array([1.0 if x[j] >= 0 else -1.0, 0.9, 0.4])
            hands.append((tip, outd))
        else:
            # after a turn the hand comes back from the left page round the bottom edge
            back = 0.55
            zr = BOARD + float(rest_z(np.array([0.80 * PW]), TR)[0]) + 3.0
            if k > 0 and t - ts < back:
                a = (t - ts) / back
                a = a * a * (3 - 2 * a)
                xx = -0.80 * PW + 1.6 * PW * a
                yy = hold_tip_R[1] + 45 * math.sin(math.pi * a)
                tip = np.array([xx, yy, zr + 25 * math.sin(math.pi * a)])
            else:
                tip = np.array([hold_tip_R[0], hold_tip_R[1], zr])
            hands.append((tip, np.array([0.45, 1.0, 0.8])))
        if cfg['left_thumb']:
            zl = BOARD + float(rest_z(np.array([0.72 * PW]), TL)[0]) + 3.0
            hands.append((np.array([hold_tip_L[0], hold_tip_L[1], zl]), np.array([-0.4, 1.0, 0.8])))
        hand_alpha = np.zeros((H, W), np.float32)
        layers = []
        for tip, outd in hands:
            layer, al = draw_hand(cam, tip, outd, H, W)
            layers.append((layer, al))
            hand_alpha = np.maximum(hand_alpha, al.astype(np.float32) / 255)
        fr = frame.astype(np.float32)
        if layers:
            off = np.float32([[1, 0, 0.012 * W], [0, 1, 0.02 * H]])
            shd = cv2.GaussianBlur(cv2.warpAffine(hand_alpha, off, (W, H)), (0, 0), 0.008 * max(W, H))
            fr *= (1 - 0.5 * shd)[..., None]
            for layer, al in layers:
                a = cv2.GaussianBlur(al.astype(np.float32) / 255, (0, 0), 1.0)[..., None]
                fr = fr * (1 - a) + layer * a
        # ---- light: gradient + soft shadow of the phone/arm + fluorescent glare
        yy, xx = YY, XX
        grad = 1 - 0.18 * cfg['shadow'] * ((xx / W) * 0.6 + (yy / H) * 0.4)
        sc = shadow_c + np.array([sh['dx'], sh['dy']]) * fit
        sb = np.exp(-(((xx - sc[0]) / (0.33 * W)) ** 2 + ((yy - sc[1]) / (0.28 * H)) ** 2))
        light = grad * (1 - 0.55 * cfg['shadow'] * sb)
        fr *= light[..., None]
        gc = glare_c - np.array([sh['dx'], sh['dy']]) * fit * 2  # reflection moves against the camera
        ca, sa = math.cos(math.radians(glare_ang)), math.sin(math.radians(glare_ang))
        gx, gy = (xx - gc[0]) * ca + (yy - gc[1]) * sa, -(xx - gc[0]) * sa + (yy - gc[1]) * ca
        g = np.exp(-(gx / (0.30 * W)) ** 4 - (gy / (0.028 * max(W, H))) ** 2) * cfg['glare']
        g += 0.25 * cfg['glare'] * np.exp(-(gx / (0.5 * W)) ** 2 - (gy / (0.12 * max(W, H))) ** 2)
        pm = cv2.GaussianBlur(paper, (0, 0), 1.2).astype(np.float32) / 255 * (1 - hand_alpha)
        gloss = pm + (0.35 if cfg['desk'] == 'white' else 0.55) * (1 - pm)
        fr += (255 - fr) * np.clip(g * gloss, 0, 0.97)[..., None]
        # ---- sensor: exposure drift, blur, noise
        fr *= 1 + 0.02 * math.sin(2 * math.pi * 0.17 * t)
        fr = cv2.GaussianBlur(fr, (0, 0), 0.9)
        fr += r.normal(0, 2.2, (H, W, 1)).astype(np.float32)
        out = np.clip(fr, 0, 255).astype(np.uint8)
        enc.stdin.write(out.tobytes())
        if dump_png:
            cv2.imwrite(os.path.join(out_dir, name + '-frames', f'{fi:04d}.png'), out)
        # ---- ground truth
        for p in pages_gt:
            p['in_frame'] = round(inside_fraction(p['_poly'], W, H), 3)
        if kind == 'turn':
            leafp = pages_gt[-1]['_poly']
            for p in pages_gt[:-1]:
                p['occluded'] = round(overlap_fraction(p['_poly'], leafp, W, H), 3)
        hand_cover = {}
        for p in pages_gt:
            m = np.zeros((H // 4, W // 4), np.uint8)
            cv2.fillPoly(m, [np.round(p['_poly'] / 4).astype(np.int32)], 1)
            area = m.sum()
            ha = cv2.resize(hand_alpha, (W // 4, H // 4)) > 0.5
            p['hand_cover'] = round(float((ha & (m > 0)).sum()) / max(1, area), 4)
            del p['_poly']
            if cfg['mode'] == 'single':
                p['target'] = (p['side'] == 'right' and kind == 'hold')
            else:
                p['target'] = (p['side'] != 'turning' and kind == 'hold')
        gt_frames.append({'i': fi, 't': round(t, 4), 'phase': 'hold' if kind == 'hold' else 'turn',
                          'spread': k, 'pages': pages_gt,
                          'turn_progress': round((t - ts) / (te - ts), 3) if kind == 'turn' else None})
        if fi % 60 == 0:
            print(name, fi, '/', n_frames, flush=True)
    enc.stdin.close(); enc.wait()
    meta = {
        'clip': name, 'W': W, 'H': H, 'fps': FPS, 'n_frames': n_frames, 'duration_s': round(n_frames / FPS, 3),
        'mode': cfg['mode'], 'desk': cfg['desk'], 'lang': cfg['lang'],
        'pages': list(range(fp, fp + 2 * cfg['spreads'])),
        'target_pages': [fp + 2 * s + 1 for s in range(cfg['spreads'])] if cfg['mode'] == 'single'
        else list(range(fp, fp + 2 * cfg['spreads'])),
        'segments': [{'phase': s[0], 'spread': s[1], 'start_frame': int(round(s[2] * FPS)),
                      'end_frame': int(round(s[3] * FPS))} for s in segs],
        'conditions': {k2: cfg[k2] for k2 in ('glare', 'shadow', 'shake', 'thick', 'left_thumb')},
        'page_size_mm': [PW, PH], 'corner_order': ['tl', 'tr', 'br', 'bl'],
        'frames': gt_frames,
    }
    with open(os.path.join(out_dir, name + '.gt.json'), 'w') as fh:
        json.dump(meta, fh, separators=(',', ':'))
    print(name, 'done', n_frames, 'frames', os.path.getsize(mp4) // 1024, 'KiB')


def cross2(a, b, c):
    e1, e2 = b - a, c - a
    return float(e1[0] * e2[1] - e1[1] * e2[0])


def rnd(p):
    return [round(float(p[0]), 1), round(float(p[1]), 1)]


def page_gt(no, side, state, top, bot, facing, leaf=None):
    """Corners in the page's own reading orientation. Index 0 of top/bot is at the spine."""
    n = len(top)
    if facing > 0:   # spine on the page's left (a recto as seen from its printed side)
        tl, tr, br, bl = top[0], top[-1], bot[-1], bot[0]
        et, eb = top, bot
    else:            # spine on the page's right (a verso)
        tl, tr, br, bl = top[-1], top[0], bot[0], bot[-1]
        et, eb = top[::-1], bot[::-1]
    idx = np.linspace(0, n - 1, 9).round().astype(int)
    d = {'page': int(no), 'side': side, 'state': state,
         'corners': {'tl': rnd(tl), 'tr': rnd(tr), 'br': rnd(br), 'bl': rnd(bl)},
         'edge_top': [rnd(et[i]) for i in idx], 'edge_bottom': [rnd(eb[i]) for i in idx],
         '_poly': np.concatenate([top, bot[::-1]])}
    if leaf: d['leaf_pages'] = leaf
    return d


def inside_fraction(poly, W, H):
    pad = max(W, H)
    s = 8
    m = np.zeros(((H + 2 * pad) // s, (W + 2 * pad) // s), np.uint8)
    cv2.fillPoly(m, [np.round((poly + pad) / s).astype(np.int32)], 1)
    tot = m.sum()
    ins = m[pad // s:(pad + H) // s, pad // s:(pad + W) // s].sum()
    return float(ins) / max(1, tot)


def overlap_fraction(a, b, W, H):
    s = 4
    ma = np.zeros((H // s, W // s), np.uint8); mb = ma.copy()
    cv2.fillPoly(ma, [np.round(a / s).astype(np.int32)], 1)
    cv2.fillPoly(mb, [np.round(b / s).astype(np.int32)], 1)
    return float((ma & mb).sum()) / max(1, ma.sum())


if __name__ == '__main__':
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    nf = None
    if '--frames' in sys.argv:
        nf = int(sys.argv[sys.argv.index('--frames') + 1]); args = [a for a in args if a != str(nf)]
    only = None
    if '--only' in sys.argv:  # preview a few frame indices (PNG only, the mp4 is incomplete)
        v = sys.argv[sys.argv.index('--only') + 1]; args = [a for a in args if a != v]
        only = set(int(x) for x in v.split(','))
    names = list(CLIPS) if args[0] == 'all' else [args[0]]
    for nm in names:
        render(nm, args[1], nf, '--png' in sys.argv or only is not None, only)
