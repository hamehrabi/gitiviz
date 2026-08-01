#!/usr/bin/env bash
# Simulates a clean end-user machine INSIDE the dev container:
#   - /clean is not this repo and has no node_modules anywhere above it
#   - only the COMMITTED plugin artifacts are used, via run.sh
#   - docker is not installed in the container, so the mermaid-cli route
#     (chain b2) is genuinely unreachable
set -euo pipefail

rm -rf /clean
mkdir -p /clean/plugin/scripts /clean/repo
cp /work/plugins/claude-code/scripts/analyze.mjs \
   /work/plugins/claude-code/scripts/apply-narration.mjs \
   /work/plugins/claude-code/scripts/mermaid-engine.mjs \
   /work/plugins/claude-code/scripts/run.sh /clean/plugin/scripts/
chmod +x /clean/plugin/scripts/run.sh

echo "--- environment ---"
echo "cwd for the run   : /clean/repo"
echo "node_modules above: $(find / -maxdepth 2 -name node_modules -not -path '/work/*' 2>/dev/null | tr '\n' ' ')[none]"
command -v docker >/dev/null 2>&1 && echo "docker: PRESENT (proof invalid)" || echo "docker: unreachable"
ls -la /clean/plugin/scripts

cd /clean/repo
git init -q
git config user.email dev@example.com
git config user.name "Dev"

mkdir -p src/api src/core src/store src/ui build
for f in src/api/routes.ts src/api/handlers.ts src/core/engine.ts src/core/rules.ts \
         src/store/db.ts src/store/cache.ts src/ui/page.ts src/ui/widgets.ts \
         build/pack.ts build/release.ts; do
  printf 'export const name = "%s";\n' "$f" > "$f"
done
git add -A && git commit -qm "feat: initial shop skeleton"
BASE=$(git rev-parse HEAD)

printf 'export const name = "orders";\nexport function createOrder() { return 1; }\n' > src/api/orders.ts
printf 'export function price(n: number) { return n * 2; }\n' >> src/core/rules.ts
git add -A && git commit -qm "feat: add the order creation endpoint"

printf 'export function writeOrder() { return true; }\n' >> src/store/db.ts
git add -A && git commit -qm "feat: persist orders in the store"
HEAD_SHA=$(git rev-parse HEAD)

echo
echo "--- pass 1: analyze (no narration yet) ---"
/clean/plugin/scripts/run.sh compare "$BASE" "$HEAD_SHA" --name shopdemo 2>&1 | tail -8

echo
echo "--- writing a narrated architectureDiagram: 20 nodes / 5 clusters ---"
cat > /clean/repo/.gitiviz/narration-response.json <<'JSON'
{
  "projectSummary": "A small shop backend: it takes orders over HTTP, prices them, and stores them.",
  "chapters": {
    "systems": {
      "summary": "Requests arrive at the API, the core prices them, the store persists them, and the build ships it.",
      "keyPoints": ["The API is the only entry point", "Pricing rules live in the core"]
    }
  },
  "architectureDiagram": {
    "clusters": [
      { "id": "entry", "title": "Entry & Routing", "tone": "blue" },
      { "id": "core", "title": "Pricing & Rules", "tone": "amber" },
      { "id": "store", "title": "Storage & Cache", "tone": "mint" },
      { "id": "ui", "title": "Reading and viewing", "tone": "violet" },
      { "id": "ship", "title": "Build & Distribution", "tone": "rose" }
    ],
    "nodes": [
      { "id": "n1", "cluster": "entry", "humanLabel": "HTTP routes", "role": "request routing", "file": "src/api/routes.ts" },
      { "id": "n2", "cluster": "entry", "humanLabel": "Request handlers", "role": "input validation", "file": "src/api/handlers.ts" },
      { "id": "n3", "cluster": "entry", "humanLabel": "Create order endpoint", "role": "new order intake", "file": "src/api/orders.ts" },
      { "id": "n4", "cluster": "entry", "humanLabel": "Session boundary", "role": "who is asking" },
      { "id": "n5", "cluster": "core", "humanLabel": "Pricing engine", "role": "totals and discounts", "file": "src/core/engine.ts" },
      { "id": "n6", "cluster": "core", "humanLabel": "Business rules", "role": "what is allowed", "file": "src/core/rules.ts" },
      { "id": "n7", "cluster": "core", "humanLabel": "Order assembly", "role": "builds the order record" },
      { "id": "n8", "cluster": "core", "humanLabel": "Validation gate", "role": "rejects impossible orders" },
      { "id": "n9", "cluster": "store", "humanLabel": "Order store", "role": "durable order rows", "file": "src/store/db.ts" },
      { "id": "n10", "cluster": "store", "humanLabel": "Read cache", "role": "fast repeat reads", "file": "src/store/cache.ts" },
      { "id": "n11", "cluster": "store", "humanLabel": "Write path", "role": "commits the order" },
      { "id": "n12", "cluster": "store", "humanLabel": "Migration record", "role": "schema history" },
      { "id": "n13", "cluster": "ui", "humanLabel": "Order page", "role": "what a shopper sees", "file": "src/ui/page.ts" },
      { "id": "n14", "cluster": "ui", "humanLabel": "Shared widgets", "role": "reusable pieces", "file": "src/ui/widgets.ts" },
      { "id": "n15", "cluster": "ui", "humanLabel": "Receipt view", "role": "confirmation screen" },
      { "id": "n16", "cluster": "ui", "humanLabel": "Error states", "role": "what went wrong" },
      { "id": "n17", "cluster": "ship", "humanLabel": "Bundler", "role": "packs the app", "file": "build/pack.ts" },
      { "id": "n18", "cluster": "ship", "humanLabel": "Release runner", "role": "publishes a version", "file": "build/release.ts" },
      { "id": "n19", "cluster": "ship", "humanLabel": "Artifact check", "role": "verifies the build" },
      { "id": "n20", "cluster": "ship", "humanLabel": "Deploy target", "role": "where it lands" }
    ],
    "edges": [
      { "from": "n1", "to": "n2", "verb": "hands the request to" },
      { "from": "n2", "to": "n3", "verb": "creates orders through" },
      { "from": "n4", "to": "n1", "verb": "identifies callers for" },
      { "from": "n3", "to": "n5", "verb": "asks for a price from" },
      { "from": "n5", "to": "n6", "verb": "applies" },
      { "from": "n6", "to": "n8", "verb": "feeds decisions to" },
      { "from": "n8", "to": "n7", "verb": "approves" },
      { "from": "n7", "to": "n11", "verb": "sends the record to" },
      { "from": "n11", "to": "n9", "verb": "writes into" },
      { "from": "n9", "to": "n10", "verb": "warms" },
      { "from": "n9", "to": "n12", "verb": "records shape changes in" },
      { "from": "n10", "to": "n13", "verb": "serves reads to" },
      { "from": "n13", "to": "n14", "verb": "renders with" },
      { "from": "n13", "to": "n15", "verb": "confirms through" },
      { "from": "n13", "to": "n16", "verb": "falls back to" },
      { "from": "n17", "to": "n18", "verb": "packages for" },
      { "from": "n18", "to": "n19", "verb": "is verified by" },
      { "from": "n19", "to": "n20", "verb": "promotes to" },
      { "from": "n14", "to": "n17", "verb": "is bundled by" }
    ]
  }
}
JSON

