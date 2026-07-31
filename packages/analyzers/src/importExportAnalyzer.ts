/**
 * Line-based import/export analyzer for JS/TS source files.
 *
 * v0.1 is explicitly NOT an AST parse. It extracts:
 *   - `import ... from "x"` (single- and multi-line) and bare `import "x"`
 *   - `export function|const|let|var|class|interface|type|enum NAME`
 *   - best-effort: dynamic `import("x")` and re-exports (`export ... from "x"`)
 *
 * Best-effort constructs and anything unresolvable are recorded as
 * analysisLimitations — never crashes, never evals. All regexes use single
 * negated-character-class quantifiers (linear time, no catastrophic
 * backtracking), and every line is capped at MAX_ANALYZED_LINE_LENGTH before
 * matching. Extracted names and specifiers are verbatim repo data: hostile,
 * inert, escaped only at render time.
 */

import type { AnalysisLimitation } from "@gitiviz/schema";
import {
  MAX_ANALYZED_LINE_LENGTH,
  type Analyzer,
  type AnalyzerFact,
  type AnalyzerInput,
  type AnalyzerResult
} from "./types.js";

const ANALYZER_ID = "js-import-export@1";

const JS_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);

/** How many lines past an unterminated `import {` we search for its `from` clause. */
const MULTILINE_LOOKAHEAD = 40;

// All regexes below are linear-safe: quantifiers apply only to single
// characters or negated character classes; no nested/overlapping repetition.

