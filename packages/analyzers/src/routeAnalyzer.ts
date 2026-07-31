/**
 * Express-style HTTP route analyzer for JS/TS source files.
 *
 * v0.1 is a textual, line-based scan (no AST parse). It detects
 * `app.<verb>("path", ...)` and `router.<verb>('path', ...)` call sites —
 * including dotted receivers like `server.app.get(...)` — and emits a
 * `route` fact with method, path and receiver, anchored to the line.
 *
 * Best-effort honesty: non-literal paths (variables, template literals) and
 * unterminated string literals become analysisLimitations, never facts and
 * never crashes. The regex uses only literal alternations and single-class
 * quantifiers (linear time, no catastrophic backtracking), and every line is
 * capped at MAX_ANALYZED_LINE_LENGTH before matching. Extracted paths are
 * verbatim repo data: hostile, inert, escaped only at render time.
 */

import type { AnalysisLimitation } from "@gitiviz/schema";
import {
  MAX_ANALYZED_LINE_LENGTH,
  type Analyzer,
  type AnalyzerFact,
  type AnalyzerInput,
  type AnalyzerResult
} from "./types.js";

const ANALYZER_ID = "js-express-route@1";

const JS_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);

/**
 * `app.<verb>(` / `router.<verb>(` call sites. `\b` before the receiver
 * rejects `myapp.get` while still matching dotted chains (`server.app.get`).
 * Verbs are a closed list, so `app.use(...)` / `app.listen(...)` never match.
 * Linear-safe: literal alternations plus `\s*` only.
 */
const ROUTE_CALL =
  /\b(app|router)\s*\.\s*(get|post|put|patch|delete|head|options|all)\s*\(\s*/g;

function extensionOf(path: string): string {
  const base = path.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot).toLowerCase();
}

export const routeAnalyzer: Analyzer = {
  id: ANALYZER_ID,

  appliesTo(path: string): boolean {
    return JS_EXTENSIONS.has(extensionOf(path));
  },

  analyze(input: AnalyzerInput): AnalyzerResult {
    const facts: AnalyzerFact[] = [];
    const limitations: AnalysisLimitation[] = [];
    const path = input.path;

    const rawLines = input.content.split("\n");
    let truncatedLines = 0;
    let nonLiteralPaths = 0;
    let unterminatedPaths = 0;

    for (let i = 0; i < rawLines.length; i++) {
      let line = rawLines[i]!;
      if (line.length > MAX_ANALYZED_LINE_LENGTH) {
        truncatedLines += 1;
        line = line.slice(0, MAX_ANALYZED_LINE_LENGTH);
      }

      ROUTE_CALL.lastIndex = 0;
      for (const m of line.matchAll(ROUTE_CALL)) {
        // First argument is extracted by plain index scanning — no regex
        // ever runs over the (hostile) path string itself.
        const at = m.index + m[0].length;
        const quote = line[at];
        if (quote !== '"' && quote !== "'") {
          nonLiteralPaths += 1;
          continue;
        }
        const close = line.indexOf(quote, at + 1);
        if (close === -1) {
          unterminatedPaths += 1;
          continue;
        }
        facts.push({
          kind: "route",
          value: {
            method: m[2]!.toUpperCase(),
            path: line.slice(at + 1, close),
            receiver: m[1]!
          },
          anchor: { path, startLine: i + 1, endLine: i + 1 }
        });
      }
    }

    if (truncatedLines > 0) {
      limitations.push({
        message: `${truncatedLines} line(s) exceed ${MAX_ANALYZED_LINE_LENGTH} chars and were truncated for analysis; routes on those lines may be missed`,
        path,
        analyzer: ANALYZER_ID
      });
    }
    if (nonLiteralPaths > 0) {
      limitations.push({
        message: `${nonLiteralPaths} route call(s) use a non-literal path (variable or template literal) and were not resolved (textual match, no AST parse in v0.1)`,
        path,
        analyzer: ANALYZER_ID
      });
    }
    if (unterminatedPaths > 0) {
      limitations.push({
        message: `${unterminatedPaths} route call(s) have an unterminated path string literal on the call line and were skipped (line-based scan, no AST parse in v0.1)`,
        path,
        analyzer: ANALYZER_ID
      });
    }

    return { facts, limitations };
  }
};
