#!/usr/bin/env bash
#
# Provision the git-ignored runtime assets under apps/web/public/ that the
# scanner fetches at runtime. Run after `bun install`, before `bun run build`.
# Used by CI (deploy + preview jobs) and scripts/cf-pages-build.sh, so the
# list lives in one place.
#
#   /opencv.js   scripts/download-opencv.sh (node_modules @techstark/opencv-js,
#                CDN fallback). Without it "カメラで撮影" fails with
#                "OpenCV.js の読み込みに失敗しました".
#   /ort/*       scripts/copy-ort-assets.mjs (onnxruntime-web WASM runtime
#                from node_modules). apps/web's `prebuild` also runs it; it
#                is run here too so the files exist even if the prebuild
#                hook is skipped.
#
# Not fetched by default:
#   /models/ocr/*.onnx  NDLOCR models (scripts/download-ocr-models.sh). Single
#                files are ~40MB, over the 25 MiB per-file limit of Cloudflare
#                Workers static assets, so `wrangler deploy/versions upload`
#                would reject the whole upload. Set FETCH_OCR_MODELS=1 to
#                fetch them anyway (local dev, other hosts).
#   /models/siglip-*.onnx  No runtime code references it any more
#                (scripts/download-siglip-model.sh is kept for local use).
#   /models/doc-corners.onnx  Self-trained, not distributed. When it is
#                missing, doc-detector.ts marks the YOLO backend unavailable
#                and detects with OpenCV.
set -euo pipefail

cd "$(dirname "$0")/.."

bash scripts/download-opencv.sh
bun scripts/copy-ort-assets.mjs

if [ "${FETCH_OCR_MODELS:-0}" = 1 ]; then
  bash scripts/download-ocr-models.sh
fi

missing=0
for f in \
  apps/web/public/opencv.js \
  apps/web/public/ort/ort-wasm-simd-threaded.jsep.mjs \
  apps/web/public/ort/ort-wasm-simd-threaded.jsep.wasm \
  apps/web/public/ort/ort-wasm-simd-threaded.mjs \
  apps/web/public/ort/ort-wasm-simd-threaded.wasm; do
  if [ ! -s "$f" ]; then
    echo "✗ missing: $f" >&2
    missing=1
  fi
done
exit "$missing"
