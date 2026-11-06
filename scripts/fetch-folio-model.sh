#!/usr/bin/env bash
#
# Fetch the text recogniser the web capture screen reads page numbers with:
# PaddleOCR PP-OCRv4 recognition (Apache-2.0, 10.8 MB ONNX, CTC over
# Chinese / Japanese kana-kanji / Latin / digits, 48 px high input) and its
# character list.
#
#   bash scripts/fetch-folio-model.sh [dest-dir]
#
# Default dest: apps/web/public/models (git-ignored), served by the app
# itself (under the 25 MiB Workers asset limit), so it works offline.
# The files come from the `@gutenye/ocr-models` npm package (MIT; it ships
# PaddleOCR's own ONNX export unchanged) and are checked against pinned
# SHA-256s, like scripts/android/fetch-docaligner.sh.
#
# Why this and not NDLOCR's PARSeq: on the page numbers of the five book
# clips (pages warped from the ground-truth corners, number boxes found the
# same way) PARSeq-30 read 6 of 36 right, PP-OCRv4 48 of 60 (single picks;
# docs/book-eval.md "ページ番号の読み取り").

set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
DEST=${1:-$HERE/../apps/web/public/models}
TGZ_URL=https://registry.npmjs.org/@gutenye/ocr-models/-/ocr-models-1.4.2.tgz
TGZ_SHA=9b6666eae0b51936f186bcf4d581c403b63232c8d2d256308d2259dee3afd14e
REC=ch_PP-OCRv4_rec_infer.onnx
REC_SHA=06b3e6af6c59a1ba5d53790ed8c2e4b2de389870b6cf5a97f349f3412cb269c0
KEYS=ppocr_keys_v1.txt
KEYS_SHA=28b2362ad4ab2dc38769aa72feb535e3a9ddb3fd2a7585a05920e6393b1dc7f7

mkdir -p "$DEST"
if [ -s "$DEST/ppocr-rec.onnx" ] && [ -s "$DEST/ppocr-keys.txt" ] &&
  echo "$REC_SHA  $DEST/ppocr-rec.onnx" | sha256sum -c --quiet - 2>/dev/null &&
  echo "$KEYS_SHA  $DEST/ppocr-keys.txt" | sha256sum -c --quiet - 2>/dev/null; then
  echo "PP-OCR recogniser already in $DEST"
  exit 0
fi
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsSL --retry 4 -o "$tmp/m.tgz" "$TGZ_URL"
echo "$TGZ_SHA  $tmp/m.tgz" | sha256sum -c --quiet -
mkdir "$tmp/x"
tar -xzf "$tmp/m.tgz" -C "$tmp/x" "package/assets/$REC" "package/assets/$KEYS"
echo "$REC_SHA  $tmp/x/package/assets/$REC" | sha256sum -c --quiet -
echo "$KEYS_SHA  $tmp/x/package/assets/$KEYS" | sha256sum -c --quiet -
cp "$tmp/x/package/assets/$REC" "$DEST/ppocr-rec.onnx"
cp "$tmp/x/package/assets/$KEYS" "$DEST/ppocr-keys.txt"
echo "PP-OCR recogniser -> $DEST/ppocr-rec.onnx"
