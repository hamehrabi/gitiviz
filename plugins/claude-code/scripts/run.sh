#!/usr/bin/env bash
# gitiviz launcher: run the bundled CLI with host Node when available,
# else fall back to Docker (node:22-bookworm — ships git, which the CLI
# shells out to). With Docker the current directory is mounted as the
# repo, so run this from inside the repository you want analyzed.
#
# Mermaid rendering chain (docs/decisions/0002-mermaid-render-chain.md):
#   (a) the CLI imports local mermaid+jsdom when installed;
#   (b) otherwise it renders via the minlag/mermaid-cli Docker image —
#       with host Node the CLI drives Docker itself; in the Docker
#       fallback below Docker is unreachable from inside the container,
#       so THIS script runs the mermaid-cli pass host-side between two
#       CLI runs (analyze writes <out>/mermaid/*.mmd; the second run
#       picks up the sanitized *.svg results);
#   (c) with neither, the built-in engine renders with an honest caption.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# The out dir (defaults to <repo>/.gitiviz; --out overrides) — needed to
# find the mermaid source/SVG exchange directory.
OUT_DIR="$PWD/.gitiviz"
prev=""
for arg in "$@"; do
  if [ "$prev" = "--out" ]; then OUT_DIR="$arg"; fi
  prev="$arg"
done
case "$OUT_DIR" in /*) ;; *) OUT_DIR="$PWD/$OUT_DIR" ;; esac
MERMAID_DIR="$OUT_DIR/mermaid"

# Does this invocation render a book at all? (validate does not.)
renders_book() {
  case "${1-}" in
    init|compare|branch|commit|apply-narration) return 0 ;;
    *) return 1 ;;
  esac
}

# Host-side chain link (b): render every compiled .mmd source through the
# official mermaid-cli image with the CLI-written shared config. Per-file
# failures are tolerated — those slots keep the honest built-in fallback,
# and the CLI re-sanitizes every SVG it picks up.
render_mermaid_cli() {
  [ -d "$MERMAID_DIR" ] || return 0
  local mmd name
  for mmd in "$MERMAID_DIR"/*.mmd; do
    [ -e "$mmd" ] || return 0   # no sources — nothing to do
    name="$(basename "$mmd" .mmd)"
    docker run --rm -v "$MERMAID_DIR":/data minlag/mermaid-cli \
      -q -i "/data/$name.mmd" -o "/data/$name.svg" \
      -c /data/mermaid-config.json -I "gitiviz-$name" -b transparent \
      || echo "gitiviz: mermaid-cli failed for $name — that diagram keeps the built-in fallback" >&2
  done
}

if command -v node >/dev/null 2>&1; then
  # Host Node: the CLI runs chain links (a) and (b) itself (it can reach
  # Docker directly from here).
  exec node "$SCRIPT_DIR/analyze.mjs" "$@"
elif command -v docker >/dev/null 2>&1; then
  # safe.directory: the bind-mounted repo's owner rarely matches the
  # container user, and git refuses "dubious ownership" repos otherwise.
  # GITIVIZ_REPO_NAME: inside the container the repo is always mounted at
  # /repo, so the CLI's directory-basename fallback would title every book
  # "repo" — pass the host directory's real name instead (the CLI still
  # prefers an explicit --name flag over this).
  giti_in_docker() {
    docker run --rm \
      -v "$PWD":/repo -v "$SCRIPT_DIR":/scripts:ro -w /repo \
      -e GITIVIZ_REPO_NAME="$(basename "$PWD")" \
      ${GITIVIZ_REPO_ORIGIN:+-e GITIVIZ_REPO_ORIGIN="$GITIVIZ_REPO_ORIGIN"} \
      -e GIT_CONFIG_COUNT=1 \
      -e GIT_CONFIG_KEY_0=safe.directory \
      -e GIT_CONFIG_VALUE_0='*' \
      node:22-bookworm node /scripts/analyze.mjs "$@"
  }
  giti_in_docker "$@"
  # Chain link (b), host-side: the containerized CLI cannot reach Docker,
  # so render its compiled sources here and re-run once to pick them up.
  # Bounded at exactly one extra pass — never recursive.
  if renders_book "${1-}" && [ -d "$MERMAID_DIR" ] \
    && compgen -G "$MERMAID_DIR/*.mmd" >/dev/null; then
    render_mermaid_cli
    giti_in_docker "$@"
  fi
else
  echo "gitiviz: needs Node.js 20+ or Docker. Install one and retry." >&2
  exit 1
fi
