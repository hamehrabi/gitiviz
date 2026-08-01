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

# Issues tab, host side: refresh <out>/issues.json from GitHub before the
# CLI runs (`gh` lives on the host only — never in the CLI, bundles, or the
# container). Strictly best-effort: every guard falls through silently and
# a failed fetch KEEPS the previous issues.json, so the book still builds
# offline. GITIVIZ_SKIP_ISSUES=1 opts out entirely (hook latency).
fetch_issues() {
  renders_book "${1-}" || return 0
  if [ -n "${GITIVIZ_SKIP_ISSUES:-}" ]; then return 0; fi
  command -v gh >/dev/null 2>&1 || return 0
  command -v git >/dev/null 2>&1 || return 0
  # gh resolves the repo from the origin remote; without one there is
  # nothing to fetch from (also keeps fixture/offline repos hermetic).
  git remote get-url origin >/dev/null 2>&1 || return 0
  mkdir -p "$OUT_DIR" 2>/dev/null || return 0
  local tmp="$OUT_DIR/issues.json.tmp"
  # tmp+mv: issues.json is only ever replaced by a COMPLETE gh response.
  if gh issue list --label gitiviz --state all --limit 100 \
    --json number,title,state,url,createdAt >"$tmp" 2>/dev/null; then
    mv -f "$tmp" "$OUT_DIR/issues.json" 2>/dev/null || rm -f "$tmp"
  else
    rm -f "$tmp"
  fi
  return 0
}

# Host-side chain link (b): render the compiled .mmd sources through the
# official mermaid-cli image with the CLI-written shared config. ONE
# container renders every pending diagram (a markdown batch — one
# headless-browser launch regardless of diagram count; per-diagram
# containers made multi-commit ranges take minutes to hours). Sources whose
# .svg already exists are fresh — the CLI deletes stale SVGs before this
# pass — and are skipped, so repeat runs render nothing. The CLI renames
# each SVG's id to its slot and re-sanitizes on pickup.
# Returns 0 when new SVGs were produced (a second CLI pass should pick
# them up), 1 when there was nothing to render or the batch failed.
render_mermaid_cli() {
  [ -d "$MERMAID_DIR" ] || return 1
  local batch="$MERMAID_DIR/_batch.md" mmd name names=() i rendered=0
  for mmd in "$MERMAID_DIR"/*.mmd; do
    [ -e "$mmd" ] || return 1   # no sources — nothing to do
    name="$(basename "$mmd" .mmd)"
    case "$name" in _*) continue ;; esac
    [ -s "$MERMAID_DIR/$name.svg" ] && continue   # fresh from an earlier pass
    names+=("$name")
  done
  [ "${#names[@]}" -eq 0 ] && return 1
  : > "$batch"
  for name in "${names[@]}"; do
    { printf '```mermaid\n'; cat "$MERMAID_DIR/$name.mmd"; printf '\n```\n\n'; } >> "$batch"
  done
  local batch_ok=1
  docker run --rm -v "$MERMAID_DIR":/data minlag/mermaid-cli \
    -q -i /data/_batch.md -o /data/_batch-out.md \
    -c /data/mermaid-config.json -b transparent || batch_ok=0
  i=1
  for name in "${names[@]}"; do
    if [ -s "$MERMAID_DIR/_batch-out-$i.svg" ]; then
      mv "$MERMAID_DIR/_batch-out-$i.svg" "$MERMAID_DIR/$name.svg"
      rendered=$((rendered + 1))
    fi
    i=$((i + 1))
  done
  rm -f "$batch" "$MERMAID_DIR/_batch-out.md" "$MERMAID_DIR"/_batch-out-*.svg
  if [ "$batch_ok" -eq 0 ]; then
    # A diagram that breaks the whole batch must not take the others down:
    # fall back to one container per diagram, exactly as before batching.
    echo "gitiviz: batched mermaid-cli run failed — retrying per-diagram" >&2
    for name in "${names[@]}"; do
      [ -s "$MERMAID_DIR/$name.svg" ] && continue
      if docker run --rm -v "$MERMAID_DIR":/data minlag/mermaid-cli \
        -q -i "/data/$name.mmd" -o "/data/$name.svg" \
        -c /data/mermaid-config.json -I "gitiviz-$name" -b transparent; then
        rendered=$((rendered + 1))
      else
        echo "gitiviz: mermaid-cli failed for $name — that diagram keeps the built-in fallback" >&2
      fi
    done
  fi
  [ "$rendered" -gt 0 ]
}

# The issue fetch must happen BEFORE dispatch: the host-node path execs
# and never returns, and the Docker fallback cannot reach `gh`.
fetch_issues "${1-}" || true

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
  # so render its compiled sources here (one batched container) and re-run
  # once to pick them up. Bounded at exactly one extra pass — never
  # recursive — and skipped entirely when every SVG was already fresh.
  if renders_book "${1-}" && [ -d "$MERMAID_DIR" ] \
    && compgen -G "$MERMAID_DIR/*.mmd" >/dev/null; then
    if render_mermaid_cli; then
      giti_in_docker "$@"
    fi
  fi
else
  echo "gitiviz: needs Node.js 20+ or Docker. Install one and retry." >&2
  exit 1
fi
