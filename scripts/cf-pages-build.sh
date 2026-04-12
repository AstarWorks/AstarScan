#!/usr/bin/env bash
#
# Cloudflare Pages build script.
# Handles everything: Bun setup, dependency install, model download, build.
# Dashboard build command: bash ../../scripts/cf-pages-build.sh
set -euo pipefail

cd "$(dirname "$0")/.."

# Cloudflare Pages defaults to npm, which can't resolve workspace:* protocol.
# Install Bun if not available.
if ! command -v bun &> /dev/null; then
  echo "Installing Bun..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi

echo "Bun version: $(bun --version)"

bun install
bash scripts/download-ocr-models.sh
bash scripts/download-siglip-model.sh
bun run build
