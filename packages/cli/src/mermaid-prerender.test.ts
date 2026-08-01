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
  MERMAID_CLI_IMAGE,
  MERMAID_CONFIG_FILE,
  MERMAID_DIR,
  prerenderMermaidDiagrams,
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

  it("chain (b2): renders via the mermaid-cli image and sanitizes its output", async () => {
    const outDir = await newOutDir();
    const dir = join(outDir, MERMAID_DIR);
    const calls: string[][] = [];
    const exec: ExecFn = async (command, args) => {
      calls.push([command, ...args]);
      if (args[0] === "version") return { stdout: "29.0.0", stderr: "" };
      // Stand-in for mermaid-cli: honour -o by writing a hostile-ish SVG.
      const out = args[args.indexOf("-o") + 1]!.replace("/data", dir);
      const id = args[args.indexOf("-I") + 1]!;
      await writeFile(
        out,
        `<svg id="${id}" aria-roledescription="flowchart-v2" onload="alert(1)">` +
          `<foreignObject><div>x</div></foreignObject>` +
          `<a href="https://github.com/acme/demo/blob/abc/x.ts"><text>ok</text></a>` +
          `<a href="https://evil.example/y"><text>keep? no—https passes</text></a>` +
          `<text>node label</text></svg>`,
        "utf8"
      );
      return { stdout: "", stderr: "" };
    };
    const { svgs, notes } = await prerenderMermaidDiagrams(
      SOURCES,
      { outDir },
      { localRender: noLocal, exec }
    );
    expect(svgs.size).toBe(2);
    const svg = svgs.get("u0")!.svg;
    expect(svg).not.toContain("onload");
    expect(svg.toLowerCase()).not.toContain("foreignobject");
    expect(svg).not.toContain("aria-roledescription");
    expect(svg).toContain('role="img"');
    expect(svg).toContain("node label");
    expect(notes.join("\n")).toContain(MERMAID_CLI_IMAGE);
    // The docker invocations: one probe + one run per diagram, correct image
    // and per-slot flags, id passed as the DOM id.
    const runs = calls.filter((c) => c[1] === "run");
    expect(runs).toHaveLength(2);
    for (const run of runs) {
      expect(run).toContain(MERMAID_CLI_IMAGE);
      expect(run).toContain("-c");
      expect(run).toContain(`/data/${MERMAID_CONFIG_FILE}`);
    }
    expect(runs.map((r) => r[r.indexOf("-I") + 1])).toEqual([
      "gitiviz-architecture",
      "gitiviz-u0"
    ]);
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
