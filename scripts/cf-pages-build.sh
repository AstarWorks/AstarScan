#!/usr/bin/env bash
#
# Cloudflare Pages build script.
#
# Dashboard build command: bun install && bash scripts/cf-pages-build.sh
# bun install is run BEFORE this script by the build command.
# This script provisions the runtime assets and runs the actual build.
set -euo pipefail

cd "$(dirname "$0")/.."

bash scripts/fetch-public-assets.sh
bun run build
