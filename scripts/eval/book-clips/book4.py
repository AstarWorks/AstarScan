"""Fourth book: the untuned check after fixing the spread misreads and the
upright-spread turn (the PR after #12).

    python3 -I book4.py <clip|all> <out-dir>            # render (render.py)
    python3 -I frame.py book4 book4-framed               # 720x960 phone window

Books 1–3 were all used to fix the browser capture, so none of them is
untuned any more. Book 4 was made after the last code change of its PR
and measured once with that code; nothing was changed after looking at
it. Unlike books 1–3:

- body fonts Inter (a grotesque sans), Bitstream Charter (serif) and
  WenQuanYi Zen Hei (a Japanese gothic other than IPAGothic);
- page numbers as "Page 58" at the top by the gutter (running head moved
  to the outer side), as "– 233 –" (en dashes) at the bottom by the
  gutter, and as "124頁" at the bottom outer corner of a Japanese book;
- paper: pale grey-green, pale newsprint yellow, pure cool white;
- desks: white marble with veins, rust-red felt pad, marble again under
  a magenta light;
- light: violet-cool, dim warm with a heavy shadow, magenta;
- hands: right thumb on the top outer corner + left thumb at the bottom
  by the gutter; right thumb on the bottom outer corner; right thumb at
  the bottom middle + left thumb on the left page's fore-edge;
- frames: 1440x1920 and 1080x1440 upright (a phone's 3:4) and 1920x1440
  landscape (4:3), none of the sizes of books 1–3;
- one spread is skipped on purpose (book4-spread-inner hold 2, 62・63).
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import render as R  # noqa: E402
from render import PH  # noqa: E402

BOOK4 = {
    'book4-spread-inner': dict(
        W=1440, H=1920, mode='spread', desk='marble', text='melville-moby_dick.txt', lang='en',
        title='FIELD NOTES ON BRIDGE REPAIRS', spreads=6, first_page=58, offset=29,
        glare=0.35, shadow=0.5, shake=1.0, thick=(8.0, 10.0), left_thumb=True,
        cover=(60, 30, 90), seed=241, font='inter', folio='top-inner', folio_fmt='Page {}',
        paper=(228, 234, 224), tint=(0.97, 0.94, 1.08),
        thumb_R=(0.9, -PH + 12.0), thumb_out=(0.7, -1.0, 0.8),
        thumb_L=(-0.12, PH / 2 - 8.0), thumb_out_L=(-0.2, 1.0, 0.8)),
    'book4-single-dash': dict(
        W=1080, H=1440, mode='single', desk='rust', text='carroll-alice.txt', lang='en',
        title='REGISTER OF WITNESS STATEMENTS', spreads=10, first_page=232, offset=11,
        glare=0.2, shadow=0.9, shake=1.0, thick=(12.0, 7.0), left_thumb=False,
        cover=(40, 40, 60), seed=263, font='charter', folio='bottom-inner', folio_fmt='– {} –',
        paper=(238, 234, 206), tint=(0.88, 0.84, 0.76),
        thumb_R=(0.86, 0.0), thumb_out=(0.6, 1.0, 0.8)),
    'book4-spread-ja-43': dict(
        W=1920, H=1440, mode='spread', desk='marble', text='ja', lang='ja',
        title='現場安全管理記録', spreads=6, first_page=124, offset=5,
        glare=0.55, shadow=0.3, shake=1.2, thick=(15.0, 13.0), left_thumb=True,
        cover=(20, 70, 60), seed=281, font='wqy-zenhei', folio='bottom-outer', folio_fmt='{}頁',
        paper=(244, 246, 250), tint=(1.05, 0.92, 1.02),
        thumb_R=(0.55, 0.0), thumb_out=(0.3, 1.0, 0.8),
        thumb_L=(-0.97, 0.0), thumb_out_L=(-1.0, 0.1, 0.6)),
}

if __name__ == '__main__':
    R.CLIPS.update(BOOK4)
    names = list(BOOK4) if sys.argv[1] == 'all' else [sys.argv[1]]
    for nm in names:
        R.render(nm, sys.argv[2])
