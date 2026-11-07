#!/usr/bin/env bash
#
# Fetch the DocAligner page-corner model (DocsaidLab, Apache-2.0; lcnet100
# heatmap model, 256×256, 4.8 MB) that the Android capture screen runs on
# the device (CaptureDetector.kt), and the model's licence.
#
#   bash scripts/android/fetch-docaligner.sh [dest-dir]
#
# Default dest: the plugin's assets (src/main/assets, git-ignored), so the
# APK carries the model. The file is taken from the `quadscan` npm package
# (MIT; it ships DocAligner's own ONNX export unchanged) and checked
# against a pinned SHA-256: the model DocsaidLab publishes sits on Google
# Drive, which CI and the cloud sandboxes cannot download from reliably.

set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
DEST=${1:-$HERE/../../src-tauri/plugins/mlkit-scanner/android/src/main/assets}
TGZ_URL=https://registry.npmjs.org/quadscan/-/quadscan-1.0.0.tgz
TGZ_SHA=4fb6d69d2c462c4ee12b0a176d100f9e4d1cdc296da32287f91a780d71fee4f6
MODEL=lcnet100_h_e_bifpn_256_fp32.onnx
MODEL_SHA=f4117b786e3a18470f3865c93f3c2bd69d9b998edd60f385574a5c665e79594e
OUT=docaligner-lcnet100.onnx

mkdir -p "$DEST"
if [ -s "$DEST/$OUT" ] && echo "$MODEL_SHA  $DEST/$OUT" | sha256sum -c --quiet - 2>/dev/null; then
  echo "DocAligner model already in $DEST"
  exit 0
fi
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsSL --retry 4 -o "$tmp/q.tgz" "$TGZ_URL"
echo "$TGZ_SHA  $tmp/q.tgz" | sha256sum -c --quiet -
mkdir "$tmp/x"
tar -xzf "$tmp/q.tgz" -C "$tmp/x" "package/models/$MODEL" package/licenses/DocAligner-LICENSE.txt
echo "$MODEL_SHA  $tmp/x/package/models/$MODEL" | sha256sum -c --quiet -
cp "$tmp/x/package/models/$MODEL" "$DEST/$OUT"
cp "$tmp/x/package/licenses/DocAligner-LICENSE.txt" "$DEST/docaligner-LICENSE.txt"
echo "DocAligner model -> $DEST/$OUT"
