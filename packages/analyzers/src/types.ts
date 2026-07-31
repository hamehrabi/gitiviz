/**
 * Language-neutral, evidence-first analyzer interface.
 *
 * Analyzers turn one file's content into structured facts, each anchored to
 * the lines that justify it. File content is hostile repository data:
 * analyzers must never eval it, never crash on it, and never use regexes
 * vulnerable to catastrophic backtracking. Anything an analyzer cannot make
 * sense of becomes an {@link AnalysisLimitation}, not an exception.
 */

import type { AnalysisLimitation } from "@gitiviz/schema";

/** Maximum line length analyzers will inspect; longer lines are truncated
 * for matching (the underlying content is untouched). Guards regex/string
 * scans against pathological single-line files. */
export const MAX_ANALYZED_LINE_LENGTH = 2000;

export type AnalyzerFactKind = "package" | "import" | "export" | "route" | "sql-table";

export interface FactAnchor {
  /** Repo-relative path (hostile input — escape before any HTML output). */
  path: string;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
}

export interface AnalyzerFact {
  kind: AnalyzerFactKind;
  /** Flat string map — values are verbatim repo data, treat as hostile. */
  value: Record<string, string>;
  anchor: FactAnchor;
}

export interface AnalyzerInput {
  /** Repo-relative path of the file being analyzed. */
  path: string;
  content: string;
}

export interface AnalyzerResult {
  facts: AnalyzerFact[];
  /** Honest record of what this analyzer could not do with this file. */
  limitations: AnalysisLimitation[];
}

export interface Analyzer {
  /** Includes a version so cache keys change when behavior does, e.g. "js-package@1". */
  id: string;
  appliesTo(path: string): boolean;
  analyze(input: AnalyzerInput): AnalyzerResult;
}
