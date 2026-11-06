"""Seventh book: the untuned check after the hidden-corner rule (scan-core
completeHiddenCorner: a corner under a thumb, unseen by the corner model
while the other three are sure, is completed from the three) made on book
6's spread held with the left thumb on the left page's bottom outer corner.

    python3 -I book7.py <clip|all> <out-dir>            # render (render.py)
    python3 -I frame.py book7 book7-framed book7-spread-garamond book7-single-hack book7-spread-ja-sawarabi

Book 7 is made after the last code change of its PR and measured once with
that code; nothing is changed after looking at it. Unlike books 1–6:

- body fonts EB Garamond (an old-style serif whose figures have ascenders
  and descenders: 3 4 5 7 9 drop below the line), Hack (a monospace made
  for screens) and Sawarabi Mincho (a light Japanese serif; book 6's was
  IPA Mincho);
- page numbers as "· 58 ·" (middle dots) at the bottom centre, as "17 |"
  (a vertical bar after the number) at the top outer corner, and as
  "（88）" (full-width parentheses) at the bottom outer corner of a
  Japanese book;
- paper: bright bluish white, deep cream, greyish newsprint;
- desks: green baize, pale oak with a knot, white ceramic tiles with grout
  lines (a bright desk under a bright page, grout lines crossing the
  page's edges);
- light: warm yellow with a strong glare band, cool dim with a heavy
  shadow, bright neutral;
- hands: right thumb alone on the right page's top outer corner (book 6's
  hidden corner was a left thumb at the bottom); right thumb by the gutter
  at the bottom of a single page; left thumb on the left page's top outer
  corner + right thumb by the gutter at the bottom;
- frames: 2340x1080 landscape (19.5:9, a current phone's preview) spread,
  1080x2340 upright single page, 1280x720 landscape spread (a small 16:9
  preview) — none of the sizes of books 1–6;
- one spread is skipped on purpose (book7-spread-garamond hold 3, 56・57).
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import render as R  # noqa: E402
from render import PH  # noqa: E402

BOOK7 = {
    'book7-spread-garamond': dict(
        W=2340, H=1080, mode='spread', desk='baize', text='melville-moby_dick.txt', lang='en',
        title='MINUTES OF THE EVIDENCE', spreads=7, first_page=50, offset=43,
        glare=1.0, shadow=0.4, shake=1.2, thick=(12.0, 14.0), left_thumb=False,
        cover=(20, 60, 110), seed=411, font='ebgaramond', folio='center', folio_fmt='· {} ·',
        paper=(244, 246, 250), tint=(1.08, 1.02, 0.86),
        thumb_R=(0.9, -PH + 14.0), thumb_out=(0.7, -1.0, 0.8)),
    'book7-single-hack': dict(
        W=1080, H=2340, mode='single', desk='oak', text='carroll-alice.txt', lang='en',
        title='SITE DIARY, SECOND VOLUME', spreads=11, first_page=16, offset=59,
        glare=0.3, shadow=0.85, shake=1.0, thick=(6.0, 14.0), left_thumb=False,
        cover=(90, 40, 20), seed=431, font='hack', folio='top-outer', folio_fmt='{} |',
        paper=(228, 236, 246), tint=(0.94, 0.97, 1.06),
        thumb_R=(0.08, 0.0), thumb_out=(-0.5, 1.0, 0.8)),
    'book7-spread-ja-sawarabi': dict(
        W=1280, H=720, mode='spread', desk='tiles', text='ja', lang='ja',
        title='工事記録簿の保存に関する取扱い', spreads=6, first_page=88, offset=47,
        glare=0.75, shadow=0.3, shake=0.9, thick=(10.0, 8.0), left_thumb=True,
        cover=(40, 90, 60), seed=457, font='sawarabi-mincho', folio='bottom-outer', folio_fmt='（{}）',
        paper=(222, 226, 228), tint=(1.0, 1.0, 1.0),
        thumb_R=(0.1, 0.0), thumb_out=(-0.5, 1.0, 0.8),
        thumb_L=(-0.9, -PH / 2 + 14.0), thumb_out_L=(-0.7, -1.0, 0.8)),
}

if __name__ == '__main__':
    R.CLIPS.update(BOOK7)
    names = list(BOOK7) if sys.argv[1] == 'all' else [sys.argv[1]]
    for nm in names:
        R.render(nm, sys.argv[2])
