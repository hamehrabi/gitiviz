#!/usr/bin/env bash
# Host-side test for plugins/claude-code/scripts/run.sh.
#
# Runs with host bash + git + docker only (no node required — on a
# node-less host the Docker fallback is exercised for REAL against a
# generated fixture repo). Three paths covered:
#   1. node present     -> execs host node with analyze.mjs (stub node)
#   2. node absent      -> Docker fallback produces a change book
#   3. neither present  -> exit 1 with an actionable message
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_SH="$REPO_ROOT/plugins/claude-code/scripts/run.sh"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/gitiviz-launcher.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

FAILURES=0
pass() { echo "ok - $1"; }
fail() { echo "FAIL - $1" >&2; FAILURES=$((FAILURES + 1)); }

# --- fixture: a real git repo with a base branch and a feature branch ----
FIXTURE="$WORK/fixture"
mkdir -p "$FIXTURE"
GIT=(git -C "$FIXTURE" -c user.name=test -c user.email=test@example.com \
  -c commit.gpgsign=false)
git -C "$FIXTURE" init -q -b main
mkdir -p "$FIXTURE/src"
printf 'export const greet = () => "hello";\n' > "$FIXTURE/src/greet.ts"
printf '# fixture\n' > "$FIXTURE/README.md"
"${GIT[@]}" add -A
"${GIT[@]}" commit -qm "feat: initial greeting module"
"${GIT[@]}" checkout -qb feature/x
printf 'export const greet = (name: string) => `hello ${name}`;\n' \
  > "$FIXTURE/src/greet.ts"
printf 'export const shout = (s: string) => s.toUpperCase();\n' \
  > "$FIXTURE/src/shout.ts"
"${GIT[@]}" add -A
"${GIT[@]}" commit -qm "feat: personalized greeting and shout helper"

# --- 1. node-present path: a stub node must receive analyze.mjs + args --
STUB_BIN="$WORK/stub-bin"
mkdir -p "$STUB_BIN"
cat > "$STUB_BIN/node" <<EOF
#!/bin/bash
printf '%s\n' "\$@" > "$WORK/stub-node-args"
EOF
chmod +x "$STUB_BIN/node"
if (cd "$FIXTURE" && PATH="$STUB_BIN:/usr/bin:/bin" bash "$RUN_SH" compare main feature/x) \
  && [[ "$(cat "$WORK/stub-node-args")" == "$REPO_ROOT/plugins/claude-code/scripts/analyze.mjs
compare
main
feature/x" ]]; then
  pass "node path execs host node with analyze.mjs and forwarded args"
else
  fail "node path did not exec stub node with expected args"
fi

# --- 2. docker fallback: real end-to-end run against the fixture --------
# PATH still finds docker (and git inside the container); this host has no
# node so on the target machine this is the genuine fallback. To make the
# test honest even on hosts WITH node, strip node from PATH via a shadow
# dir is not enough (command -v finds it anywhere on PATH), so build a
# PATH of only the dirs needed for bash/dirname/docker, minus any node.
DOCKER_DIR="$(dirname "$(command -v docker)")"
if (cd "$FIXTURE" && PATH="/usr/bin:/bin:$DOCKER_DIR" bash "$RUN_SH" compare main feature/x); then
  pass "docker fallback exits 0"
else
  fail "docker fallback exited non-zero"
fi
HTML="$FIXTURE/.gitiviz/dist/index.html"
if [[ -s "$HTML" ]] && grep -q "shout" "$HTML"; then
  pass "docker fallback wrote a change book referencing fixture code"
else
  fail "expected $HTML to exist and mention the fixture's new symbol"
fi
if [[ -s "$FIXTURE/.gitiviz/manifests/change.json" \
   && -s "$FIXTURE/.gitiviz/manifests/book.json" \
   && -s "$FIXTURE/.gitiviz/narration-request.json" ]]; then
  pass "docker fallback wrote manifests and narration request"
else
  fail "missing manifest / narration-request outputs under $FIXTURE/.gitiviz"
fi
# The repo is mounted at /repo inside the container; the launcher must pass
# the host directory's real name so the book is not titled "repo".
if grep -q 'class="sb-wordmark">fixture<' "$HTML"; then
  pass "docker fallback titles the book after the host directory, not /repo"
else
  fail "expected the sidebar wordmark 'fixture' in $HTML, got: $(grep -o 'class="sb-wordmark">[^<]*<' "$HTML" || echo none)"
fi

# Fresh diagrams are not re-rendered: a second identical run must leave the
# mermaid SVGs untouched (mermaid-cli containers are the expensive step).
SVG_FIRST="$(ls "$FIXTURE/.gitiviz/mermaid/"*.svg 2>/dev/null | head -1)"
if [[ -n "$SVG_FIRST" ]]; then
  # Backdate the SVG; anything that rewrites it bumps the mtime past REF.
  REF="$WORK/mtime-ref"
  touch -t 202001010000 "$SVG_FIRST"
  touch -t 202101010000 "$REF"
  if (cd "$FIXTURE" && PATH="/usr/bin:/bin:$DOCKER_DIR" bash "$RUN_SH" compare main feature/x) \
    && [[ -z "$(find "$SVG_FIRST" -newer "$REF" 2>/dev/null)" ]]; then
    pass "second run skips mermaid re-render (fresh SVGs untouched)"
  else
    fail "second run re-rendered fresh mermaid SVGs (or failed)"
  fi
fi

# --- 3. neither node nor docker: actionable error, exit 1 ---------------
STDERR_FILE="$WORK/stderr"
if (cd "$FIXTURE" && PATH="/usr/bin:/bin" bash "$RUN_SH" compare main feature/x \
  2> "$STDERR_FILE"); then
  fail "launcher succeeded with neither node nor docker on PATH"
else
  CODE=$?
  if [[ $CODE -eq 1 ]] && grep -q "Node.js 20+ or Docker" "$STDERR_FILE"; then
    pass "missing-runtime path exits 1 with actionable message"
  else
    fail "missing-runtime path: exit=$CODE stderr=$(cat "$STDERR_FILE")"
  fi
fi

if [[ $FAILURES -gt 0 ]]; then
  echo "$FAILURES launcher test(s) failed" >&2
  exit 1
fi
echo "all launcher tests passed"
