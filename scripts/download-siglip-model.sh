#!/usr/bin/env bash
#
# Download SigLIP vision encoder (ONNX, q4f16) for visual dedup.
# Size: ~55MB. Used for post-processing dedup after video capture.
#
# Source: Xenova/siglip-base-patch16-224 on HuggingFace
# License: Apache 2.0

set -euo pipefail

DEST="apps/web/public/models"
mkdir -p "$DEST"

MODEL_URL="https://huggingface.co/Xenova/siglip-base-patch16-224/resolve/main/onnx/vision_model_q4f16.onnx"
MODEL_FILE="$DEST/siglip-vision-q4f16.onnx"

echo "Downloading SigLIP vision encoder (q4f16) to $DEST..."
echo ""

if [ -f "$MODEL_FILE" ]; then
  echo "  ✓ siglip-vision-q4f16.onnx (already exists, $(du -h "$MODEL_FILE" | cut -f1))"
else
  echo "  ↓ siglip-vision-q4f16.onnx (~55MB)..."
  curl -fSL "$MODEL_URL" -o "$MODEL_FILE"
  echo "  ✓ siglip-vision-q4f16.onnx ($(du -h "$MODEL_FILE" | cut -f1))"
fi

echo ""
echo "Done."
