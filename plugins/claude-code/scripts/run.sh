#!/usr/bin/env bash
# gitiviz launcher: run the bundled CLI with host Node when available,
# else fall back to Docker (node:22-bookworm — ships git, which the CLI
# shells out to). With Docker the current directory is mounted as the
# repo, so run this from inside the repository you want analyzed.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if command -v node >/dev/null 2>&1; then
  exec node "$SCRIPT_DIR/analyze.mjs" "$@"
elif command -v docker >/dev/null 2>&1; then
  # safe.directory: the bind-mounted repo's owner rarely matches the
  # container user, and git refuses "dubious ownership" repos otherwise.
  # GITIVIZ_REPO_NAME: inside the container the repo is always mounted at
  # /repo, so the CLI's directory-basename fallback would title every book
  # "repo" — pass the host directory's real name instead (the CLI still
  # prefers an explicit --name flag over this).
  exec docker run --rm \
    -v "$PWD":/repo -v "$SCRIPT_DIR":/scripts:ro -w /repo \
    -e GITIVIZ_REPO_NAME="$(basename "$PWD")" \
    -e GIT_CONFIG_COUNT=1 \
    -e GIT_CONFIG_KEY_0=safe.directory \
    -e GIT_CONFIG_VALUE_0='*' \
    node:22-bookworm node /scripts/analyze.mjs "$@"
else
  echo "gitiviz: needs Node.js 20+ or Docker. Install one and retry." >&2
  exit 1
fi
