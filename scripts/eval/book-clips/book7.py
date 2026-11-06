"""Seventh book: the untuned check after the hidden-corner rule found on
book 6 (docs/book4-design.md: one corner under a thumb is completed from
the three sure ones, 9e8e7e7).

    python3 -I book7.py <clip|all> <out-dir>            # render (render.py)
    python3 -I frame.py book7 book7-framed book7-spread-garamond book7-single-lato book7-spread-ja-noto

Book 7 is made after the last code change of its PR and measured once with
that code; nothing is changed after looking at it. Unlike books 1–6:

- body fonts EB Garamond (an old-style serif with old-style figures: the
  numerals sit below the line), Lato (a humanist sans) and Noto Serif CJK
  JP (a Japanese serif other than IPA Mincho);
- page numbers as "~ 303 ~" alone at the top centre (tildes, old-style
  figures), as "PAGE 41" at the bottom centre, and as "60　柱" / "柱　61"
  (number and running head on one line) at the bottom outer corner of a
  Japanese book;
- paper: pale green, grey-blue, light tan;
- desks: dark speckled granite, brown kraft paper with folds, light
  terrazzo with coloured chips;
- light: dim neutral with a heavy shadow, strong yellow, cool white LED
  with a wide glare band;
- hands: right thumb on the bottom-right corner (over the corner itself);
  right thumb at the top by the gutter; left thumb at the left page's top
  by the gutter + right thumb on the fore-edge middle;
- frames: 1344x1792 upright (3:4) spread, 1260x1680 upright (3:4) single
  page, 2560x1920 landscape (4:3) spread — none of the sizes of books 1–6;
- one spread is skipped on purpose (book7-spread-garamond hold 2, 306・307).
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import render as R  # noqa: E402
from render import PH  # noqa: E402

BOOK7 = {
    'book7-spread-garamond': dict(
        W=1344, H=1792, mode='spread', desk='granite', text='carroll-alice.txt', lang='en',
        title='CHRONICLE OF THE RIVER WORKS', spreads=7, first_page=302, offset=61,
        glare=0.25, shadow=0.9, shake=1.2, thick=(7.0, 15.0), left_thumb=False,
        cover=(40, 60, 40), seed=401, font='ebgaramond', folio='top-center', folio_fmt='~ {} ~',
        paper=(232, 240, 230), tint=(0.85, 0.85, 0.85),
        thumb_R=(0.95, 0.0), thumb_out=(0.8, 1.0, 0.8)),
    'book7-single-lato': dict(
        W=1260, H=1680, mode='single', desk='kraft', text='melville-moby_dick.txt', lang='en',
        title='INSPECTION NOTES, EAST PIER', spreads=10, first_page=40, offset=71,
        glare=0.5, shadow=0.35, shake=1.0, thick=(10.0, 10.0), left_thumb=False,
        cover=(120, 110, 30), seed=421, font='lato', folio='center', folio_fmt='PAGE {}',
        paper=(226, 230, 236), tint=(1.10, 1.06, 0.80),
        thumb_R=(0.08, -PH + 14.0), thumb_out=(-0.5, -1.0, 0.8)),
    'book7-spread-ja-noto': dict(
        W=2560, H=1920, mode='spread', desk='terrazzo', text='ja', lang='ja',
        title='設備点検記録規程', spreads=6, first_page=60, offset=19,
        glare=0.9, shadow=0.3, shake=1.0, thick=(12.0, 8.0), left_thumb=True,
        cover=(30, 30, 110), seed=443, font='noto-serif-cjk', folio='foot-outer', folio_fmt='{}',
        paper=(236, 226, 210), tint=(0.96, 0.98, 1.06),
        thumb_R=(1.0, -PH / 2 + 2.0), thumb_out=(1.0, 0.0, 0.6),
        thumb_L=(-0.1, -PH / 2 + 10.0), thumb_out_L=(0.3, -1.0, 0.8)),
}

if __name__ == '__main__':
    R.CLIPS.update(BOOK7)
    names = list(BOOK7) if sys.argv[1] == 'all' else [sys.argv[1]]
    for nm in names:
        R.render(nm, sys.argv[2])
