/**
 * Mermaid prerender chain — how compiled diagram sources become sanitized
 * SVG in every runtime the CLI ships to (docs/decisions/0002-mermaid-render-chain.md):
 *
 *   (a) local toolchain — mermaid + jsdom importable (the dev/Docker
 *       toolchain, where node_modules are present): render in-process via
 *       the renderer's deterministic pipeline.
 *   (b) mermaid-cli via Docker — the committed dependency-free bundle
 *       cannot ship jsdom/mermaid, so:
 *       (b1) pick up fresh `<out>/mermaid/<id>.svg` files produced by an
 *            earlier mermaid-cli pass (the plugin launcher's Docker
 *            fallback runs that pass host-side between two CLI runs);
 *       (b2) with Docker reachable from this process, render each missing
 *            diagram through the official minlag/mermaid-cli image.
 *       Both apply the SAME sanitation policy as (a) — via jsdom when
 *       importable, else the dependency-free text sanitizer.
 *   (c) nothing available — return no SVGs; the renderer falls back to the
 *       built-in engine with its honest caption.
 *
 * Sources are always written to `<out>/mermaid/<id>.mmd` (plus the shared
 * mermaid-config.json) so the launcher's host-side mermaid-cli pass has
 * exact inputs. A disk SVG is used ONLY when the .mmd it was rendered from
 * byte-matches the freshly compiled source — stale SVGs are deleted.
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  MERMAID_RENDER_CONFIG,
  renderMermaidDiagram,
  sanitizeMermaidSvg,
  sanitizeMermaidSvgText,
  type MermaidRenderResult,
  type MermaidSource,
  type PrerenderedDiagram
} from "@gitiviz/renderer";

/** Subdirectory of the out dir holding the .mmd/.svg exchange files. */
export const MERMAID_DIR = "mermaid";

/** Shared engine configuration, written next to the sources for mermaid-cli. */
export const MERMAID_CONFIG_FILE = "mermaid-config.json";

/** The official mermaid-cli image used for chain link (b2). */
export const MERMAID_CLI_IMAGE = "minlag/mermaid-cli";

/** Diagram slot ids double as file names and DOM ids — same shape as both. */
const SAFE_ID = /^[A-Za-z][A-Za-z0-9_-]*$/;

const execFileAsync = promisify(execFile);

export type ExecFn = (
  command: string,
  args: string[]
) => Promise<{ stdout: string; stderr: string }>;

const defaultExec: ExecFn = async (command, args) =>
  execFileAsync(command, args, { maxBuffer: 16 * 1024 * 1024 });

export interface PrerenderOptions {
  /** The gitiviz out dir; sources land in `<outDir>/mermaid/`. */
  outDir: string;
  /** Origins allowed for http: hrefs (https: always passes). */
  allowedOrigins?: readonly string[];
}

/** Injectable seams for unit tests — production callers pass nothing. */
export interface PrerenderDeps {
  /** In-process renderer (chain a). Defaults to the renderer library's. */
  localRender?: (
    domId: string,
    text: string,
    options: { allowedOrigins?: readonly string[] }
  ) => Promise<MermaidRenderResult>;
  /** Process runner for the docker probe and mermaid-cli runs (chain b2). */
  exec?: ExecFn;
}

export interface PrerenderOutcome {
  /** Sanitized SVG per diagram slot id, ready for RenderOptions.mermaid. */
  svgs: Map<string, PrerenderedDiagram>;
  /** Honest, printable notes about which chain link did the work. */
  notes: string[];
}

/** Sanitize with the jsdom sanitizer when importable, else the text one. */
async function sanitizeSvg(
  svg: string,
  allowedOrigins: readonly string[]
): Promise<string | null> {
  try {
    return await sanitizeMermaidSvg(svg, { allowedOrigins });
  } catch {
    return sanitizeMermaidSvgText(svg, { allowedOrigins });
  }
}

function isEnvUnavailable(result: MermaidRenderResult): boolean {
  return !result.ok && result.reason.startsWith("mermaid environment unavailable");
}

