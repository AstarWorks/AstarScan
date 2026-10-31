# Local document-corner labeler

A zero-dependency, no-account labeling tool for the document-corner dataset.
Replaces the Roboflow step in `docs/training-doc-corners.md`.

## Run

```bash
bun scripts/label/server.mjs        # then open http://localhost:4321
# custom port: PORT=5000 bun scripts/label/server.mjs
```

It walks every JPEG in `scripts/dataset/raw/` (274 frames) and starts at the
first **unlabeled** frame, so you can quit and resume anytime.

## How to label (~5–8 s/frame, ~25–35 min total)

For each frame, click the 4 paper corners **in this exact order**:

1. **TL** (top-left) → 2. **TR** (top-right) → 3. **BR** (bottom-right) → 4. **BL** (bottom-left)

- **Drag** any dot to fine-tune its position.
- If a corner is hidden by a hand or just off-frame, place it where you
  _think_ it is and mark it **occluded** (keys `1`–`4`, or the checkboxes).
  The model learns to predict low visibility there and we ignore that corner
  downstream — this is the whole reason we use keypoints over a box.
- **Skip** (`s`) frames with no document, or with ≥2 corners you can't even
  guess. Better to drop a frame than mislabel it.

### Shortcuts

| Key           | Action                                 |
| ------------- | -------------------------------------- |
| `Space` / `→` | save & next                            |
| `←`           | previous                               |
| `s`           | skip frame                             |
| `r`           | reset (clear this frame)               |
| `u`           | undo last point                        |
| `n`           | jump to next unlabeled                 |
| `1`–`4`       | toggle occlusion of corner TL/TR/BR/BL |

The progress bar and `labeled / skipped / left` counter track completion.

## Output

- `scripts/dataset/labels/<frame>.txt` — one YOLOv8-pose line per frame:
  `class cx cy w h  x1 y1 v1 … x4 y4 v4` (normalized 0–1; keypoint order
  tl, tr, br, bl; `v` = 2 visible, 1 occluded).
- `scripts/dataset/annotations.json` — editable source of truth (resume / re-edit).

When done, package the Ultralytics dataset and train:

```bash
bun scripts/label/build-dataset.mjs   # → scripts/dataset/yolo/ + doc-corners-dataset.zip
```

Then follow `docs/training-doc-corners.md` (Colab) with the produced zip.
