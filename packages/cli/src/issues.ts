/**
 * Defensive reader for `<out>/issues.json` — the GitHub issue list the
 * host-side launcher (plugins/claude-code/scripts/run.sh) fetches with `gh`
 * before the CLI runs.
 *
 * Threat model: the out dir usually sits inside the analyzed repository
 * (`.gitiviz/`), so a hostile repo can ship a COMMITTED issues.json of its
 * own making. Nothing in this file is trusted: the byte size, the JSON
 * shape, every field type, and every string length are capped, bad entries
 * are dropped, and anything malformed at the top level yields null (render
 * as "no issues") rather than an error — a hostile file must never fail the
 * build. Strings that survive are still hostile data; the renderer escapes
 * them and re-validates the url against the repo origin before linking.
 */
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

/** One fetched GitHub issue, shape-validated (contents still hostile). */
export interface RepoIssue {
  number: number;
  title: string;
  state: string;
  url: string;
  createdAt: string;
}

/** Reject files larger than this outright (hostile committed blobs). */
const MAX_FILE_BYTES = 1_000_000;
/** Cap on surviving entries (the launcher fetches at most 100). */
const MAX_ISSUES = 200;
/** Per-field caps: over-long titles/dates truncate, everything else drops. */
const MAX_TITLE_LENGTH = 500;
const MAX_STATE_LENGTH = 50;
const MAX_URL_LENGTH = 2000;
const MAX_DATE_LENGTH = 100;
/** Issue numbers are positive and realistically bounded. */
const MAX_ISSUE_NUMBER = 1_000_000_000;

/** Validate one raw entry into a RepoIssue, or null to drop it. */
function readEntry(raw: unknown): RepoIssue | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;
  const { number, title, state, url, createdAt } = entry;
  if (
    typeof number !== "number" ||
    !Number.isInteger(number) ||
    number < 1 ||
    number > MAX_ISSUE_NUMBER
  ) {
    return null;
  }
  if (typeof title !== "string" || title.length === 0) return null;
  if (typeof state !== "string") return null;
  if (typeof url !== "string" || url.length > MAX_URL_LENGTH) return null;
  if (typeof createdAt !== "string") return null;
  return {
    number,
    title: title.slice(0, MAX_TITLE_LENGTH),
    state: state.slice(0, MAX_STATE_LENGTH),
    url,
    createdAt: createdAt.slice(0, MAX_DATE_LENGTH)
  };
}

/**
 * Read and validate `<outDir>/issues.json`. Returns the surviving issues
 * (possibly `[]` — an honest "no tickets yet"), or null when the file is
 * absent, oversized, unparseable, or not a JSON array. Never throws.
 */
export async function readIssues(outDir: string): Promise<RepoIssue[] | null> {
  const path = join(outDir, "issues.json");
  let raw: string;
  try {
    if ((await stat(path)).size > MAX_FILE_BYTES) return null;
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const issues: RepoIssue[] = [];
  for (const entry of parsed) {
    const issue = readEntry(entry);
    if (issue !== null) {
      issues.push(issue);
      if (issues.length >= MAX_ISSUES) break;
    }
  }
  return issues;
}
