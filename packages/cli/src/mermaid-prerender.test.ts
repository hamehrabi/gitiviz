/**
 * Prerender chain tests. Chain link (a) runs the REAL renderer pipeline
 * (mermaid + jsdom are installed in the dev container); links (b1)/(b2)
 * are driven through the injectable seams: a localRender stub that reports
 * the environment unavailable and an exec stub standing in for Docker.
 */
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { MermaidRenderResult, MermaidSource } from "@gitiviz/renderer";
import {
  MERMAID_BATCH_FILE,
  MERMAID_BATCH_OUT_STEM,
  MERMAID_CLI_IMAGE,
  MERMAID_CONFIG_FILE,
  MERMAID_DIR,
  prerenderMermaidDiagrams,
  renameMermaidSvgId,
  type ExecFn
} from "./mermaid-prerender.js";

const SOURCES: MermaidSource[] = [
  { id: "architecture", text: 'flowchart TD\n\nn0["App<br/>entry"]\n' },
  { id: "u0", text: 'flowchart TD\n\nn0["Service<br/>updated · 1 change"]\n' }
];

const ENV_UNAVAILABLE: MermaidRenderResult = {
  ok: false,
  reason: "mermaid environment unavailable: Cannot find package 'jsdom'"
};

async function newOutDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "gitiviz-mermaid-"));
}

const noLocal = async (): Promise<MermaidRenderResult> => ENV_UNAVAILABLE;

const noDocker: ExecFn = async () => {
  throw new Error("docker: command not found");
};

