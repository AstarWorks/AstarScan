#!/usr/bin/env bash
#
# Download NDLOCR-Lite Web AI ONNX models for Japanese OCR.
# Total: ~147MB (4 models). Cached in IndexedDB after first browser load.
#
# Source: ogwata/ndlocr-lite-web-ai (CC BY 4.0)
# Attribution: National Diet Library (NDLOCR-Lite), Yuta Hashimoto, Katsuhiro Ogata

set -euo pipefail

DEST="apps/web/public/models/ocr"
mkdir -p "$DEST"

REPO="https://raw.githubusercontent.com/ogwata/ndlocr-lite-web-ai/main/public/models"

echo "Downloading NDLOCR-Lite ONNX models to $DEST..."
echo ""

for model in deim-s-1024x1024.onnx parseq-ndl-30.onnx parseq-ndl-50.onnx parseq-ndl-100.onnx; do
  if [ -f "$DEST/$model" ]; then
    echo "  ✓ $model (already exists)"
  else
    echo "  ↓ $model..."
    curl -fSL "$REPO/$model" -o "$DEST/$model"
    echo "  ✓ $model ($(du -h "$DEST/$model" | cut -f1))"
  fi
done

echo ""
echo "Done. Total: $(du -sh "$DEST" | cut -f1)"
