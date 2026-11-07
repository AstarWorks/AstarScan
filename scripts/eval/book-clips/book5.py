"""Fifth book: the untuned check after the common judgements fixed on book 4
(docs/book4-design.md: the label word before the number, the page word as
PP-OCR writes it, ink by the local paper, captures that touch).

    python3 -I book5.py <clip|all> <out-dir>            # render (render.py)
    python3 -I frame.py book5 book5-framed book5-spread-bracket book5-single-mono book5-spread-ja-kanji

Book 4 was used to find those causes, so it is tuned now. Book 5 was made
after the last code change of its PR and measured once with that code;
nothing was changed after looking at it. Unlike books 1–4:

- body fonts FreeSans (a Helvetica-like grotesque), JetBrains Mono (a
  wide monospace with a slashed zero) and IPA P Gothic (proportional
  Japanese gothic);
- page numbers as "[ 77 ]" at the bottom centre, as "117." at the top
  outer corner, and as a positional kanji numeral "一二〇" at the bottom
  centre of a Japanese book;
- paper: warm cream, cool bright white, aged yellow-grey;
- desks: dark brown leather with creases, grey concrete, a tatami mat;
- light: warm yellow with medium glare, dim bluish with a heavy shadow,
  bright neutral with strong glare;
- hands: left thumb at the bottom by the gutter + right thumb on the
  fore-edge middle; right thumb at the bottom middle; the default grips;
- frames: 1600x1200 and 1280x960 landscape (4:3), 1200x1600 upright
  (3:4), none of the sizes of books 1–4;
- one spread is skipped on purpose (book5-spread-bracket hold 4, 84・85).
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import render as R  # noqa: E402
from render import PH  # noqa: E402

BOOK5 = {
    'book5-spread-bracket': dict(
        W=1600, H=1200, mode='spread', desk='leather', text='carroll-alice.txt', lang='en',
        title='PROCEEDINGS OF THE HARBOUR BOARD', spreads=7, first_page=76, offset=9,
        glare=0.5, shadow=0.6, shake=1.1, thick=(10.0, 14.0), left_thumb=True,
        cover=(50, 90, 140), seed=307, font='freesans', folio='center', folio_fmt='[ {} ]',
        paper=(240, 236, 222), tint=(1.04, 1.0, 0.92),
        thumb_R=(0.97, -PH / 2 + 7.0 + 0.0), thumb_out=(1.0, 0.0, 0.8),
        thumb_L=(-0.15, PH / 2 - 8.0), thumb_out_L=(-0.2, 1.0, 0.8)),
    'book5-single-mono': dict(
        W=1200, H=1600, mode='single', desk='concrete', text='melville-moby_dick.txt', lang='en',
        title='LOG OF THE SURVEY VESSEL', spreads=10, first_page=116, offset=33,
        glare=0.3, shadow=0.8, shake=1.3, thick=(14.0, 9.0), left_thumb=False,
        cover=(90, 60, 30), seed=331, font='jetbrains-mono', folio='top-outer', folio_fmt='{}.',
        paper=(250, 250, 250), tint=(0.92, 0.96, 1.08),
        thumb_R=(0.5, 0.0), thumb_out=(0.3, 1.0, 0.8)),
    'book5-spread-ja-kanji': dict(
        W=1280, H=960, mode='spread', desk='tatami', text='ja', lang='ja',
        title='工事写真管理要領', spreads=6, first_page=118, offset=7,
        glare=0.75, shadow=0.4, shake=0.9, thick=(6.0, 8.0), left_thumb=True,
        cover=(160, 140, 60), seed=353, font='ipap-gothic', folio='center', folio_kanji=True,
        paper=(236, 232, 220), tint=(1.0, 1.02, 0.96)),
}

if __name__ == '__main__':
    R.CLIPS.update(BOOK5)
    names = list(BOOK5) if sys.argv[1] == 'all' else [sys.argv[1]]
    for nm in names:
        R.render(nm, sys.argv[2])