/** Run the chain over every diagram source. Never throws — fails soft. */
export async function prerenderMermaidDiagrams(
  sources: readonly MermaidSource[],
  options: PrerenderOptions,
  deps: PrerenderDeps = {}
): Promise<PrerenderOutcome> {
  const localRender = deps.localRender ?? renderMermaidDiagram;
  const exec = deps.exec ?? defaultExec;
  const allowedOrigins = options.allowedOrigins ?? [];
  const svgs = new Map<string, PrerenderedDiagram>();
  const notes: string[] = [];
  if (sources.length === 0) return { svgs, notes };

  // Exchange dir: sources + config out, freshness of existing SVGs noted.
  const dir = join(options.outDir, MERMAID_DIR);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, MERMAID_CONFIG_FILE),
    `${JSON.stringify(MERMAID_RENDER_CONFIG, null, 2)}\n`,
    "utf8"
  );
  const freshOnDisk = new Set<string>();
  for (const { id, text } of sources) {
    if (!SAFE_ID.test(id)) continue;
    const mmdPath = join(dir, `${id}.mmd`);
    const svgPath = join(dir, `${id}.svg`);
    const previous = await readFile(mmdPath, "utf8").catch(() => null);
    const svgExists = await readFile(svgPath, "utf8").then(
      () => true,
      () => false
    );
    if (previous === text && svgExists) {
      freshOnDisk.add(id);
    } else {
      if (svgExists) await rm(svgPath, { force: true });
      await writeFile(mmdPath, text, "utf8");
    }
  }

  // (a) local mermaid + jsdom, in-process and deterministic.
  let localAvailable = true;
  for (const { id, text } of sources) {
    if (!SAFE_ID.test(id)) continue;
    const result = await localRender(`gitiviz-${id}`, text, { allowedOrigins });
    if (isEnvUnavailable(result)) {
      localAvailable = false;
      break;
    }
    if (result.ok) {
      svgs.set(id, { text, svg: result.svg });
    } else {
      notes.push(
        `mermaid: diagram "${id}" failed to render (${result.reason}) — built-in fallback`
      );
    }
  }
  if (localAvailable) {
    if (svgs.size > 0) {
      notes.unshift(
        `mermaid: ${svgs.size} diagram(s) rendered with the local Mermaid toolchain`
      );
    }
    return { svgs, notes };
  }
  svgs.clear();
  notes.length = 0;
  notes.push(
    "mermaid: local mermaid/jsdom not installed — trying prerendered SVGs, then Docker"
  );

  // (b1) fresh SVGs already on disk (an earlier mermaid-cli pass).
  let pickedUp = 0;
  for (const { id, text } of sources) {
    if (!freshOnDisk.has(id)) continue;
    const raw = await readFile(join(dir, `${id}.svg`), "utf8").catch(() => null);
    const clean = raw === null ? null : await sanitizeSvg(raw, allowedOrigins);
    if (clean !== null) {
      svgs.set(id, { text, svg: clean });
      pickedUp += 1;
    }
  }
  if (pickedUp > 0) {
    notes.push(`mermaid: ${pickedUp} prerendered SVG(s) picked up from ${dir}`);
  }

  // (b2) render whatever is still missing via the mermaid-cli image.
  const missing = sources.filter((s) => SAFE_ID.test(s.id) && !svgs.has(s.id));
  if (missing.length > 0) {
    const dockerUp = await exec("docker", [
      "version",
      "--format",
      "{{.Server.Version}}"
    ]).then(
      () => true,
      () => false
    );
    if (!dockerUp) {
      notes.push(
        "mermaid: Docker unavailable — remaining diagrams use the built-in fallback engine"
      );
      return { svgs, notes };
    }
    let rendered = 0;
    for (const { id, text } of missing) {
      try {
        await exec("docker", [
          "run",
          "--rm",
          "-v",
          `${dir}:/data`,
          MERMAID_CLI_IMAGE,
          "-q",
          "-i",
          `/data/${id}.mmd`,
          "-o",
          `/data/${id}.svg`,
          "-c",
          `/data/${MERMAID_CONFIG_FILE}`,
          "-I",
          `gitiviz-${id}`,
          "-b",
          "transparent"
        ]);
        const raw = await readFile(join(dir, `${id}.svg`), "utf8");
        const clean = await sanitizeSvg(raw, allowedOrigins);
        if (clean !== null) {
          svgs.set(id, { text, svg: clean });
          rendered += 1;
        }
      } catch (error) {
        notes.push(
          `mermaid: mermaid-cli failed for "${id}" ` +
            `(${error instanceof Error ? error.message : String(error)}) — built-in fallback`
        );
      }
    }
    if (rendered > 0) {
      notes.push(`mermaid: ${rendered} diagram(s) rendered via Docker ${MERMAID_CLI_IMAGE}`);
    }
  }
  return { svgs, notes };
}
