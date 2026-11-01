# Book clips: synthetic open-book page-turn videos with ground truth

Videos that look much more like "a phone pointed at an open book while
someone turns the pages" than the flat A4-on-a-desk clips made by
`scripts/eval/corner-check/synth.py`. They are meant to be fed to

- the Android emulator camera (the ML Kit Document Scanner app), and
- Playwright's fake camera for the browser version
  (`--use-file-for-fake-video-capture`),

so that we can measure the scanner over and over before anyone tries a
real book on a real phone.

Every clip has a ground-truth JSON with, for every frame, the four
corners (px) of every visible page, whether the book is still (hold) or a
page is being turned, and the printed page number.

## Clips

All clips: H.264 / yuv420p, 30 fps, in `clips/`. Each page stays still
for 1.5–3 s; each turn takes 0.5–1 s. Pages are 148 × 210 mm.

<!-- CLIP_TABLE -->

Common to every clip:

- open book: two page blocks with thickness, a gutter where the pages
  dip toward the spine and darken, a slight arch of each page, fanned
  page edges, a cover board, the book's shadow on the desk;
- page turns: the leaf rotates around the spine and bends (outer edge
  leads, then trails), its back side shows the next page, the page
  underneath is revealed while it turns;
- a thumb rests on the bottom margin of the right page (and of the left
  page when "left thumb" is set); the same hand holds the leaf while
  it turns and comes back around the bottom edge afterwards. The hand
  casts a soft shadow;
- a fluorescent-tube reflection (a bright band that washes out text) and
  a soft shadow of the phone/arm; global light falloff;
- hand-held camera: slow drift + small tremor in roll / pitch / yaw,
  position and distance (scale), on top of a fixed 0–4° tilt and roll;
- slight blur, sensor noise, small exposure drift, faint show-through of
  the other side of each leaf.

## Ground truth JSON (`clips/<clip>.gt.json`)

```jsonc
{
  "clip": "spread-land-wood", "W": 1920, "H": 1080, "fps": 30,
  "n_frames": 574, "duration_s": 19.133,
  "mode": "spread" | "single",       // single: camera on the right page only
  "desk": "wood" | "white", "lang": "en" | "ja",
  "pages": [2, 3, ...],               // all page numbers in the clip
  "target_pages": [2, 3, ...],        // pages the scanner should capture
  "segments": [ { "phase": "hold" | "turn", "spread": 0,
                  "start_frame": 0, "end_frame": 71 }, ... ],  // end exclusive
  "conditions": { "glare": 0.8, "shadow": 0.35, "shake": 1.0,
                  "thick": [9, 11], "left_thumb": true },
  "page_size_mm": [148, 210],
  "corner_order": ["tl", "tr", "br", "bl"],
  "frames": [ {
    "i": 0, "t": 0.0,
    "phase": "hold" | "turn",
    "spread": 0,                      // index of the spread being shown / turned from
    "turn_progress": null | 0.0–1.0,
    "pages": [ {
      "page": 2,                      // printed page number of the visible side
      "side": "left" | "right" | "turning",
      "state": "static" | "turning",
      "target": true,                 // this page should be captured in this frame
      "corners": { "tl": [x, y], "tr": [x, y], "br": [x, y], "bl": [x, y] },
      "edge_top": [[x, y] × 9],       // curved top edge, tl → tr
      "edge_bottom": [[x, y] × 9],    // curved bottom edge, bl → br
      "in_frame": 1.0,                // share of the page area inside the frame
      "hand_cover": 0.004,            // share of the page area under the hand
      "occluded": 0.3,                // turn frames only: share hidden by the turning leaf
      "leaf_pages": [3, 4]            // turning leaf only: its front and back page
    } ]
  } ]
}
```

- Coordinates are pixels in the video frame, origin top-left, rounded
  to 0.1 px. They are exact for the 3D model (same projection as the
  rendering); the drawn edge is anti-aliased and blurred by ~1 px.
- Corners are in the page's own reading orientation: `tl` is the top-left
  of the printed side you see. On a right page `tl`/`bl` are at the
  spine; on a left page `tr`/`br` are at the spine.
- The page outline is curved (gutter dip and arch), so a straight quad
  through the four corners is not the page boundary near the spine; use
  `edge_top` / `edge_bottom` when measuring an outline error.
