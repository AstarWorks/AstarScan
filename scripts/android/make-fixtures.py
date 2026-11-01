"""Generate photo-like page images for the Android emulator check.

Each image is a white page with original (non-copyrighted) Japanese text
and a printed page number, perspective-warped onto a dark desk. Pages
12, 13, 13 (again, other angle) and 15 → the app should flag 13 as a
duplicate and 14 as missing.

    python3 scripts/android/make-fixtures.py
"""

import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

OUT = Path(__file__).parent / "fixtures"
FONT = "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc"
LINES = [
    "証拠書類は提出の順に番号を付けて綴じる。",
    "打合せの記録は日付ごとに書類置場へ保存する。",
    "原本と写しの対照表を作り、差分を確認する。",
    "期日の前日までに依頼者へ連絡を入れる。",
    "受け取った書面は受付日を余白に記入する。",
    "写しの枚数は送付書に必ず書き添える。",
]


def coeffs(src, dst):
    """PIL PERSPECTIVE coefficients mapping dst quad → src quad."""
    import numpy as np  # noqa: PLC0415

    a = []
    b = []
    for (x, y), (u, v) in zip(dst, src):
        a.append([x, y, 1, 0, 0, 0, -u * x, -u * y])
        a.append([0, 0, 0, x, y, 1, -v * x, -v * y])
        b += [u, v]
    return np.linalg.solve(np.array(a, float), np.array(b, float)).tolist()


def page(no: int) -> Image.Image:
    w, h = 840, 1188
    img = Image.new("RGB", (w, h), (246, 244, 238))
    d = ImageDraw.Draw(img)
    title = ImageFont.truetype(FONT, 40)
    body = ImageFont.truetype(FONT, 30)
    num = ImageFont.truetype(FONT, 30)
    d.text((70, 80), f"第{no // 4 + 1}章 書類の整理", font=title, fill=(20, 20, 20))
    rnd = random.Random(no)
    y = 180
    for i in range(16):
        d.text((70, y), LINES[(i + no) % len(LINES)], font=body, fill=(30, 30, 30))
        y += 50 + rnd.randint(-2, 2)
    label = f"- {no} -"
    tw = d.textlength(label, font=num)
    d.text(((w - tw) / 2, h - 90), label, font=num, fill=(30, 30, 30))
    return img


def photo(no: int, seed: int) -> Image.Image:
    rnd = random.Random(seed)
    bw, bh = 1200, 1600
    bg = Image.new("RGB", (bw, bh), (58, 44, 34))
    d = ImageDraw.Draw(bg)
    for _ in range(140):  # wood-ish grain
        y = rnd.randint(0, bh)
        d.line([(0, y), (bw, y + rnd.randint(-40, 40))], fill=(70 + rnd.randint(-8, 8), 52, 40), width=rnd.randint(1, 4))
    p = page(no)
    pw, ph = p.size
    j = lambda: rnd.randint(-45, 45)  # noqa: E731
    dst = [(170 + j(), 160 + j()), (1030 + j(), 190 + j()), (1060 + j(), 1440 + j()), (140 + j(), 1410 + j())]
    src = [(0, 0), (pw, 0), (pw, ph), (0, ph)]
    warped = p.transform((bw, bh), Image.PERSPECTIVE, coeffs(src, dst), Image.BICUBIC)
    mask = Image.new("L", (pw, ph), 255).transform((bw, bh), Image.PERSPECTIVE, coeffs(src, dst), Image.BICUBIC)
    shadow = Image.new("L", (bw, bh), 0)
    ImageDraw.Draw(shadow).polygon([(x + 14, y + 18) for x, y in dst], fill=150)
    bg.paste((20, 15, 10), (0, 0), shadow.filter(ImageFilter.GaussianBlur(18)))
    bg.paste(warped, (0, 0), mask)
    return bg.filter(ImageFilter.GaussianBlur(0.6))


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    for i, (no, seed) in enumerate([(12, 1), (13, 2), (13, 3), (15, 4)], start=1):
        photo(no, seed).save(OUT / f"page-{i}-no{no}.jpg", quality=82)
