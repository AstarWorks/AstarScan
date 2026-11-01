#!/usr/bin/env bash
#
# Provision OpenCV.js for local serving (avoids CORS issues with a CDN).
#
# Uses the @techstark/opencv-js build (~10.4MB) because the runtime
# pipeline now needs ORB / BFMatcher / findHomography for the post-hoc
# cluster merger in apps/web/app/services/orb-merge.ts. The official
# docs.opencv.org build (the previous source here) compiles those
# feature-detector APIs out by default. See docs/eval-results.md for
# why this matters.
set -euo pipefail

DEST="apps/web/public"
MODEL_FILE="$DEST/opencv.js"

if [ -f "$MODEL_FILE" ]; then
  echo "✓ opencv.js (already exists, $(du -h "$MODEL_FILE" | cut -f1))"
  exit 0
fi

# Prefer copying from the local node_modules install (deterministic
# version, matches the harness in scripts/eval/). Falls back to a CDN
# fetch for environments where node_modules isn't installed yet.
LOCAL_BUILD="node_modules/@techstark/opencv-js/dist/opencv.js"
if [ -f "$LOCAL_BUILD" ]; then
  echo "↓ opencv.js from local @techstark/opencv-js (~10.4MB)..."
  cp "$LOCAL_BUILD" "$MODEL_FILE"
else
  echo "↓ opencv.js from jsdelivr @techstark/opencv-js@4.12.0 (~10.4MB)..."
  curl -fSL "https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.12.0-release.1/dist/opencv.js" -o "$MODEL_FILE"
fi
echo "✓ opencv.js ($(du -h "$MODEL_FILE" | cut -f1))"
