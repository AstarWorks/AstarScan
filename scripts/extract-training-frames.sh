#!/usr/bin/env bash
#
# Extract training frames from the local handheld MP4s for the
# YOLOv8n-pose document corner fine-tune.
#
# Output: scripts/dataset/raw/{video_basename}_{frame:04d}.jpg
#
# Sampling rate: 2.5 FPS. The MP4s are ~43 s and ~66 s, so we get
# ~270 frames total — enough for a 4-keypoint fine-tune (Ultralytics
# guidance for keypoint tasks: ≥ 200 labelled samples) without burying
# the annotator in a multi-hour click marathon.
#
# Output JPEGs are 720×1280 (matches source resolution; downstream
# Roboflow / YOLOv8 will resize to 640×640 with letterbox during
# training). q:v 3 is high quality (1 = best, 31 = worst).
set -euo pipefail

cd "$(dirname "$0")/.."

OUT="scripts/dataset/raw"
mkdir -p "$OUT"

VIDEOS=(
  20260412_204840.mp4
  20260412_212448.mp4
)

missing=()
for v in "${VIDEOS[@]}"; do
  if [[ ! -f "$v" ]]; then
    missing+=("$v")
  fi
done
if (( ${#missing[@]} > 0 )); then
  echo "Missing source videos: ${missing[*]}" >&2
  echo "Place them at the repo root and rerun." >&2
  exit 1
fi

for v in "${VIDEOS[@]}"; do
  base="${v%.mp4}"
  echo "Extracting frames from $v..."
  ffmpeg -hide_banner -loglevel warning \
    -i "$v" \
    -vf "fps=2.5" \
    -q:v 3 \
    "$OUT/${base}_%04d.jpg"
done

count=$(find "$OUT" -name '*.jpg' | wc -l)
echo "Done. ${count} frames in $OUT"