describe("prerenderMermaidDiagrams", () => {
  it("always writes the .mmd sources and the shared mermaid config", async () => {
    const outDir = await newOutDir();
    await prerenderMermaidDiagrams(SOURCES, { outDir }, { localRender: noLocal, exec: noDocker });
    const dir = join(outDir, MERMAID_DIR);
    expect(await readFile(join(dir, "architecture.mmd"), "utf8")).toBe(SOURCES[0]!.text);
    expect(await readFile(join(dir, "u0.mmd"), "utf8")).toBe(SOURCES[1]!.text);
    const config = JSON.parse(await readFile(join(dir, MERMAID_CONFIG_FILE), "utf8")) as {
      securityLevel: string;
      htmlLabels: boolean;
      flowchart: { htmlLabels: boolean };
    };
    expect(config.securityLevel).toBe("strict");
    expect(config.htmlLabels).toBe(false);
    expect(config.flowchart.htmlLabels).toBe(false);
  });

  it("chain (a): renders in-process with the real local toolchain", async () => {
    const outDir = await newOutDir();
    const { svgs, notes } = await prerenderMermaidDiagrams(SOURCES, { outDir });
    expect(svgs.size).toBe(2);
    expect(svgs.get("architecture")!.svg.startsWith("<svg")).toBe(true);
    expect(svgs.get("architecture")!.text).toBe(SOURCES[0]!.text);
    expect(notes.join("\n")).toContain("local Mermaid toolchain");
  });

  it("chain (b1): picks up fresh disk SVGs, sanitized", async () => {
    const outDir = await newOutDir();
    const dir = join(outDir, MERMAID_DIR);
    // Simulate an earlier mermaid-cli pass: sources on disk match, SVGs exist.
    await prerenderMermaidDiagrams(SOURCES, { outDir }, { localRender: noLocal, exec: noDocker });
    await writeFile(
      join(dir, "architecture.svg"),
      `<svg id="gitiviz-architecture"><script>alert(1)</script>` +
        `<a href="https://github.com/acme/demo/blob/abc/x.ts"><text>App</text></a>` +
        `<a href="javascript:alert(2)"><text>bad</text></a></svg>`,
      "utf8"
    );
    const { svgs, notes } = await prerenderMermaidDiagrams(
      SOURCES,
      { outDir },
      { localRender: noLocal, exec: noDocker }
    );
    expect(svgs.has("architecture")).toBe(true);
    const svg = svgs.get("architecture")!.svg;
    expect(svg).not.toContain("<script");
    expect(svg).not.toContain("javascript:");
    expect(svg).toContain('href="https://github.com/acme/demo/blob/abc/x.ts"');
    expect(svgs.has("u0")).toBe(false); // no svg on disk, no docker
    expect(notes.join("\n")).toContain("picked up");
  });

  it("chain (b1): ignores stale disk SVGs whose source changed", async () => {
    const outDir = await newOutDir();
    const dir = join(outDir, MERMAID_DIR);
    await prerenderMermaidDiagrams(SOURCES, { outDir }, { localRender: noLocal, exec: noDocker });
    await writeFile(join(dir, "architecture.svg"), "<svg><text>old</text></svg>", "utf8");
    const changed: MermaidSource[] = [
      { id: "architecture", text: 'flowchart TD\n\nn0["Changed<br/>entry"]\n' }
    ];
    const { svgs } = await prerenderMermaidDiagrams(
      changed,
      { outDir },
      { localRender: noLocal, exec: noDocker }
    );
    expect(svgs.size).toBe(0);
    // The stale svg is gone and the source file now holds the new text.
    await expect(readFile(join(dir, "architecture.svg"), "utf8")).rejects.toThrow();
    expect(await readFile(join(dir, "architecture.mmd"), "utf8")).toBe(changed[0]!.text);
  });

  /**
   * Stand-in for a successful batched mermaid-cli run: reads the batch
   * markdown the CLI wrote, and writes one `<stem>-N.svg` per mermaid fence
   * (mmdc's naming), each with mmdc's default constant svg id.
   */
  function batchExec(dir: string, calls: string[][]): ExecFn {
    return async (command, args) => {
      calls.push([command, ...args]);
      if (args[0] === "version") return { stdout: "29.0.0", stderr: "" };
      const input = args[args.indexOf("-i") + 1]!;
      expect(input).toBe(`/data/${MERMAID_BATCH_FILE}`);
      const batch = await readFile(join(dir, MERMAID_BATCH_FILE), "utf8");
      const fences = batch.split("```mermaid").length - 1;
      for (let n = 1; n <= fences; n++) {
        await writeFile(
          join(dir, `${MERMAID_BATCH_OUT_STEM}-${n}.svg`),
          `<svg id="my-svg" aria-roledescription="flowchart-v2" onload="alert(1)">` +
            `<style>#my-svg{font-family:sans-serif;}#my-svg .node{fill:#fff;}</style>` +
            `<foreignObject><div>x</div></foreignObject>` +
            `<a href="https://github.com/acme/demo/blob/abc/x.ts"><text>ok</text></a>` +
            `<rect fill="url(#my-svg-gradient)"/>` +
            `<text>node label ${n}</text></svg>`,
          "utf8"
        );
      }
      return { stdout: "", stderr: "" };
    };
  }

  it("chain (b2): renders every missing diagram in ONE mermaid-cli container and sanitizes", async () => {
    const outDir = await newOutDir();
    const dir = join(outDir, MERMAID_DIR);
    const calls: string[][] = [];
    const { svgs, notes } = await prerenderMermaidDiagrams(
      SOURCES,
      { outDir },
      { localRender: noLocal, exec: batchExec(dir, calls) }
    );
    expect(svgs.size).toBe(2);
    const svg = svgs.get("u0")!.svg;
    expect(svg).not.toContain("onload");
    expect(svg.toLowerCase()).not.toContain("foreignobject");
    expect(svg).not.toContain("aria-roledescription");
    expect(svg).toContain('role="img"');
    expect(svg).toContain("node label 2");
    // Each slot's svg id is renamed from mmdc's constant to the unique
    // per-slot DOM id (scoped styles and url(#) refs follow).
    expect(svg).toContain('id="gitiviz-u0"');
    expect(svg).toContain("#gitiviz-u0 .node");
    expect(svg).toContain("url(#gitiviz-u0-gradient)");
    expect(svg).not.toContain("my-svg");
    expect(svgs.get("architecture")!.svg).toContain('id="gitiviz-architecture"');
    expect(notes.join("\n")).toContain(MERMAID_CLI_IMAGE);
    // Bounded docker use: one probe + ONE batched run — never one per diagram.
    expect(calls).toHaveLength(2);
    const run = calls[1]!;
    expect(run[1]).toBe("run");
    expect(run).toContain(MERMAID_CLI_IMAGE);
    expect(run).toContain(`/data/${MERMAID_CONFIG_FILE}`);
    // Per-slot svgs persist for later fresh pickups; batch files are gone.
    expect(await readFile(join(dir, "u0.svg"), "utf8")).toContain('id="gitiviz-u0"');
    await expect(readFile(join(dir, MERMAID_BATCH_FILE), "utf8")).rejects.toThrow();
    await expect(
      readFile(join(dir, `${MERMAID_BATCH_OUT_STEM}-1.svg`), "utf8")
    ).rejects.toThrow();
  });

  it("REGRESSION: docker exec calls stay bounded (2) no matter how many diagrams", async () => {
    // The 50-minute multi-commit blowup was one docker+Chromium spawn per
    // diagram (diagram count grows with the commit range). The container
    // spawn is the expensive primitive: assert its call count is constant.
    const outDir = await newOutDir();
    const dir = join(outDir, MERMAID_DIR);
    const many: MermaidSource[] = Array.from({ length: 24 }, (_, i) => ({
      id: `u${i}`,
      text: `flowchart TD\n\nn0["Unit ${i}"]\n`
    }));
    const calls: string[][] = [];
    const { svgs } = await prerenderMermaidDiagrams(
      many,
      { outDir },
      { localRender: noLocal, exec: batchExec(dir, calls) }
    );
    expect(svgs.size).toBe(24);
    expect(calls).toHaveLength(2); // 1 docker probe + 1 batched render — bounded
  });

  it("chain (b2): falls back to per-diagram renders when the batch run fails", async () => {
    const outDir = await newOutDir();
    const dir = join(outDir, MERMAID_DIR);
    const calls: string[][] = [];
    const exec: ExecFn = async (command, args) => {
      calls.push([command, ...args]);
      if (args[0] === "version") return { stdout: "29.0.0", stderr: "" };
      const input = args[args.indexOf("-i") + 1]!;
      if (input === `/data/${MERMAID_BATCH_FILE}`) {
        throw new Error("one fence failed to parse");
      }
      // Per-diagram call: honour -o and -I like the real mmdc.
      const out = args[args.indexOf("-o") + 1]!.replace("/data", dir);
      const id = args[args.indexOf("-I") + 1]!;
      await writeFile(out, `<svg id="${id}"><text>ok</text></svg>`, "utf8");
      return { stdout: "", stderr: "" };
    };
    const { svgs, notes } = await prerenderMermaidDiagrams(
      SOURCES,
      { outDir },
      { localRender: noLocal, exec }
    );
    expect(svgs.size).toBe(2);
    expect(svgs.get("architecture")!.svg).toContain('id="gitiviz-architecture"');
    const perDiagram = calls.filter((c) => c.includes("-I"));
    expect(perDiagram.map((r) => r[r.indexOf("-I") + 1])).toEqual([
      "gitiviz-architecture",
      "gitiviz-u0"
    ]);
    expect(notes.join("\n")).toContain("per-diagram");
  });

  it("chain (b1): renames mmdc's constant svg id to the per-slot DOM id on pickup", async () => {
    const outDir = await newOutDir();
    const dir = join(outDir, MERMAID_DIR);
    await prerenderMermaidDiagrams(SOURCES, { outDir }, { localRender: noLocal, exec: noDocker });
    // A batched launcher pass leaves mmdc's default id on disk.
    await writeFile(
      join(dir, "architecture.svg"),
      `<svg id="my-svg"><style>#my-svg{fill:red;}</style><text>App</text></svg>`,
      "utf8"
    );
    const { svgs } = await prerenderMermaidDiagrams(
      SOURCES,
      { outDir },
      { localRender: noLocal, exec: noDocker }
    );
    const svg = svgs.get("architecture")!.svg;
    expect(svg).toContain('id="gitiviz-architecture"');
    expect(svg).toContain("#gitiviz-architecture{fill:red;}");
  });

  it("chain (c): no local toolchain, no docker — empty result, honest notes", async () => {
    const outDir = await newOutDir();
    const { svgs, notes } = await prerenderMermaidDiagrams(
      SOURCES,
      { outDir },
      { localRender: noLocal, exec: noDocker }
    );
    expect(svgs.size).toBe(0);
    expect(notes.join("\n")).toContain("Docker unavailable");
  });

  it("passes allowedOrigins through to sanitation on the disk path", async () => {
    const outDir = await newOutDir();
    const dir = join(outDir, MERMAID_DIR);
    await prerenderMermaidDiagrams(SOURCES, { outDir }, { localRender: noLocal, exec: noDocker });
    await writeFile(
      join(dir, "u0.svg"),
      `<svg><a href="http://git.internal/x"><text>a</text></a>` +
        `<a href="http://other.host/y"><text>b</text></a></svg>`,
      "utf8"
    );
    const { svgs } = await prerenderMermaidDiagrams(
      SOURCES,
      { outDir, allowedOrigins: ["http://git.internal"] },
      { localRender: noLocal, exec: noDocker }
    );
    const svg = svgs.get("u0")!.svg;
    expect(svg).toContain('href="http://git.internal/x"');
    expect(svg).not.toContain("other.host");
  });

  describe("renameMermaidSvgId", () => {
    it("renames the root id, id prefixes, url(#) refs, href fragments, and style selectors", () => {
      const svg =
        `<svg id="my-svg"><style>#my-svg .edge{stroke:#000;}#my-svg{color:red;}</style>` +
        `<marker id="my-svg_flowchart-v2-pointEnd"/><rect fill="url(#my-svg-gradient)"/>` +
        `<path marker-end="url(#my-svg_flowchart-v2-pointEnd)"/>` +
        `<a href="#my-svg-node-1"><text>go</text></a></svg>`;
      const out = renameMermaidSvgId(svg, "gitiviz-u3");
      expect(out).toContain('id="gitiviz-u3"');
      expect(out).toContain('id="gitiviz-u3_flowchart-v2-pointEnd"');
      expect(out).toContain('fill="url(#gitiviz-u3-gradient)"');
      expect(out).toContain('marker-end="url(#gitiviz-u3_flowchart-v2-pointEnd)"');
      expect(out).toContain('href="#gitiviz-u3-node-1"');
      expect(out).toContain("#gitiviz-u3 .edge");
      expect(out).toContain("#gitiviz-u3{color:red;}");
      expect(out).not.toContain("my-svg");
    });

    it("leaves visible label text alone, even when it mentions the old id", () => {
      const svg =
        `<svg id="my-svg"><style>#my-svg{color:red;}</style>` +
        `<text>fix #my-svg and my-svg quirks</text></svg>`;
      const out = renameMermaidSvgId(svg, "gitiviz-u0");
      expect(out).toContain("<text>fix #my-svg and my-svg quirks</text>");
      expect(out).toContain('id="gitiviz-u0"');
    });

    it("is a no-op when the id already matches or no root id exists", () => {
      const already = `<svg id="gitiviz-u0"><text>x</text></svg>`;
      expect(renameMermaidSvgId(already, "gitiviz-u0")).toBe(already);
      const bare = `<svg><text>x</text></svg>`;
      expect(renameMermaidSvgId(bare, "gitiviz-u0")).toBe(bare);
    });
  });

  it("skips ids that are not filename/DOM-id safe", async () => {
    const outDir = await newOutDir();
    const { svgs } = await prerenderMermaidDiagrams(
      [{ id: "../escape", text: "flowchart TD\n" }],
      { outDir },
      { localRender: noLocal, exec: noDocker }
    );
    expect(svgs.size).toBe(0);
    await expect(
      readFile(join(outDir, MERMAID_DIR, "../escape.mmd"), "utf8")
    ).rejects.toThrow();
  });
});