echo
echo "--- pass 2: apply-narration (renders the book) ---"
/clean/plugin/scripts/run.sh apply-narration 2>&1 | tail -8

echo
echo "--- evidence from /clean/repo/.gitiviz/dist/index.html ---"
HTML=/clean/repo/.gitiviz/dist/index.html
ls -la "$HTML"
echo "aria-roledescription        : $(grep -o 'aria-roledescription' "$HTML" | wc -l) (our sanitizer strips it by design: role=img, not a widget tree)"
echo "svg role=img roots          : $(grep -o 'role="img"' "$HTML" | wc -l)"
echo "mermaid tspan machinery     : $(grep -o 'text-outer-tspan' "$HTML" | wc -l)"
echo "mermaid label-container     : $(grep -o 'class="basic label-container"' "$HTML" | wc -l)"
echo "g.cluster elements          : $(grep -o '<g class="cluster"' "$HTML" | wc -l)"
echo "cluster-label groups        : $(grep -o 'class="cluster-label' "$HTML" | wc -l)"
echo "mermaid node groups         : $(grep -o '<g class="node ' "$HTML" | wc -l)"
echo "mermaid edgeLabel groups    : $(grep -o '<g class="edgeLabel"' "$HTML" | wc -l)"
echo "mermaid-generated ids       : $(grep -o 'id="gitiviz-architecture' "$HTML" | wc -l)"
echo "flowchart-link edges        : $(grep -o 'flowchart-link' "$HTML" | wc -l)"
echo "FALLBACK CAPTION present    : $(grep -c 'built-in diagram engine' "$HTML" || true)"
echo "foreignObject               : $(grep -ic 'foreignobject' "$HTML" || true)"
echo "script tags                 : $(grep -o '<script' "$HTML" | wc -l)"
echo "ellipsis (truncated labels) : $(grep -o '…' "$HTML" | wc -l)"
echo
echo "--- distinct edge-label positions in the architecture diagram ---"
grep -o '<g class="edgeLabel" transform="translate([^)]*)' "$HTML" | sort | uniq -c | sort -rn | head -5
echo "total edge labels: $(grep -o '<g class="edgeLabel" transform="translate([^)]*)' "$HTML" | wc -l)"
echo "distinct         : $(grep -o '<g class="edgeLabel" transform="translate([^)]*)' "$HTML" | sort -u | wc -l)"
echo
echo "--- cluster titles rendered (text of cluster-label groups) ---"
grep -o 'class="cluster-label[^§]\{0,400\}' "$HTML" | sed 's/<[^>]*>//g' | head -6
echo
echo "--- architecture diagram only: node count and a raw markup excerpt ---"
ARCH=/clean/repo/.gitiviz/mermaid/architecture.svg
if [ -f "$ARCH" ]; then echo "(disk copy present)"; fi
grep -o 'id="gitiviz-architecture-flowchart-n[0-9]*-[0-9]*"' "$HTML" | sort -u | wc -l | sed 's/^/architecture nodes: /'
grep -o '<g class="cluster" id="gitiviz-architecture-c[0-9]*"[^§]\{0,220\}' "$HTML" | head -2
echo
grep -o '<g class="node default toneAmber"[^§]\{0,300\}' "$HTML" | head -1

echo
echo "--- determinism: re-render and compare ---"
cp "$HTML" /clean/first.html
/clean/plugin/scripts/run.sh apply-narration >/dev/null 2>&1
if cmp -s /clean/first.html "$HTML"; then echo "byte-identical across runs: YES"; else echo "byte-identical across runs: NO"; fi
