#!/usr/bin/env bash
#
# Cloudflare Pages build script.
# Called from apps/web/wrangler.toml — runs in a child process so
# the cd does not affect Wrangler's deploy-phase cwd.
set -euo pipefail

cd "$(dirname "$0")/.."

bash scripts/download-ocr-models.sh
bash scripts/download-siglip-model.sh
bun run build
