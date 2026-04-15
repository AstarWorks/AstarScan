#!/usr/bin/env bash
#
# Cloudflare Pages build script.
#
# Dashboard build command: bun install && bash scripts/cf-pages-build.sh
# bun install is run BEFORE this script by the build command.
# This script handles model downloads and the actual build.
set -euo pipefail

cd "$(dirname "$0")/.."

bash scripts/download-opencv.sh
bash scripts/download-ocr-models.sh
bash scripts/download-siglip-model.sh
bun run build
