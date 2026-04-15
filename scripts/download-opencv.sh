#!/usr/bin/env bash
#
# Download OpenCV.js for local serving (avoids CORS issues with CDN).
# Size: ~7.6MB.
set -euo pipefail

DEST="apps/web/public"
MODEL_FILE="$DEST/opencv.js"

if [ -f "$MODEL_FILE" ]; then
  echo "✓ opencv.js (already exists, $(du -h "$MODEL_FILE" | cut -f1))"
else
  echo "↓ opencv.js (~7.6MB)..."
  curl -fSL "https://cdn.jsdelivr.net/npm/opencv.js@1.2.1/opencv.js" -o "$MODEL_FILE"
  echo "✓ opencv.js ($(du -h "$MODEL_FILE" | cut -f1))"
fi
