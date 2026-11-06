"""Sixth book: the untuned check after the three common-judgement fixes made
on the re-measurement of books 1–4 (docs/book4-design.md, run12b: the
order rules in two phases, two spreads never 2 apart, the shot's corner
from the outermost place read often enough) — made after book 5, which was
measured before those fixes.

    python3 -I book6.py <clip|all> <out-dir>            # render (render.py)
    python3 -I frame.py book6 book6-framed book6-spread-head book6-single-typewriter book6-spread-ja-mincho

Book 6 is made after the last code change of its PR and measured once with
that code; nothing is changed after looking at it. Unlike books 1–5:

- body fonts Loma (a humanist sans), Courier 10 Pitch (a typewriter face)
  and IPA Mincho (a Japanese serif; books 1, 4 and 5 were gothic);
- page numbers on the running head's line at the outer end ("202  TITLE",
  "TITLE  203": a number at the end of a longer line), as tight "-11-"
  (hyphens, no spaces) at the bottom outer corner, and as plain digits at
  the top outer corner over a rule under the running head, with one
  Japanese spread (92・93) printed without numbers (a figure spread);
- paper: pale lavender-grey, light grey glossy stock, ivory;
- desks: brushed stainless steel, a red-and-white checked tablecloth, a
  blue-grey loop-pile carpet;
- light: cold blue daylight with a heavy shadow, bright neutral with a
  wide glare band, orange tungsten;
- hands: left thumb on the left page's bottom outer corner + right thumb
  at the top by the gutter; right thumb from the top edge, mid-page;
  both thumbs on the bottom outer corners;
- frames: 2048x1536 landscape (4:3) spread, 1792x1344 landscape (4:3)
  single page, 1536x2048 upright (3:4) spread — none of the sizes of
  books 1–5;
- one spread is skipped on purpose (book6-spread-head hold 4, 210・211).
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import render as R  # noqa: E402
from render import PH  # noqa: E402

BOOK6 = {
    'book6-spread-head': dict(
        W=2048, H=1536, mode='spread', desk='steel', text='melville-moby_dick.txt', lang='en',
        title='LOG OF THE HARBOUR SURVEY', spreads=7, first_page=202, offset=37,
        glare=0.3, shadow=0.8, shake=1.4, thick=(18.0, 6.0), left_thumb=True,
        cover=(90, 60, 30), seed=311, font='loma', folio='head-outer',
        paper=(236, 232, 242), tint=(0.90, 0.98, 1.12),
        thumb_R=(0.15, -PH + 14.0), thumb_out=(-0.3, -1.0, 0.8),
        thumb_L=(-0.9, PH / 2 - 10.0), thumb_out_L=(-0.7, 1.0, 0.8)),
    'book6-single-typewriter': dict(
        W=1792, H=1344, mode='single', desk='plaid', text='carroll-alice.txt', lang='en',
        title='DEPOSITIONS TAKEN AT THE SITE', spreads=11, first_page=10, offset=53,
        glare=0.9, shadow=0.25, shake=1.1, thick=(4.0, 16.0), left_thumb=False,
        cover=(30, 90, 120), seed=331, font='courier', folio='bottom-outer', folio_fmt='-{}-',
        paper=(230, 231, 228), tint=(1.03, 1.03, 1.03),
        thumb_R=(0.5, -PH + 14.0), thumb_out=(0.0, -1.0, 0.8)),
    'book6-spread-ja-mincho': dict(
        W=1536, H=2048, mode='spread', desk='carpet', text='ja', lang='ja',
        title='文書保存細則', spreads=6, first_page=86, offset=41,
        glare=0.7, shadow=0.45, shake=0.9, thick=(10.0, 10.0), left_thumb=True,
        cover=(50, 40, 120), seed=353, font='ipa-mincho', folio='top-outer', folio_fmt='{}',
        rule=True, no_folio=(92, 93),
        paper=(240, 237, 228), tint=(1.14, 1.0, 0.78),
        thumb_R=(0.92, 0.0), thumb_out=(0.8, 1.0, 0.7),
        thumb_L=(-0.92, PH / 2 - 7.0), thumb_out_L=(-0.8, 1.0, 0.7)),
}

if __name__ == '__main__':
    R.CLIPS.update(BOOK6)
    names = list(BOOK6) if sys.argv[1] == 'all' else [sys.argv[1]]
    for nm in names:
        R.render(nm, sys.argv[2])