/** `from "specifier"` / `from 'specifier'` — specifier may not span lines. */
const FROM_SPECIFIER = /\bfrom\s+(?:"([^"\n]*)"|'([^'\n]*)')/;
/** Bare side-effect import: `import "x"`. */
const BARE_IMPORT = /^import\s+(?:"([^"\n]*)"|'([^'\n]*)')/;
/** Dynamic import call site; specifier (if a literal) is scanned separately. */
const DYNAMIC_IMPORT_CALL = /\bimport\s*\(\s*/g;
/**
 * `export [default] [abstract] [async] <decl-kind> <name>`. The name capture
 * deliberately allows almost anything (hostile symbol names survive as data),
 * stopping only at whitespace and the characters that end a name position.
 */
const EXPORT_DECL =
  /^export\s+(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(function|class|const|let|var|interface|type|enum)\s+\*?\s*([^\s(=:;,{<]+)/;

function extensionOf(path: string): string {
  const base = path.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot).toLowerCase();
}

function fromSpecifierOf(line: string): string | undefined {
  const m = FROM_SPECIFIER.exec(line);
  if (!m) return undefined;
  return m[1] ?? m[2];
}

/**
 * Finds dynamic `import(` call sites in a capped line. String-literal
 * specifiers are extracted by plain index scanning (no regex over the
 * specifier). Returns extracted specifiers plus a count of call sites whose
 * specifier is not a string literal.
 */
function scanDynamicImports(line: string): { specifiers: string[]; nonLiteral: number } {
  const specifiers: string[] = [];
  let nonLiteral = 0;
  DYNAMIC_IMPORT_CALL.lastIndex = 0;
  for (const m of line.matchAll(DYNAMIC_IMPORT_CALL)) {
    const at = m.index + m[0].length;
    const quote = line[at];
    if (quote !== '"' && quote !== "'") {
      nonLiteral += 1;
      continue;
    }
    const close = line.indexOf(quote, at + 1);
    if (close === -1) {
      nonLiteral += 1;
      continue;
    }
    specifiers.push(line.slice(at + 1, close));
  }
  return { specifiers, nonLiteral };
}

export const importExportAnalyzer: Analyzer = {
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
    const lines = rawLines.map((line) => {
      if (line.length > MAX_ANALYZED_LINE_LENGTH) {
        truncatedLines += 1;
        return line.slice(0, MAX_ANALYZED_LINE_LENGTH);
      }
      return line;
    });

    let sawReexport = false;
    let dynamicNonLiteral = 0;
    let sawDynamic = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const trimmed = line.trimStart();

      // --- static / bare / multi-line `import` statements ---------------
      if (/^import\b/.test(trimmed) && !/^import\s*\(/.test(trimmed)) {
        const bare = BARE_IMPORT.exec(trimmed);
        const sameLine = fromSpecifierOf(line);
        if (bare) {
          facts.push({
            kind: "import",
            value: { source: bare[1] ?? bare[2]!, importKind: "static" },
            anchor: { path, startLine: i + 1, endLine: i + 1 }
          });
        } else if (sameLine !== undefined) {
          facts.push({
            kind: "import",
            value: { source: sameLine, importKind: "static" },
            anchor: { path, startLine: i + 1, endLine: i + 1 }
          });
        } else {
          // Multi-line import: look ahead a bounded number of lines for the
          // `from "..."` clause.
          let resolved = false;
          const limit = Math.min(lines.length - 1, i + MULTILINE_LOOKAHEAD);
          for (let j = i + 1; j <= limit; j++) {
            const spec = fromSpecifierOf(lines[j]!);
            if (spec !== undefined) {
              facts.push({
                kind: "import",
                value: { source: spec, importKind: "static" },
                anchor: { path, startLine: i + 1, endLine: j + 1 }
              });
              i = j; // consume the statement's lines
              resolved = true;
              break;
            }
          }
          if (!resolved) {
            limitations.push({
              message: `Import statement at line ${i + 1} has no module specifier within ${MULTILINE_LOOKAHEAD} lines; skipped (line-based scan, no AST parse in v0.1)`,
              path,
              analyzer: ANALYZER_ID
            });
          }
        }
        continue;
      }

      // --- `export` lines -----------------------------------------------
      if (/^export\b/.test(trimmed)) {
        const decl = EXPORT_DECL.exec(trimmed);
        if (decl) {
          const value: Record<string, string> = {
            name: decl[2]!,
            declarationType: decl[1]!
          };
          if (/^export\s+default\b/.test(trimmed)) value.default = "true";
          facts.push({
            kind: "export",
            value,
            anchor: { path, startLine: i + 1, endLine: i + 1 }
          });
          continue;
        }
        const reexport = fromSpecifierOf(line);
        if (reexport !== undefined) {
          sawReexport = true;
          facts.push({
            kind: "import",
            value: { source: reexport, importKind: "reexport" },
            anchor: { path, startLine: i + 1, endLine: i + 1 }
          });
        }
        // Other export forms (`export { a }`, `export default expr`) carry no
        // declaration we can name — skipped by design.
        continue;
      }

      // --- dynamic `import(...)` anywhere in the line -------------------
      const dyn = scanDynamicImports(line);
      dynamicNonLiteral += dyn.nonLiteral;
      for (const source of dyn.specifiers) {
        sawDynamic = true;
        facts.push({
          kind: "import",
          value: { source, importKind: "dynamic" },
          anchor: { path, startLine: i + 1, endLine: i + 1 }
        });
      }
    }

    if (truncatedLines > 0) {
      limitations.push({
        message: `${truncatedLines} line(s) exceed ${MAX_ANALYZED_LINE_LENGTH} chars and were truncated for analysis; facts on those lines may be missed`,
        path,
        analyzer: ANALYZER_ID
      });
    }
    if (sawDynamic || dynamicNonLiteral > 0) {
      const detail =
        dynamicNonLiteral > 0
          ? `; ${dynamicNonLiteral} call(s) use a non-literal specifier and were not resolved`
          : "";
      limitations.push({
        message: `Dynamic import detection is best-effort (textual match, no AST parse in v0.1)${detail}`,
        path,
        analyzer: ANALYZER_ID
      });
    }
    if (sawReexport) {
      limitations.push({
        message:
          "Re-export detection is best-effort: recorded as imports of the source module; re-exported names are not tracked (no AST parse in v0.1)",
        path,
        analyzer: ANALYZER_ID
      });
    }

    return { facts, limitations };
  }
};
