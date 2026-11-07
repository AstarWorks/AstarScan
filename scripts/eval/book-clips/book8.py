"""Eighth book: the untuned check after the four rules found on books 1, 5,
6 and 7 (docs/book4-design.md 「8 冊目の前」: the corner model shown windows
of the picture when the whole shows no paper, a faint stroke joining the
number's line, a bar at the line's end left out, a single page's number
that jumps held back).

    BOOK_FONTS_DIR=… python3 -I book8.py <clip|all> <out-dir>     # render (render.py)
    python3 -I frame.py book8 book8-framed book8-single-plexbar book8-spread-gentium book8-spread-ja-sawarabi

The fonts come from fetch-book8-fonts.sh (Gentium Plus, IBM Plex Mono,
Sawarabi Mincho; BOOK_FONTS_DIR). Book 8 is made after the last code change
of its PR and measured once with that code; nothing is changed after
looking at it. Unlike books 1–7:

- body fonts IBM Plex Mono (a grotesque monospace), Gentium Plus (a
  calligraphic serif) and Sawarabi Mincho (a light Japanese serif);
- page numbers as "17 |" (a bar after the number, the form the dropped
  second book 7 read as 171) at the top outer corner of a single page,
  as bare digits at the bottom centre of both pages of a spread, and as
  「第88頁」 (第 … 頁 round the digits) at the bottom outer corner of a
  Japanese book;
- paper: grey-blue, warm cream, white;
- desks: pale birch wood (little contrast with the paper), a dark red
  felt pad, grey ceramic tiles with grout lines;
- light: warm with a medium glare band, dim and cool with a heavy shadow,
  bright neutral with a strong glare band;
- hands: right thumb on the bottom outer corner (over the corner); left
  thumb on the left page's top outer corner + right thumb on the bottom
  edge's middle; both thumbs on the fore-edges at mid-height;
- frames: 1680x1260 landscape (4:3) SINGLE page — the facing page in view
  on the left, the grip books 1 and 6 lost every hold of (0 / 10, 0 / 11),
  1128x1504 upright (3:4) spread (even sides: x264 takes no odd width),
  2304x1728 landscape (4:3) spread — none
  of the sizes of books 1–7;
- one spread is skipped on purpose (book8-spread-gentium hold 3, 136・137).
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import render as R  # noqa: E402
from render import PH  # noqa: E402

BOOK8 = {
    'book8-single-plexbar': dict(
        W=1680, H=1260, mode='single', desk='birch', text='melville-moby_dick.txt', lang='en',
        title='SOUNDINGS OFF THE NORTH BANK', spreads=10, first_page=16, offset=83,
        glare=0.5, shadow=0.5, shake=1.1, thick=(9.0, 12.0), left_thumb=False,
        cover=(30, 70, 120), seed=503, font='plex-mono', folio='top-outer', folio_fmt='{} |',
        paper=(228, 232, 238), tint=(1.08, 1.0, 0.88),
        thumb_R=(0.95, 0.0), thumb_out=(0.7, 1.0, 0.8)),
    'book8-spread-gentium': dict(
        W=1128, H=1504, mode='spread', desk='burgundy', text='carroll-alice.txt', lang='en',
        title='MINUTES OF THE ORCHARD COMMITTEE', spreads=7, first_page=130, offset=47,
        glare=0.2, shadow=0.85, shake=1.5, thick=(20.0, 5.0), left_thumb=True,
        cover=(60, 90, 40), seed=521, font='gentium', folio='center', folio_fmt='{}',
        paper=(244, 238, 220), tint=(0.9, 0.95, 1.05),
        thumb_R=(0.5, 0.0), thumb_out=(0.0, 1.0, 0.8),
        thumb_L=(-0.95, -PH / 2 + 4.0), thumb_out_L=(-0.7, -1.0, 0.8)),
    'book8-spread-ja-sawarabi': dict(
        W=2304, H=1728, mode='spread', desk='tile', text='ja', lang='ja',
        title='図面管理手続規程', spreads=6, first_page=88, offset=29,
        glare=1.0, shadow=0.3, shake=0.9, thick=(6.0, 14.0), left_thumb=True,
        cover=(80, 40, 30), seed=547, font='sawarabi-mincho', folio='bottom-outer', folio_fmt='第{}頁',
        paper=(248, 248, 246), tint=(1.0, 1.0, 1.0),
        thumb_R=(1.0, -PH / 2 + 2.0), thumb_out=(1.0, 0.0, 0.6),
        thumb_L=(-1.0, 0.0), thumb_out_L=(-1.0, 0.0, 0.6)),
}

if __name__ == '__main__':
    R.CLIPS.update(BOOK8)
    names = list(BOOK8) if sys.argv[1] == 'all' else [sys.argv[1]]
    for nm in names:
        R.render(nm, sys.argv[2])