- `target`: spread clips — both static pages in hold frames; single
  clips — the right page in hold frames. Turn frames have no target.
- For the per-page checklist (✓ / red guide / nothing shown), count per
  hold segment: each segment shows the `target` pages listed in its
  frames.

## Regenerating

Needs Python 3 with `numpy`, `opencv-python-headless`, `pillow`, plus
`ffmpeg` with libx264 and the fonts Liberation Serif and IPAGothic
(Debian/Ubuntu: `fonts-liberation`, `fonts-ipafont-gothic`).

```sh
cd scripts/eval/book-clips
python3 -I render.py all clips            # all clips (~1 s per frame per core)
python3 -I render.py spread-land-wood clips
python3 -I render.py spread-land-wood /tmp/x --only 30,75,85   # a few PNG frames
python3 -I preview.py clips spread-land-wood preview --width 960  # GT overlay check
```

Output is deterministic for a given clip config (fixed seeds), apart from
encoder differences between ffmpeg builds. Clip settings are the `CLIPS`
table at the top of `render.py`.

Blender was not available in the environment where these were made, so
the renderer is a small strip-based 3D model in OpenCV instead (see the
docstring of `render.py`). Swapping in Blender renders later only needs
the same JSON format.

### Feeding the clips to a camera

- Playwright / Chrome fake camera wants Y4M or MJPEG:
  `ffmpeg -i clips/spread-land-wood.mp4 -pix_fmt yuv420p /tmp/spread.y4m`
  then launch Chromium with `--use-fake-device-for-media-stream
--use-file-for-fake-video-capture=/tmp/spread.y4m`. Y4M is uncompressed
  (~1.8 GB for a 20 s 1080p clip), so keep it out of the repo.
- Android emulator: play the mp4 on a virtual webcam (e.g. v4l2loopback +
  `ffmpeg -re -stream_loop -1 -i clip.mp4 -f v4l2 /dev/video9`) and
  start the emulator with `-camera-back webcam0`.

## Size

The repo has no Git LFS and its largest file is the 12.7 MB ONNX model,
so the clips are committed directly and kept well under 20 MB each
(x264 `-crf 27 -maxrate 5M`). If clips need to grow (longer, higher
bitrate), move `clips/*.mp4` to Git LFS or a GitHub release asset and
keep the JSON here.

## Sources and licences

- `texts/carroll-alice.txt` — Lewis Carroll, _Alice's Adventures in
  Wonderland_ (1865), and `texts/melville-moby_dick.txt` — Herman
  Melville, _Moby Dick_ (1851): public-domain texts from Project
  Gutenberg, taken from the NLTK `gutenberg` corpus
  (`nltk_data/packages/corpora/gutenberg.zip`), excerpts only, PG
  header removed.
- `texts/ja-sample-contract.txt` — Japanese text written for this repo
  (fictional rules for digitising paper documents), MIT like the rest of
  the repo. The renderer reshuffles its sentences into many articles so
  that no two pages are the same.
- Desk, hand, cover, figures, glare and shadows are procedural (drawn by
  `render.py`); no images are downloaded. Fonts are used only to render
  text into the frames (Liberation Serif: SIL OFL; IPAGothic: IPA Font
  License); no font files are committed.

## Not yet like a real book (unverified)

These have not been compared against real footage; they are known
simplifications:

- Paper is matte with a single Lambert light; no subsurface glow,
  no real specular highlight shape on a curved page (the glare is a 2D
  band drawn on top).
- Pages are ruled surfaces: straight along the spine. Real pages also
  curl at the corners and wave along the spine; the fore-edge is never
  ragged.
- The hand is a stylised thumb + palm (shaded capsules), no fingers
  under the page, no skin texture, same pose every time. Turns are all
  right-to-left, one leaf at a time; no missed turns, no two leaves
  stuck together, no page flipped back.
- No motion blur during turns or shake, no rolling shutter, no
  autofocus hunting or auto-exposure jumps, no compression artefacts from
  a phone encoder (only our x264 pass).
- Text is computer typeset (Liberation Serif / IPAGothic, horizontal);
  no vertical Japanese, no photos, no stains, no handwriting, no
  yellowed or show-through-heavy paper.
- The desk is clean and flat; no clutter, no other papers, no
  coloured light.
