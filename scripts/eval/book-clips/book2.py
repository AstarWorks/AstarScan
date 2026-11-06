"""Second untuned book for the over-fitting check of PR #11 (book 2).

    python3 -I book2.py <clip|all> <out-dir>            # render (render.py)
    python3 -I frame.py book2 book2-framed               # 720x960 phone window

Same renderer as render.py, three clips of another book. Kept out of
render.CLIPS so stills.py and the CI checks of the five clips are unchanged.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import render as R  # noqa: E402
from render import PH  # noqa: E402

BOOK2 = {
    # Second untuned book (PR #11, "未調整の別の本（2 冊目）"): measured once
    # with the app as it was, nothing changed after looking at it. Unlike
    # the five clips and other-sans-top: other body fonts (Caladea /
    # Carlito / FreeSerif), the folio as "— 44 —" at the bottom centre, a
    # plain number at the bottom centre and at the top outer corner, three
    # paper tones (yellowed, bright white, grey recycled), navy cloth /
    # dark walnut / cork desks, cool / neutral / dim light, and the thumb
    # on the fore-edge or the top margin instead of the bottom margin.
    'book2-spread-dash': dict(
        W=1920, H=1080, mode='spread', desk='navy', text='carroll-alice.txt', lang='en',
        title='A HANDBOOK OF FILED RECORDS', spreads=7, first_page=44, offset=9,
        glare=0.5, shadow=0.45, shake=1.1, thick=(7.0, 8.0), left_thumb=False,
        cover=(30, 50, 110), seed=88, font='caladea', folio='dash-center',
        paper=(240, 233, 212), tint=(0.95, 1.0, 1.06),
        thumb_R=(0.97, 0.0), thumb_out=(1.0, 0.15, 0.6)),
    'book2-single-top': dict(
        W=1080, H=1920, mode='single', desk='walnut', text='melville-moby_dick.txt', lang='en',
        title='NOTES ON THE WHALE FISHERY', spreads=10, first_page=200, offset=41,
        glare=0.7, shadow=0.35, shake=1.0, thick=(10.0, 10.0), left_thumb=False,
        cover=(20, 20, 20), seed=99, font='carlito', folio='top-outer',
        paper=(251, 251, 248), tint=(1.03, 1.0, 0.96),
        thumb_R=(0.62, -PH + 12.0), thumb_out=(0.3, -1.0, 0.8)),
    'book2-spread-center-1440': dict(
        W=1440, H=1080, mode='spread', desk='cork', text='melville-moby_dick.txt', lang='en',
        title='HARBOUR SURVEY REPORTS', spreads=6, first_page=88, offset=63,
        glare=0.3, shadow=0.8, shake=0.9, thick=(16.0, 18.0), left_thumb=True,
        cover=(90, 70, 40), seed=111, font='freeserif', folio='center',
        paper=(236, 235, 228), tint=(0.92, 0.92, 0.92),
        thumb_R=(0.97, -30.0), thumb_out=(1.0, 0.3, 0.6)),
}

if __name__ == '__main__':
    R.CLIPS.update(BOOK2)
    names = list(BOOK2) if sys.argv[1] == 'all' else [sys.argv[1]]
    for nm in names:
        R.render(nm, sys.argv[2])
