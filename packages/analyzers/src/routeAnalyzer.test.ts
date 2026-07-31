import { describe, it, expect } from "vitest";
import { routeAnalyzer } from "./routeAnalyzer.js";

/**
 * Verbatim copy of the demo fixture's src/routes/orders.ts on the feature
 * branch (packages/test-fixtures/src/demoApp.ts ROUTES_V2): the fixture does
 * not export its file contents, so the analyzer contract is pinned against
 * this inline mirror.
 */
const DEMO_ROUTES = `import express from "express";
import { createOrder, getOrder } from "../services/orderService";
import { isValidGuestEmail } from "../validation/guest";

export const app = express();
app.use(express.json());

app.post("/orders", (req, res) => {
  const { customerId, items, totalCents } = req.body;
  const order = createOrder(customerId, items, totalCents);
  res.status(201).json(order);
});

app.get("/orders/:id", (req, res) => {
  const order = getOrder(req.params.id);
  if (!order) {
    res.status(404).end();
    return;
  }
  res.json(order);
});

app.post("/orders/guest", (req, res) => {
  const { guestEmail, items, totalCents } = req.body;
  if (!isValidGuestEmail(guestEmail)) {
    res.status(400).json({ error: "invalid guest email" });
    return;
  }
  const order = createOrder(\`guest:\${guestEmail}\`, items, totalCents);
  res.status(201).json(order);
});
`;

describe("routeAnalyzer.appliesTo", () => {
  it("matches JS/TS source files", () => {
    for (const p of ["src/routes/orders.ts", "src/App.tsx", "lib/api.js", "run.mjs", "run.cjs"]) {
      expect(routeAnalyzer.appliesTo(p), p).toBe(true);
    }
  });

  it("does not match non-JS files", () => {
    for (const p of ["package.json", "README.md", "schema.sql", "routes.py", ".ts"]) {
      expect(routeAnalyzer.appliesTo(p), p).toBe(false);
    }
  });
});

describe("routeAnalyzer.analyze — demo fixture routes", () => {
  it("has a versioned id for cache keys", () => {
    expect(routeAnalyzer.id).toBe("js-express-route@1");
  });

  it("extracts the demo fixture's routes with method, path and line anchors", () => {
    const result = routeAnalyzer.analyze({ path: "src/routes/orders.ts", content: DEMO_ROUTES });
    const routes = result.facts.filter((f) => f.kind === "route");
    expect(routes.map((f) => [f.value.method, f.value.path])).toEqual([
      ["POST", "/orders"],
      ["GET", "/orders/:id"],
      ["POST", "/orders/guest"]
    ]);
    expect(routes[0]!.anchor).toEqual({ path: "src/routes/orders.ts", startLine: 8, endLine: 8 });
    expect(routes[1]!.anchor.startLine).toBe(14);
    expect(routes[2]!.anchor.startLine).toBe(23);
    for (const r of routes) expect(r.value.receiver).toBe("app");
    expect(result.limitations).toHaveLength(0);
  });

  it("ignores app.use middleware and non-verb calls", () => {
    const content = 'app.use(express.json());\napp.listen(3000);\napp.get("/ok", h);\n';
    const result = routeAnalyzer.analyze({ path: "src/app.ts", content });
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0]!.value.path).toBe("/ok");
  });
});

describe("routeAnalyzer.analyze — router receivers and verbs", () => {
  it("detects router.<verb> with both quote styles and all common verbs", () => {
    const content = [
      "router.put('/items/:id', update);",
      'router.delete("/items/:id", remove);',
      "router.patch('/items/:id', patch);",
      'router.head("/items", head);',
      "router.options('/items', options);",
      'router.all("/items", any);'
    ].join("\n");
    const result = routeAnalyzer.analyze({ path: "src/routes/items.ts", content });
    const routes = result.facts.filter((f) => f.kind === "route");
    expect(routes.map((f) => f.value.method)).toEqual([
      "PUT",
      "DELETE",
      "PATCH",
      "HEAD",
      "OPTIONS",
      "ALL"
    ]);
    for (const r of routes) {
      expect(r.value.path).toMatch(/^\/items/);
      expect(r.value.receiver).toBe("router");
    }
    expect(result.limitations).toHaveLength(0);
  });

  it("detects an indented route and a dotted receiver ending in app/router", () => {
    const content = '  server.app.get("/health", h);\n';
    const result = routeAnalyzer.analyze({ path: "src/s.ts", content });
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0]!.value).toMatchObject({ method: "GET", path: "/health" });
  });

  it("does not treat other identifiers (myapp, approuter-less names) as receivers", () => {
    const content = 'myapp.get("/x", h);\nfastify.get("/y", h);\n';
    const result = routeAnalyzer.analyze({ path: "src/s.ts", content });
    expect(result.facts).toHaveLength(0);
  });

  it("records a limitation for a non-literal route path without emitting a fact", () => {
    const content = "app.get(ROUTE_PATH, handler);\napp.post(`/x/${id}`, h);\n";
    const result = routeAnalyzer.analyze({ path: "src/s.ts", content });
    expect(result.facts).toHaveLength(0);
    expect(result.limitations.some((l) => /non-literal/i.test(l.message))).toBe(true);
  });
});

describe("routeAnalyzer.analyze — hostile input", () => {
  it("passes a hostile path string through as inert data", () => {
    const content = 'app.get("/<script>alert(1)</script>", h);\n' + "app.post('/\"><img src=x onerror=alert(1)>', h);\n";
    const result = routeAnalyzer.analyze({ path: "src/h.ts", content });
    const routes = result.facts.filter((f) => f.kind === "route");
    expect(routes[0]!.value.path).toBe("/<script>alert(1)</script>");
    expect(routes[1]!.value.path).toBe('/"><img src=x onerror=alert(1)>');
  });

  it("survives an enormous line, truncating it with a recorded limitation", () => {
    const content = 'app.get("/ok", h);\n' + 'app.get("/' + "x".repeat(500_000) + '", h);\n';
    const start = Date.now();
    const result = routeAnalyzer.analyze({ path: "src/big.ts", content });
    expect(Date.now() - start).toBeLessThan(2_000);
    expect(result.facts.some((f) => f.value.path === "/ok")).toBe(true);
    expect(result.limitations.some((l) => /truncat/i.test(l.message))).toBe(true);
  });

  it("records a limitation for an unterminated path string", () => {
    const content = 'app.get("/never-closed\n';
    const result = routeAnalyzer.analyze({ path: "src/u.ts", content });
    expect(result.facts).toHaveLength(0);
    expect(result.limitations.some((l) => /unterminated|non-literal/i.test(l.message))).toBe(true);
  });

  it("never crashes on garbage content", () => {
    const garbage = 'app. get ((( "/x" router.post( \n'.repeat(100);
    const result = routeAnalyzer.analyze({ path: "src/g.ts", content: garbage });
    expect(Array.isArray(result.facts)).toBe(true);
    expect(Array.isArray(result.limitations)).toBe(true);
  });

  it("returns nothing for an empty file", () => {
    const result = routeAnalyzer.analyze({ path: "src/empty.ts", content: "" });
    expect(result.facts).toHaveLength(0);
    expect(result.limitations).toHaveLength(0);
  });
});
