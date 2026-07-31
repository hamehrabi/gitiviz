/**
 * Analyzer for npm `package.json` files: emits the package name and one fact
 * per declared dependency. Pure JSON.parse — malformed or oddly-shaped files
 * become analysisLimitations, never crashes.
 */

import type { AnalysisLimitation } from "@gitiviz/schema";
import {
  MAX_ANALYZED_LINE_LENGTH,
  type Analyzer,
  type AnalyzerFact,
  type AnalyzerInput,
  type AnalyzerResult,
  type FactAnchor
} from "./types.js";

const ANALYZER_ID = "js-package@1";

const DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies"
] as const;

/**
 * Best-effort line locator: first line whose (length-capped) text contains
 * the JSON-quoted key. Plain substring search — no regex, no backtracking.
 * Returns a whole-file anchor when the key cannot be located (escapes,
 * unusual formatting).
 */
function anchorForKey(path: string, lines: string[], key: string): FactAnchor {
  const needle = JSON.stringify(key);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const capped =
      line.length > MAX_ANALYZED_LINE_LENGTH ? line.slice(0, MAX_ANALYZED_LINE_LENGTH) : line;
    if (capped.includes(needle)) {
      return { path, startLine: i + 1, endLine: i + 1 };
    }
  }
  return { path, startLine: 1, endLine: Math.max(1, lines.length) };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export const packageAnalyzer: Analyzer = {
  id: ANALYZER_ID,

  appliesTo(path: string): boolean {
    const base = path.split("/").pop();
    return base === "package.json";
  },

  analyze(input: AnalyzerInput): AnalyzerResult {
    const facts: AnalyzerFact[] = [];
    const limitations: AnalysisLimitation[] = [];

    let parsed: unknown;
    try {
      parsed = JSON.parse(input.content);
    } catch (err) {
      limitations.push({
        message: `Could not parse package.json: ${err instanceof Error ? err.message : String(err)}`,
        path: input.path,
        analyzer: ANALYZER_ID
      });
      return { facts, limitations };
    }

    if (!isPlainObject(parsed)) {
      limitations.push({
        message: "package.json root is not a JSON object; no facts extracted",
        path: input.path,
        analyzer: ANALYZER_ID
      });
      return { facts, limitations };
    }

    const lines = input.content.split("\n");

    if (typeof parsed.name === "string") {
      facts.push({
        kind: "package",
        value: { role: "name", name: parsed.name },
        anchor: anchorForKey(input.path, lines, "name")
      });
    }

    for (const section of DEPENDENCY_SECTIONS) {
      const deps = parsed[section];
      if (deps === undefined) continue;
      if (!isPlainObject(deps)) {
        limitations.push({
          message: `package.json field "${section}" is not an object; skipped`,
          path: input.path,
          analyzer: ANALYZER_ID
        });
        continue;
      }
      for (const [depName, version] of Object.entries(deps)) {
        if (typeof version !== "string") continue;
        facts.push({
          kind: "package",
          value: { role: "dependency", name: depName, version, section },
          anchor: anchorForKey(input.path, lines, depName)
        });
      }
    }

    return { facts, limitations };
  }
};
