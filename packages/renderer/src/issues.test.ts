import { describe, expect, it } from "vitest";
import { Window } from "happy-dom";
import { issuesCss, renderIssuesList, type IssueModel } from "./issues.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function demoIssue(overrides: Partial<IssueModel> = {}): IssueModel {
  return {
    number: 12,
    title: "Guest checkout drops the cart on refresh",
    state: "OPEN",
    url: "https://github.com/acme/demo/issues/12",
    createdAt: "2026-07-30T09:15:00Z",
    ...overrides
  };
}

/** links.origin is the repo web URL, exactly as the CLI passes it. */
const LINKS = { origin: "https://github.com/acme/demo" };

function parse(html: string) {
  const window = new Window();
  window.document.body.innerHTML = html;
  return window.document;
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

describe("renderIssuesList empty state", () => {
  it("shows the exact no-tickets copy plus the honest gh mechanism line", () => {
    const doc = parse(renderIssuesList([]));
    expect(doc.querySelector(".iv-empty")!.textContent).toBe(
      "No tickets yet — create one from any commit page."
    );
    const note = doc.querySelector(".iv-empty-note")!;
    expect(note.textContent).toContain("GitHub issues");
    expect(note.textContent).toContain("gitiviz");
    expect(note.textContent).toContain("gh");
    expect(doc.querySelectorAll(".iv-card").length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

describe("renderIssuesList cards", () => {
  it("shows #number, a state pill, the yyyy-mm-dd date, and the title", () => {
    const doc = parse(renderIssuesList([demoIssue()]));
    const card = doc.querySelector(".iv-card")!;
    expect(card.querySelector(".iv-number")!.textContent).toBe("#12");
    const pill = card.querySelector(".iv-state")!;
    expect(pill.textContent).toBe("open");
    expect(pill.classList.contains("iv-state-open")).toBe(true);
    // Date is a string slice of the ISO timestamp — no Date object.
    expect(card.querySelector(".iv-date")!.textContent).toBe("2026-07-30");
    expect(card.querySelector(".iv-title")!.textContent).toBe(
      "Guest checkout drops the cart on refresh"
    );
  });

  it("renders cards in the order given", () => {
    const doc = parse(
      renderIssuesList([
        demoIssue({ number: 3, title: "Third" }),
        demoIssue({ number: 1, title: "First" })
      ])
    );
    const titles = Array.from(doc.querySelectorAll(".iv-title")).map(
      (t) => t.textContent
    );
    expect(titles).toEqual(["Third", "First"]);
  });

  it("normalizes recognized states and pills open/closed distinctly", () => {
    const doc = parse(
      renderIssuesList([
        demoIssue({ state: "OPEN" }),
        demoIssue({ number: 13, state: "CLOSED" })
      ])
    );
    const pills = Array.from(doc.querySelectorAll(".iv-state"));
    expect(pills.map((p) => p.textContent)).toEqual(["open", "closed"]);
    expect(pills[0]!.classList.contains("iv-state-open")).toBe(true);
    expect(pills[1]!.classList.contains("iv-state-closed")).toBe(true);
  });

  it("shows an unrecognized state as escaped text with the other pill class", () => {
    const doc = parse(renderIssuesList([demoIssue({ state: "not planned" })]));
    const pill = doc.querySelector(".iv-state")!;
    expect(pill.textContent).toBe("not planned");
    expect(pill.classList.contains("iv-state-other")).toBe(true);
    expect(pill.classList.contains("iv-state-open")).toBe(false);
  });

  it("omits the date span when createdAt is empty", () => {
    const doc = parse(renderIssuesList([demoIssue({ createdAt: "" })]));
    expect(doc.querySelector(".iv-date")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Link policy: safeUrl + exact repo-origin match, else a linkless div
// ---------------------------------------------------------------------------

describe("renderIssuesList link policy", () => {
  it("links a card only when the url passes safeUrl and matches the repo origin", () => {
    const doc = parse(renderIssuesList([demoIssue()], LINKS));
    const link = doc.querySelector("a.iv-card")!;
    expect(link).not.toBeNull();
    expect(link.getAttribute("href")).toBe("https://github.com/acme/demo/issues/12");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener");
  });

  it("stays a linkless div without a configured repo origin", () => {
    const doc = parse(renderIssuesList([demoIssue()]));
    expect(doc.querySelector("a.iv-card")).toBeNull();
    const card = doc.querySelector("div.iv-card")!;
    expect(card).not.toBeNull();
    expect(card.textContent).toContain("Guest checkout drops the cart on refresh");
  });

  it("refuses an https url on any other origin", () => {
    const doc = parse(
      renderIssuesList(
        [demoIssue({ url: "https://evil.example/acme/demo/issues/12" })],
        LINKS
      )
    );
    expect(doc.querySelector("a.iv-card")).toBeNull();
    expect(doc.querySelector("div.iv-card")).not.toBeNull();
  });

  it("refuses javascript:, data:, and malformed urls outright", () => {
    for (const url of ["javascript:alert(1)", "data:text/html,x", "not a url"]) {
      const html = renderIssuesList([demoIssue({ url })], LINKS);
      expect(html).not.toContain("href");
      expect(parse(html).querySelector("a")).toBeNull();
    }
  });

  it("admits http only for an explicitly allowed origin that IS the repo origin", () => {
    const issue = demoIssue({ url: "http://git.internal/acme/demo/issues/12" });
    const refused = parse(
      renderIssuesList([issue], { origin: "http://git.internal/acme/demo" })
    );
    expect(refused.querySelector("a.iv-card")).toBeNull();
    const admitted = parse(
      renderIssuesList([issue], {
        origin: "http://git.internal/acme/demo",
        allowedOrigins: ["http://git.internal"]
      })
    );
    expect(admitted.querySelector("a.iv-card")).not.toBeNull();
    // Allowlisting an http origin never links urls on a DIFFERENT origin.
    const crossOrigin = parse(
      renderIssuesList([demoIssue({ url: "http://other.internal/x" })], {
        origin: "http://git.internal/acme/demo",
        allowedOrigins: ["http://git.internal", "http://other.internal"]
      })
    );
    expect(crossOrigin.querySelector("a.iv-card")).toBeNull();
  });

  it("survives a malformed configured origin without linking or throwing", () => {
    const doc = parse(renderIssuesList([demoIssue()], { origin: "not a url" }));
    expect(doc.querySelector("a.iv-card")).toBeNull();
    expect(doc.querySelector("div.iv-card")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Escaping (issues.json strings are hostile input)
// ---------------------------------------------------------------------------

describe("renderIssuesList escaping", () => {
  const hostile = (): IssueModel =>
    demoIssue({
      title: '<img src=x onerror=alert(1)>',
      state: 'open"><script>alert(2)</script>',
      createdAt: '"><svg onload=x>'
    });

  it("never lets issue strings become markup", () => {
    const html = renderIssuesList([hostile()], LINKS);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<svg");
    const doc = parse(html);
    expect(doc.querySelector("img")).toBeNull();
    expect(doc.querySelector("script")).toBeNull();
  });

  it("round-trips hostile text as visible text content", () => {
    const doc = parse(renderIssuesList([hostile()]));
    expect(doc.querySelector(".iv-title")!.textContent).toBe(
      "<img src=x onerror=alert(1)>"
    );
    expect(doc.querySelector(".iv-state")!.textContent).toBe(
      'open"><script>alert(2)</script>'
    );
    // The hostile "date" is sliced to 10 chars then escaped — inert text.
    expect(doc.querySelector(".iv-date")!.textContent).toBe('"><svg onl');
  });

  it("escapes the validated href at the point of output", () => {
    const doc = parse(
      renderIssuesList(
        [demoIssue({ url: "https://github.com/acme/demo/issues/12?a=1&b=2" })],
        LINKS
      )
    );
    expect(doc.querySelector("a.iv-card")!.getAttribute("href")).toBe(
      "https://github.com/acme/demo/issues/12?a=1&b=2"
    );
  });
});

// ---------------------------------------------------------------------------
// Determinism and CSS discipline
// ---------------------------------------------------------------------------

describe("issues output discipline", () => {
  it("is deterministic: identical input produces byte-identical output", () => {
    const render = () => renderIssuesList([demoIssue()], LINKS);
    expect(render()).toBe(render());
  });

  it("emits no <style> or <script> tags of its own", () => {
    const html = renderIssuesList([demoIssue()], LINKS);
    expect(html).not.toContain("<style");
    expect(html).not.toContain("<script");
  });

  it("scopes every CSS class selector to the iv- prefix", () => {
    const selectors = issuesCss.match(/\.[A-Za-z][\w-]*/g) ?? [];
    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors) {
      expect(selector.startsWith(".iv-")).toBe(true);
    }
  });

  it("keeps issuesCss free of scripts and external references", () => {
    expect(issuesCss).not.toContain("url(");
    expect(issuesCss).not.toContain("@import");
    expect(issuesCss).not.toContain("javascript:");
    expect(issuesCss).not.toContain("<style");
  });
});
