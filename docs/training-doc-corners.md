# Training the document-corner detector

Fine-tunes a YOLOv8n-pose model on the handheld phone footage we ship with
this repo, producing `apps/web/public/models/doc-corners.onnx` (~6 MB) for
in-browser inference. The model regresses 4 corners (TL / TR / BR / BL) of
a document plus a per-corner visibility flag and a single class confidence
score.

## Why we train our own

Public document-corner detectors all underperformed on this exact handheld
style:

| Detector | MP4① detection rate | Notes |
| --- | --- | --- |
| OpenCV Otsu + minAreaRect | 97 % | No confidence; degenerates on hand occlusion |
| DocAligner LCNet (4.7 MB) | 11 % | BL corner heatmap collapses on occlusion |
| DocAligner FastViT-T8 (13 MB) | 13 % | Same failure mode |

YOLOv8-pose treats keypoints the same way MediaPipe Hands treats finger
joints — independent regression per landmark. Fine-tuning on ~270 frames
of our own footage closes the gap between "MediaPipe-class accuracy" and
what's actually possible in the browser.

## Pipeline overview

```
1.  bun scripts/dataset/extract-frames.mjs <clip.mp4>  ← sharp document
                                            frames only (drops empty desk /
                                            motion blur), thinned by scene
2.  bun scripts/label/server.mjs          ← local click labeler, ~25-35 min
3.  bun scripts/label/build-dataset.mjs   ← YOLOv8-pose zip, no Roboflow
4.  Train on a T4 (Colab CLI or notebook) ← ~60-90 min, mostly GPU time
5.  Export ONNX                           ← `yolo export` → 6 MB file
6.  Drop into apps/web/public/models/     ← single git-ignored asset
7.  Verify with Playwright MCP
```

> **Frame quality gates the model.** The raw videos are mostly dead frames
> (empty desk between pages, motion blur from fast flips). `extract-frames.mjs`
> keeps only sharp, document-bearing frames (Laplacian ≥ 40, Tenengrad ≥ 25)
> and thins near-duplicates so one static stretch can't dominate. When you film
> new clips, **flip slowly / pause ~1 s per page** — one eval video lost 73 % of
> frames to motion blur. Capture variety: different documents, desks, lighting,
> with/without hands.

---

## 1. Annotate locally (`scripts/label`, ~25–35 min)

No Roboflow account, no export plumbing. A local Bun server serves a
click-to-label UI over the 274 frames.

```bash
bun scripts/label/server.mjs        # then open http://localhost:4321
```

For each frame, click the 4 corners in order **TL → TR → BR → BL**, drag a
dot to fine-tune, and **Skip** (`s`) frames with no document or with ≥ 2
unguessable corners. Keypoint order is fixed (`tl, tr, br, bl`) — it is the
model's output-channel order. Progress is saved to
`scripts/dataset/annotations.json`, so you can quit and resume. Full key
map and details: `scripts/label/README.md`.

### Occlusion = `v=1`, never `v=0`

When a hand covers a corner or it sits just off-frame, place it where you
*think* it is and mark it **occluded** (keys `1`–`4`). The label encodes
visibility `2` (visible) or `1` (occluded-but-located) — we deliberately
**never emit `v=0`**.

Why: in Ultralytics pose loss `v=0` drops the *location* term for that
keypoint, so the model would never learn where an occluded corner is — and
hand-occluded corners are the exact case we need it to extrapolate so the
warp stays a complete quad. `v=1` keeps location loss on. If a corner is
genuinely unguessable, **skip the whole frame** rather than mark it `v=0`.

### Package the dataset

```bash
bun scripts/label/build-dataset.mjs
```

Writes an Ultralytics-ready tree to `scripts/dataset/yolo/`
(`images/{train,val}`, `labels/{train,val}`, and `data.yaml` with
`kpt_shape: [4, 3]`, `flip_idx: [1, 0, 3, 2]`, `names: {0: document}`),
deterministic 90/10 split, and zips it to
`scripts/dataset/doc-corners-dataset.zip`. Upload that zip to Colab.

---

## 2. Train in Google Colab (~90 min, mostly GPU time)

Open a new Colab notebook, **Runtime → Change runtime type → T4 GPU**,
then paste these cells.

### Cell 1 — Install Ultralytics

```python
%pip install --quiet ultralytics onnx onnxsim
import torch, ultralytics
print(torch.cuda.is_available(), torch.cuda.get_device_name(0))
print(ultralytics.__version__)
```

Expected output: `True NVIDIA T4` and a `8.3.x` Ultralytics version.

### Cell 2 — Unpack dataset & fix the data.yaml path

Upload `doc-corners-dataset.zip` (from `build-dataset.mjs`) to the Colab
session, then:

```python
import zipfile, os, shutil, yaml
ZIP = "/content/doc-corners-dataset.zip"   # adjust if different name
EXTRACT = "/content/dataset"
if os.path.exists(EXTRACT):
    shutil.rmtree(EXTRACT)
os.makedirs(EXTRACT)
with zipfile.ZipFile(ZIP) as z:
    z.extractall(EXTRACT)
ROOT = os.path.join(EXTRACT, "yolo")
# build-dataset.mjs writes `path: .`; point it at the absolute extract dir.
d = yaml.safe_load(open(f"{ROOT}/data.yaml"))
d["path"] = ROOT
yaml.safe_dump(d, open(f"{ROOT}/data.yaml", "w"))
DATA = f"{ROOT}/data.yaml"
print(DATA, "→", d)
```

### Cell 3 — Fine-tune

