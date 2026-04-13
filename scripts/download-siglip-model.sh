#!/usr/bin/env bash
#
# Download SigLIP vision encoder (ONNX, int8) for visual dedup.
# Size: ~90MB. Used for post-processing dedup after video capture.
#
# Source: Xenova/siglip-base-patch16-224 on HuggingFace
# License: Apache 2.0
#
# Note: q4f16 variant fails to load in onnxruntime-web (version mismatch).
# int8 is stable across all ort versions.

set -euo pipefail

DEST="apps/web/public/models"
mkdir -p "$DEST"

MODEL_URL="https://huggingface.co/Xenova/siglip-base-patch16-224/resolve/main/onnx/vision_model_int8.onnx"
MODEL_FILE="$DEST/siglip-vision-int8.onnx"

echo "Downloading SigLIP vision encoder (int8) to $DEST..."
echo ""

if [ -f "$MODEL_FILE" ]; then
  echo "  ✓ siglip-vision-int8.onnx (already exists, $(du -h "$MODEL_FILE" | cut -f1))"
else
  echo "  ↓ siglip-vision-int8.onnx (~90MB)..."
  curl -fSL "$MODEL_URL" -o "$MODEL_FILE"
  echo "  ✓ siglip-vision-int8.onnx ($(du -h "$MODEL_FILE" | cut -f1))"
fi

echo ""
echo "Done."
