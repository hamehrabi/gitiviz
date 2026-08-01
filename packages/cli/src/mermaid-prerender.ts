/**
 * Mermaid prerender chain — how compiled diagram sources become sanitized
 * SVG in every runtime the CLI ships to (docs/decisions/0002-mermaid-render-chain.md):
 *
 *   (a) the bundled Mermaid engine — real Mermaid and its DOM, shipped
 *       inside the plugin (plugins/claude-code/scripts/mermaid-engine.mjs),
 *       rendered in-process by the renderer's deterministic pipeline. This
 *       is the DEFAULT and it works everywhere: offline, no Docker, no
 *       install, nothing to download. The links below exist only for the
 *       case where even that cannot load.
 *   (b) mermaid-cli via Docker — a secondary route:
 *       (b1) pick up fresh `<out>/mermaid/<id>.svg` files produced by an
 *            earlier mermaid-cli pass (the plugin launcher's Docker
 *            fallback runs that pass host-side between two CLI runs);
 *       (b2) with Docker reachable from this process, render ALL missing
 *            diagrams through ONE run of the official minlag/mermaid-cli
 *            image (a markdown batch — one container, one headless-browser
 *            launch, regardless of diagram count), falling back to
 *            per-diagram runs only if the batch fails.
 *       Both apply the SAME sanitation policy as (a) — via the bundled DOM
 *       when it loads, else the dependency-free text sanitizer.
 *   (c) nothing available — a genuine last resort users should never see:
 *       return no SVGs; the renderer falls back to the built-in engine with
 *       its honest caption.
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

/**
 * Batch exchange files for the single-container mermaid-cli run: every
 * missing diagram goes into ONE markdown file (one fence per diagram), so
 * ONE `docker run` — one headless-browser launch — renders them all. mmdc
 * names the outputs `<out stem>-<n>.svg` in fence order. The leading "_"
 * makes collision with slot ids impossible (SAFE_ID requires a letter
 * first). The launcher (run.sh) uses the same file names for its host-side
 * pass.
 */
export const MERMAID_BATCH_FILE = "_batch.md";
export const MERMAID_BATCH_OUT_STEM = "_batch-out";

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

/**
 * Rename a mermaid-produced SVG's root id (mmdc's batch mode always emits
 * its constant default id) to the unique per-slot DOM id, following every
 * structural reference: `id="…"` prefixes, `url(#…)` paint/marker refs,
 * `href="#…"` fragments, and the `#id` selectors of embedded <style>
 * blocks. Visible label text is never touched — replacements are anchored
 * to those markup contexts only. No-op when there is no root id or it
 * already matches.
 */
export function renameMermaidSvgId(svg: string, toId: string): string {
  const root = /<svg\b[^>]*?\bid="([A-Za-z][A-Za-z0-9_-]*)"/.exec(svg);
  if (root === null) return svg;
  const from = root[1]!;
  if (from === toId || !SAFE_ID.test(toId)) return svg;
  return svg
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/g, (block) =>
      block.replaceAll(`#${from}`, `#${toId}`)
    )
    .replaceAll(`id="${from}`, `id="${toId}`)
    .replaceAll(`url(#${from}`, `url(#${toId}`)
    .replaceAll(`href="#${from}`, `href="#${toId}`);
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

  // (a) the bundled Mermaid engine, in-process and deterministic.
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
        `mermaid: ${svgs.size} diagram(s) rendered with the bundled Mermaid engine`
      );
    }
    return { svgs, notes };
  }
  svgs.clear();
  notes.length = 0;
  notes.push(
    "mermaid: bundled Mermaid engine could not load — trying prerendered SVGs, then Docker"
  );

  // (b1) fresh SVGs already on disk (an earlier mermaid-cli pass). A batched
  // pass leaves mmdc's constant svg id — rename to the per-slot DOM id.
  let pickedUp = 0;
  for (const { id, text } of sources) {
    if (!freshOnDisk.has(id)) continue;
    const raw = await readFile(join(dir, `${id}.svg`), "utf8").catch(() => null);
    const renamed = raw === null ? null : renameMermaidSvgId(raw, `gitiviz-${id}`);
    const clean = renamed === null ? null : await sanitizeSvg(renamed, allowedOrigins);
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

    // One markdown fence per missing diagram → ONE docker run — one
    // container, one headless-browser launch — renders them all. The
    // per-diagram spawn was the multi-commit perf blowup: diagram count
    // grows with the commit range, and each container costs seconds to
    // minutes depending on the host.
    const batchText = missing
      .map(({ text }) => `\`\`\`mermaid\n${text}${text.endsWith("\n") ? "" : "\n"}\`\`\`\n`)
      .join("\n");
    await writeFile(join(dir, MERMAID_BATCH_FILE), batchText, "utf8");
    let batchOk = true;
    try {
      await exec("docker", [
        "run",
        "--rm",
        "-v",
        `${dir}:/data`,
        MERMAID_CLI_IMAGE,
        "-q",
        "-i",
        `/data/${MERMAID_BATCH_FILE}`,
        "-o",
        `/data/${MERMAID_BATCH_OUT_STEM}.md`,
        "-c",
        `/data/${MERMAID_CONFIG_FILE}`,
        "-b",
        "transparent"
      ]);
    } catch (error) {
      batchOk = false;
      notes.push(
        `mermaid: batched mermaid-cli run failed ` +
          `(${error instanceof Error ? error.message : String(error)}) — ` +
          `retrying per-diagram`
      );
    }
    if (batchOk) {
      for (const [index, { id, text }] of missing.entries()) {
        const outPath = join(dir, `${MERMAID_BATCH_OUT_STEM}-${index + 1}.svg`);
        const raw = await readFile(outPath, "utf8").catch(() => null);
        const renamed = raw === null ? null : renameMermaidSvgId(raw, `gitiviz-${id}`);
        const clean = renamed === null ? null : await sanitizeSvg(renamed, allowedOrigins);
        if (renamed !== null && clean !== null) {
          // Persist per-slot so the next run's (b1) freshness pass skips it.
          await writeFile(join(dir, `${id}.svg`), renamed, "utf8");
          svgs.set(id, { text, svg: clean });
          rendered += 1;
        } else {
          notes.push(`mermaid: mermaid-cli produced no svg for "${id}" — built-in fallback`);
        }
      }
      const junk = missing.map(
        (_, index) => join(dir, `${MERMAID_BATCH_OUT_STEM}-${index + 1}.svg`)
      );
      junk.push(join(dir, MERMAID_BATCH_FILE), join(dir, `${MERMAID_BATCH_OUT_STEM}.md`));
      for (const path of junk) await rm(path, { force: true });
    } else {
      // A diagram that breaks the whole batch (mmdc stops at the first bad
      // fence) must not take the others down: render one container per
      // diagram, exactly as before the batching.
      await rm(join(dir, MERMAID_BATCH_FILE), { force: true });
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
    }
    if (rendered > 0) {
      notes.push(`mermaid: ${rendered} diagram(s) rendered via Docker ${MERMAID_CLI_IMAGE}`);
    }
  }
  return { svgs, notes };
}
