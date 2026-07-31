#!/usr/bin/env bash
# All Node tooling runs inside Docker. The host never needs node/npm/pnpm.
set -euo pipefail
IMAGE="node:22-bookworm"
exec docker run --rm -i \
  -v "$PWD":/work \
  -v gitiviz-pnpm-store:/pnpm-store \
  -w /work \
  -e PNPM_HOME=/pnpm-store \
  -e npm_config_store_dir=/pnpm-store/store \
  "$IMAGE" bash -c "corepack enable >/dev/null 2>&1 && corepack prepare pnpm@9 --activate >/dev/null 2>&1 && $*"
