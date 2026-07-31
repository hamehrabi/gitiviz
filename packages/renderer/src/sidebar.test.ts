import { describe, expect, it } from "vitest";
import { renderSidebar, sidebarCss } from "./sidebar.js";
import type { ViewTab } from "./dashboardTypes.js";

const VIEWS: readonly ViewTab[] = [
  { id: "home", label: "Home", href: "#home" },
  { id: "overview", label: "Overview", href: "#overview" },
  { id: "architecture", label: "Architecture", href: "#architecture" },
  { id: "how-it-works", label: "How it works", href: "#how-it-works" },
  { id: "more", label: "More", href: "#more" }
];

describe("renderSidebar", () => {
  it("renders all five tabs with their labels and hrefs", () => {
    const html = renderSidebar(VIEWS, "home", "gitiviz");
    expect(html.match(/class="sb-tab"/g)).toHaveLength(5);
    for (const view of VIEWS) {
      expect(html).toContain(`href="${view.href}"`);
      expect(html).toContain(`>${view.label}</a>`);
    }
  });

  it("marks exactly the active tab with the active class and aria-current", () => {
    const html = renderSidebar(VIEWS, "architecture");
    expect(html.match(/sb-item-active/g)).toHaveLength(1);
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toContain(
      `<li class="sb-item sb-item-active">` +
        `<a class="sb-tab" href="#architecture" aria-current="page">Architecture</a></li>`
    );
    // Non-active tabs carry neither marker.
    expect(html).toContain(
      `<li class="sb-item"><a class="sb-tab" href="#home">Home</a></li>`
    );
  });

  it("renders no active marker when activeId matches no view", () => {
    const html = renderSidebar(VIEWS, "nope");
    expect(html).not.toContain("sb-item-active");
    expect(html).not.toContain("aria-current");
  });

  it("is a nav landmark labeled for assistive tech", () => {
    const html = renderSidebar(VIEWS, "home");
    expect(html.startsWith(`<nav class="sb-nav" aria-label="Views">`)).toBe(true);
    expect(html.endsWith(`</nav>`)).toBe(true);
  });

  it("renders the repo wordmark when given, omits it otherwise", () => {
    expect(renderSidebar(VIEWS, "home", "acme/shop")).toContain(
      `<p class="sb-wordmark">acme/shop</p>`
    );
    expect(renderSidebar(VIEWS, "home")).not.toContain("sb-wordmark");
  });

  it("escapes a hostile repo name (repo strings are hostile input)", () => {
    const html = renderSidebar(VIEWS, "home", `<img src=x onerror=alert(1)>`);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("escapes hostile label and href on a tab", () => {
    const evil: ViewTab[] = [
      { id: "x", label: `<b>&"'`, href: `#x" onclick="alert(1)` }
    ];
    const html = renderSidebar(evil, "x");
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;b&gt;&amp;&quot;&#39;");
    expect(html).not.toContain(`href="#x" onclick=`);
    expect(html).toContain(`href="#x&quot; onclick=&quot;alert(1)"`);
  });

  it("is deterministic: identical input produces identical output", () => {
    const a = renderSidebar(VIEWS, "more", "gitiviz");
    const b = renderSidebar(VIEWS, "more", "gitiviz");
    expect(a).toBe(b);
  });

  it("contains no script or style tags (CSP: markup only)", () => {
    const html = renderSidebar(VIEWS, "home", "gitiviz");
    expect(html).not.toMatch(/<script|<style/i);
  });
});

describe("sidebarCss", () => {
  it("styles only the sb- prefix", () => {
    const selectors = sidebarCss.match(/\.[a-z-]+/g) ?? [];
    expect(selectors.length).toBeGreaterThan(0);
    for (const sel of selectors) {
      expect(sel.startsWith(".sb-")).toBe(true);
    }
  });

  it("makes the nav sticky and collapses it under 736px", () => {
    expect(sidebarCss).toContain("position:sticky");
    expect(sidebarCss).toContain("@media (max-width:736px)");
    expect(sidebarCss).toContain("overflow-x:auto");
  });

  it("has a visible keyboard focus style and an active state", () => {
    expect(sidebarCss).toContain(":focus-visible");
    expect(sidebarCss).toContain(".sb-item-active .sb-tab");
  });

  it("emits no <style> tag (integrator owns the style element)", () => {
    expect(sidebarCss).not.toContain("<style");
  });
});
