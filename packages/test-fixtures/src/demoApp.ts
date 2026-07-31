/**
 * Scripted demo repo: a small express-style TS web app with a realistic
 * history. Built into a temp dir at test time — never a nested committed
 * .git. All git commands go through runGit (execFile + args array).
 *
 * History:
 *   main                     3 commits (scaffold, service+schema, routes)
 *   feature/guest-checkout   4 commits from the tip of main:
 *     1. meaningful  — adds guest-checkout route + validation module
 *     2. meaningful  — renames orderService -> checkoutService and edits it
 *     3. fixup!      — small tweak, message starts with "fixup! "
 *     4. formatting  — whitespace-only reindent (git diff -w is empty)
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { makeRepo, runGit } from "./makeRepo.js";

export const DEMO_FEATURE_BRANCH = "feature/guest-checkout";

const PACKAGE_JSON = `{
  "name": "demo-shop",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "express": "^4.19.0"
  }
}
`;

const INDEX_V1 = `export {};
`;

const INDEX_V2 = `import { app } from "./routes/orders";

app.listen(3000);
`;

const ORDER_SERVICE = `import { randomUUID } from "node:crypto";

export interface Order {
  id: string;
  customerId: string;
  items: string[];
  totalCents: number;
}

const orders = new Map<string, Order>();

export function createOrder(
  customerId: string,
  items: string[],
  totalCents: number
): Order {
  const order: Order = { id: randomUUID(), customerId, items, totalCents };
  orders.set(order.id, order);
  return order;
}

export function getOrder(id: string): Order | undefined {
  return orders.get(id);
}
`;

/** Rename + edit of ORDER_SERVICE: mostly identical lines so -M detects it. */
const CHECKOUT_SERVICE = ORDER_SERVICE.replace(
  "export function getOrder",
  `export function createGuestOrder(
  guestEmail: string,
  items: string[],
  totalCents: number
): Order {
  return createOrder(\`guest:\${guestEmail}\`, items, totalCents);
}

export function getOrder`
);

const SCHEMA_SQL = `CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  total_cents INTEGER NOT NULL
);

CREATE TABLE order_items (
  order_id TEXT NOT NULL REFERENCES orders(id),
  sku TEXT NOT NULL,
  quantity INTEGER NOT NULL
);
`;

const ROUTES_V1 = `import express from "express";
import { createOrder, getOrder } from "../services/orderService";

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
`;

const GUEST_ROUTE = `
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

const ROUTES_V2 =
  ROUTES_V1.replace(
    'import { createOrder, getOrder } from "../services/orderService";',
    'import { createOrder, getOrder } from "../services/orderService";\n' +
      'import { isValidGuestEmail } from "../validation/guest";'
  ) + GUEST_ROUTE;

const ROUTES_V3 = ROUTES_V2.replace(
  '"../services/orderService"',
  '"../services/checkoutService"'
);

const GUEST_VALIDATION_V1 = `export function isValidGuestEmail(email: string): boolean {
  return /^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(email);
}
`;

const GUEST_VALIDATION_V2 = `export function isValidGuestEmail(email: string): boolean {
  if (email.length > 254) {
    return false;
  }
  return /^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(email);
}
`;

async function writeFiles(
  repoDir: string,
  files: Record<string, string>
): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const abs = join(repoDir, path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  }
}

async function commitAll(repoDir: string, message: string): Promise<void> {
  await runGit(repoDir, ["add", "--all"]);
  await runGit(repoDir, ["commit", "-m", message]);
}

/**
 * Build the demo repo in a fresh temp dir and return its path.
 * Leaves feature/guest-checkout checked out (the branch a demo analyzes).
 */
export async function makeDemoRepo(): Promise<string> {
  const repoDir = await makeRepo();

  // main: 3 commits
  await writeFiles(repoDir, {
    "package.json": PACKAGE_JSON,
    "src/index.ts": INDEX_V1
  });
  await commitAll(repoDir, "chore: scaffold demo shop");

  await writeFiles(repoDir, {
    "src/services/orderService.ts": ORDER_SERVICE,
    "src/db/schema.sql": SCHEMA_SQL
  });
  await commitAll(repoDir, "feat: order service and database schema");

  await writeFiles(repoDir, {
    "src/routes/orders.ts": ROUTES_V1,
    "src/index.ts": INDEX_V2
  });
  await commitAll(repoDir, "feat: orders API routes");

  // feature branch from the tip of main
  await runGit(repoDir, ["checkout", "-b", DEMO_FEATURE_BRANCH]);

  // 1. meaningful: guest checkout route + validation
  await writeFiles(repoDir, {
    "src/validation/guest.ts": GUEST_VALIDATION_V1,
    "src/routes/orders.ts": ROUTES_V2
  });
  await commitAll(repoDir, "feat: add guest checkout route with validation");

  // 2. meaningful: rename a file and edit it
  await runGit(repoDir, [
    "mv",
    "--",
    "src/services/orderService.ts",
    "src/services/checkoutService.ts"
  ]);
  await writeFiles(repoDir, {
    "src/services/checkoutService.ts": CHECKOUT_SERVICE,
    "src/routes/orders.ts": ROUTES_V3
  });
  await commitAll(repoDir, "refactor: rename order service to checkout service");

  // 3. fixup-style commit
  await writeFiles(repoDir, {
    "src/validation/guest.ts": GUEST_VALIDATION_V2
  });
  await commitAll(repoDir, "fixup! feat: add guest checkout route with validation");

  // 4. formatting-only commit: double the indentation of the routes file
  // (git diff -w is empty). Deliberately NOT the renamed file — reindenting
  // it would sink its similarity score and break rename detection over the
  // whole main..feature range.
  await writeFiles(repoDir, {
    "src/routes/orders.ts": ROUTES_V3.replace(/^( +)/gm, (m) => m + m)
  });
  await commitAll(repoDir, "style: reformat orders routes");

  return repoDir;
}
