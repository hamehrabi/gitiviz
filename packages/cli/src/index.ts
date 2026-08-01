/**
 * gitiviz CLI — zero-dependency arg parsing + command dispatch.
 *
 *   gitiviz init [--commits N]    [--repo DIR] [--out DIR] [--name NAME]
 *   gitiviz compare <base> <head> [--repo DIR] [--out DIR] [--name NAME]
 *   gitiviz branch [base]         [--repo DIR] [--out DIR] [--name NAME]
 *   gitiviz commit <sha>          [--repo DIR] [--out DIR] [--name NAME]
 *   gitiviz validate                          [--out DIR]
 *   gitiviz apply-narration                   [--out DIR] [--name NAME]
 *
 * --repo defaults to the current directory; --out defaults to
 * <repo>/.gitiviz. The repository display name resolves --name >
 * GITIVIZ_REPO_NAME env > origin remote basename > directory basename
 * (see repo-name.ts). All failures surface as one actionable stderr message and
 * exit code 1 — command implementations throw, callers exit.
 * This module is a pure library; the executable entries are main.ts
 * (full CLI, bundled as analyze.mjs) and apply-narration.ts (bundled as
 * apply-narration.mjs).
 */
import { join, resolve } from "node:path";
import {
  runApplyNarration,
  runBranch,
  runCommit,
  runCompare,
  runInit,
  runValidate
} from "./commands/compare.js";

export interface CliIo {
  out(text: string): void;
  err(text: string): void;
}

const USAGE = `Usage:
  gitiviz init [--commits N]    [--repo DIR] [--out DIR] [--name NAME]
  gitiviz compare <base> <head> [--repo DIR] [--out DIR] [--name NAME]
  gitiviz branch [base]         [--repo DIR] [--out DIR] [--name NAME]
  gitiviz commit <sha>          [--repo DIR] [--out DIR] [--name NAME]
  gitiviz validate                          [--out DIR]
  gitiviz apply-narration                   [--out DIR] [--name NAME]

  --commits N  init only: how many trailing commits to analyze (default: 20,
               clamped to the available history)
  --repo DIR   git repository to analyze (default: current directory)
  --out DIR    output directory (default: <repo>/.gitiviz)
  --name NAME  repository display name (default: GITIVIZ_REPO_NAME env,
               else the origin remote's repo name, else the directory name)`;

/** Default number of trailing commits `gitiviz init` analyzes. */
const DEFAULT_INIT_COMMITS = 20;

interface ParsedArgs {
  positionals: string[];
  repo?: string;
  out?: string;
  name?: string;
  commits?: number;
}

/** Hand-rolled parser: four --flags with values, everything else positional. */
export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { positionals: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === "--repo" || token === "--out" || token === "--name") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(
          `${token} needs ${token === "--name" ? "a value" : "a directory argument"}`
        );
      }
      if (token === "--repo") parsed.repo = value;
      else if (token === "--out") parsed.out = value;
      else parsed.name = value;
    } else if (token === "--commits") {
      const value = argv[++i];
      if (value === undefined || !/^\d+$/.test(value) || Number(value) < 1) {
        throw new Error("--commits needs a positive whole number (e.g. --commits 20)");
      }
      parsed.commits = Number(value);
    } else if (token.startsWith("--")) {
      throw new Error(`unknown option "${token}"`);
    } else {
      parsed.positionals.push(token);
    }
  }
  return parsed;
}

function expectArgs(
  command: string,
  rest: string[],
  min: number,
  max: number
): void {
  if (rest.length < min || rest.length > max) {
    const expected =
      min === max ? `${min}` : max === Number.MAX_SAFE_INTEGER ? `at least ${min}` : `${min}–${max}`;
    throw new Error(
      `"${command}" takes ${expected} argument${max === 1 ? "" : "s"}, got ${rest.length}`
    );
  }
}

const defaultIo: CliIo = {
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`)
};

/** Run the CLI; returns the process exit code instead of exiting. */
export async function runCli(
  argv: string[],
  io: CliIo = defaultIo,
  env: Record<string, string | undefined> = process.env
): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    io.err(`gitiviz: ${error instanceof Error ? error.message : String(error)}`);
    io.err(USAGE);
    return 1;
  }

  const [command, ...rest] = parsed.positionals;
  const repoDir = resolve(parsed.repo ?? ".");
  const outDir = resolve(parsed.out ?? join(repoDir, ".gitiviz"));
  // Explicit display name: --name flag beats GITIVIZ_REPO_NAME (set by the
  // plugin launcher's Docker fallback, where the mount point is always
  // "/repo"). When neither is given the commands derive the name from the
  // origin remote / directory themselves.
  const explicitName =
    [parsed.name, env["GITIVIZ_REPO_NAME"]]
      .map((v) => v?.trim() ?? "")
      .find((v) => v !== "") ?? undefined;
  const named = explicitName !== undefined ? { repoName: explicitName } : {};

  if (parsed.commits !== undefined && command !== "init") {
    io.err('gitiviz: --commits is only valid for "init"');
    io.err(USAGE);
    return 1;
  }

  try {
    switch (command) {
      case "init":
        expectArgs("init", rest, 0, 0);
        await runInit({
          repoDir,
          outDir,
          commits: parsed.commits ?? DEFAULT_INIT_COMMITS,
          ...named,
          io
        });
        return 0;
      case "compare":
        expectArgs("compare", rest, 2, 2);
        await runCompare({
          repoDir,
          outDir,
          baseRef: rest[0]!,
          headRef: rest[1]!,
          ...named,
          io
        });
        return 0;
      case "branch": {
        expectArgs("branch", rest, 0, 1);
        const options: Parameters<typeof runBranch>[0] = { repoDir, outDir, ...named, io };
        if (rest[0] !== undefined) options.baseRef = rest[0];
        await runBranch(options);
        return 0;
      }
      case "commit":
        expectArgs("commit", rest, 1, 1);
        await runCommit({ repoDir, outDir, ref: rest[0]!, ...named, io });
        return 0;
      case "validate":
        expectArgs("validate", rest, 0, 0);
        await runValidate({ outDir, io });
        return 0;
      case "apply-narration":
        expectArgs("apply-narration", rest, 0, 0);
        await runApplyNarration({ outDir, ...named, io });
        return 0;
      case undefined:
        io.err("gitiviz: no command given");
        io.err(USAGE);
        return 1;
      default:
        io.err(`gitiviz: unknown command "${command}"`);
        io.err(USAGE);
        return 1;
    }
  } catch (error) {
    io.err(`gitiviz: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
