"""Third untuned book: the over-fitting check after fixing book 2 (PR #12).

    python3 -I book3.py <clip|all> <out-dir>            # render (render.py)
    python3 -I frame.py book3 book3-framed               # 720x960 phone window

Book 2 was used to fix the browser capture (the corner model's blinks, the
number order), so it is no longer untuned. Book 3 is measured with the
fixed code, nothing changed after looking at it. Unlike books 1 and 2 (and
other-sans-top):

- body fonts DejaVu Serif / Liberation Mono / Liberation Sans;
- page numbers alone at the top centre, as "p. 133" at the bottom outer
  corner, and as "( 315 )" at the bottom by the gutter;
- paper: blue-white coated, brownish old paper, pale pink-cream;
- desks: beige linen cloth, black laminate, green cutting mat;
- light: bright (over-exposed), green-tinted fluorescent, amber;
- hands: the right thumb by the gutter at the bottom, the right thumb at
  the bottom by the gutter on single pages, the left thumb on the top
  outer corner of the left page;
- one spread is skipped on purpose (book3-spread-topnum hold 3, 166・167).
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import render as R  # noqa: E402
from render import PH  # noqa: E402

BOOK3 = {
    'book3-spread-topnum': dict(
        W=1920, H=1080, mode='spread', desk='linen', text='melville-moby_dick.txt', lang='en',
        title='LEDGER OF SHIPPING CLAIMS', spreads=7, first_page=160, offset=17,
        glare=0.4, shadow=0.3, shake=1.0, thick=(11.0, 9.0), left_thumb=False,
        cover=(110, 30, 35), seed=131, font='dejavu-serif', folio='top-center',
        paper=(238, 242, 247), tint=(1.08, 1.08, 1.08),
        thumb_R=(0.12, 0.0), thumb_out=(0.2, 1.0, 0.8)),
    'book3-single-p': dict(
        W=1080, H=1920, mode='single', desk='black', text='carroll-alice.txt', lang='en',
        title='MINUTES OF THE BOARD', spreads=10, first_page=132, offset=23,
        glare=0.5, shadow=0.5, shake=1.1, thick=(9.0, 12.0), left_thumb=False,
        cover=(25, 60, 50), seed=151, font='liberation-mono', folio='default', folio_fmt='p. {}',
        paper=(228, 216, 192), tint=(0.96, 1.05, 0.95),
        thumb_R=(0.06, 0.0), thumb_out=(-0.3, 1.0, 0.8)),
    'book3-spread-paren-port': dict(
        W=1080, H=1920, mode='spread', desk='green', text='carroll-alice.txt', lang='en',
        title='SITE INSPECTION DIARY', spreads=6, first_page=314, offset=47,
        glare=0.65, shadow=0.55, shake=0.9, thick=(5.0, 6.0), left_thumb=True,
        cover=(200, 170, 60), seed=171, font='liberation-sans', folio='bottom-inner', folio_fmt='( {} )',
        paper=(247, 238, 234), tint=(1.08, 1.0, 0.86),
        thumb_L=(-0.86, -PH / 2 + 10.0), thumb_out_L=(-0.6, -1.0, 0.8)),
}

if __name__ == '__main__':
    R.CLIPS.update(BOOK3)
    names = list(BOOK3) if sys.argv[1] == 'all' else [sys.argv[1]]
    for nm in names:
        R.render(nm, sys.argv[2])
