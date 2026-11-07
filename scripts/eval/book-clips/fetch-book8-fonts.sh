#!/usr/bin/env bash
#
# The fonts of book 8 (book8.py): Gentium Plus (SIL OFL), IBM Plex Mono
# (OFL) and Sawarabi Mincho (OFL), as published in the google/fonts
# repository — none of them a Debian font package the CI's stills step
# installs, so they are fetched here, pinned by SHA-256, into a directory
# render.py reads through BOOK_FONTS_DIR (default: this script's
# ../../../.cache/book8-fonts, git-ignored).
#
#   bash scripts/eval/book-clips/fetch-book8-fonts.sh [dest-dir]
#
# No font file is committed; the fonts are used only to render text into
# the clips' frames.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
DEST=${1:-${BOOK_FONTS_DIR:-$HERE/../../../.cache/book8-fonts}}
BASE=https://raw.githubusercontent.com/google/fonts/main

mkdir -p "$DEST"
want() {
  local sha=$1 path=$2 name
  name=$(basename "$path")
  if [ -s "$DEST/$name" ] && echo "$sha  $DEST/$name" | sha256sum -c --quiet - 2>/dev/null; then
    return 0
  fi
  echo "fetching $name"
  curl -fsSL --retry 3 -o "$DEST/$name.tmp" "$BASE/$path"
  echo "$sha  $DEST/$name.tmp" | sha256sum -c --quiet -
  mv "$DEST/$name.tmp" "$DEST/$name"
}
want 845e06bb4673a908a5f3b3b4ac9f38841750a07faa9aa45bfcb5796893346f0b ofl/gentiumplus/GentiumPlus-Regular.ttf
want 716c4a16887550b13f40b408df5dad6c410c72a00867c5fe802a9ed483e3fb8d ofl/gentiumplus/GentiumPlus-Bold.ttf
want 18df1f3ddf09cf72338f25c45ca0d1922fb5e86cdd748522dbd6bede4fb1f99d ofl/gentiumplus/GentiumPlus-Italic.ttf
want 6a3412f058c7d8dfd9170c41e85ade48e5156ecb89356110ca57a0a27734af46 ofl/ibmplexmono/IBMPlexMono-Regular.ttf
want ac27abd6450a64dd94467580a02fe6235156d5b92f2926ebbc8e7489df64e0be ofl/ibmplexmono/IBMPlexMono-Bold.ttf
want 3362fc791b0652193328b862c1c5f23a789bc7288b1617fa63302f88689a2a34 ofl/ibmplexmono/IBMPlexMono-Italic.ttf
want 1f27e6b0c2543a311c31d2ba3e895e50028069bd24b5e0d20a5b6e0a0b03e9c4 ofl/sawarabimincho/SawarabiMincho-Regular.ttf
echo "book 8 fonts in $DEST"