```python
from ultralytics import YOLO

model = YOLO("yolov8n-pose.pt")     # 6.5 MB pretrained on COCO pose
results = model.train(
    data=DATA,
    epochs=100,            # ceiling; `patience` early-stops well before this
    imgsz=640,
    batch=16,
    patience=20,           # stop when val stops improving → avoids memorizing
    project="/content/runs",
    name="doc-corners",
    optimizer="AdamW",
    lr0=0.001,
    cos_lr=True,
    # --- anti-overfit (small, low-diversity dataset) ---
    freeze=10,             # freeze the COCO-pose backbone; adapt only the head
    hsv_s=0.9, hsv_v=0.5,  # strong colour/brightness jitter → robust to desk
    hsv_h=0.05,            #   colour & lighting it never saw (the main failure)
    degrees=10, translate=0.1, scale=0.5, fliplr=0.5,  # geometric variety
    # --- keypoint loss weights ---
    kobj=2.0,
    pose=12.0,
)
```

> **Don't trust the val mAP alone.** Both eval MP4s are training sources and
> consecutive frames are near-duplicates, so in-distribution metrics flatter.
> The honest test is §4b on a **held-out video** (e.g. `20260516_*.mp4`) plus a
> fresh 30 s clip of a different document / desk / lighting. `build-dataset.mjs`
> already holds out whole dedup-groups for val, but that is still in-domain.

CPU training is impractical (~15 min/epoch on a fast desktop, far worse under
emulation); use the **T4 GPU** (Colab) or a CLI GPU (Kaggle / a cheap cloud
instance). The smoke-tested command above runs end-to-end on a T4 in ~60-90 min.

Training takes 60-90 min on T4. Watch for:
- `pose_loss` should drop below ~1.5 by epoch 30
- mAP50-95 (Pose) should reach 0.6+ for a usable model on this size dataset

If results stall at low mAP, you likely have label noise — re-check 5-10
random annotations in Roboflow.

### Cell 4 — Validate (optional)

```python
metrics = model.val(data=DATA)
print(metrics.box.map, metrics.pose.map)   # box mAP, pose mAP
```

### Cell 5 — Export ONNX

```python
from ultralytics import YOLO
best = YOLO("/content/runs/doc-corners/weights/best.pt")
best.export(
    format="onnx",
    imgsz=640,
    simplify=True,
    opset=12,
    dynamic=False,
)
import shutil
shutil.copy(
    "/content/runs/doc-corners/weights/best.onnx",
    "/content/doc-corners.onnx",
)
print("Exported.")
```

### Cell 6 — Download

```python
from google.colab import files
files.download("/content/doc-corners.onnx")
```

You'll get a ~6 MB file. Save it locally.

---

## 3. Drop into the repo

```bash
mv ~/Downloads/doc-corners.onnx apps/web/public/models/doc-corners.onnx
```

The path is `.gitignore`-d (see `.gitignore` block for `apps/web/public/models/*.onnx`).

---

## 4. Enable the ML detector and verify

The web app keeps the OpenCV path as default. To switch to the trained
model, edit `apps/web/app/services/doc-detector.ts`:

```ts
const ENABLE_ML_DETECTOR = true   // was false
```

(Eventually we'll promote this to a runtime URL flag like
`?detector=ml`, but for now it's a single source toggle.)

Then:

```bash
bun --cwd apps/web dev
```

Open `http://localhost:3005/?debug=1`, upload one of the test MP4s.
Expected: the debug overlay shows `src=yolo-pose conf=0.8x` instead of
`src=opencv conf=1.00`, and the per-cluster pick is sharper / less
hand-occluded.

If `conf` values are < 0.3 across the board, the dataset is too small
or noisy — collect more frames (re-run `extract-training-frames.sh`
with a different `fps` or feed in more videos) and re-train.

---

## 4b. Measure corner accuracy headlessly (before enabling in the app)

Compare the trained model against the OpenCV baseline on the eval MP4s
without touching the browser. The harness reports a **quad-tightness**
metric: a detector that grabs page + desk instead of hugging the page has a
high `areaFrac`.

```bash
bun scripts/eval/run.mjs ./20260412_204840.mp4 --detector yolo \
    --algorithm tile-orb --cluster-thr 27 --orb-merge 25 \
    --out eval-out/mp4-1-yolo
```

Watch the summary line, then open `eval-out/mp4-1-yolo/overlay.html`:

```
quad tightness: median areaFrac=…  over-coverage(≥0.85)=…/… (…%)
```

A good model drops both sharply versus the OpenCV baseline
(`eval-out/mp4-1-opencv`: median **0.864**, over-coverage **63 %**;
`eval-out/mp4-2-opencv`: median **0.794**, **15 %**), and the overlay shows
the quad hugging the real paper corners instead of the desk. `--detector
yolo` defaults to `apps/web/public/models/doc-corners.onnx` (override with
`--model <path>`).

## 5. Tuning notes

- **Imgsz**: 640 is the sweet spot. 320 is faster but loses corner
  precision; 1280 is more precise but doubles WASM-SIMD inference time.
- **Augmentation**: if real-world conditions (different desk colours,
  lighting) start hurting accuracy, add Roboflow's `bbox-level` colour
  jitter and re-train.
- **Confidence threshold in browser**: set at the call site
  (`yolo-pose-backend.ts`, `MIN_CONFIDENCE`). 0.25 is the YOLO default,
  raise to 0.4 if false positives dominate.
- **Re-training**: every time we collect more handheld scans, append to
  `scripts/dataset/raw/`, re-annotate just the new frames in Roboflow,
  and re-export → re-train. Roboflow keeps the existing labels.
