/**
 * acceptance-tree.spec.ts
 *
 * Verifies the tree pane (org → projects → documents) with in-place doc switching.
 * Seeds 1 org + 2 projects + 3 docs (plan.md in p1 as the active fixture, doc-b.md in p2).
 */
import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(__dirname, "..", "src", "index.ts");
const FIXTURE_A = resolve(__dirname, "..", "fixtures", "plan.md");
const FIXTURE_B = resolve(__dirname, "..", "fixtures", "doc-b.md");

const TREE_PORT = 5199;

async function waitForServer(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Server at ${url} did not become ready within ${timeoutMs}ms`);
}

/**
 * A session-bearing `startServer` run generates a random auth token and
 * prints `mark-it: token=<token>` to stderr (see server.ts). Buffers stderr
 * from spawn time so the line isn't missed if it arrives before this is
 * called.
 */
function watchForToken(child: ChildProcess): () => Promise<string> {
  let buf = "";
  child.stderr?.on("data", (c: Buffer) => (buf += c.toString()));
  return (timeoutMs = 25_000) =>
    new Promise((resolveToken, reject) => {
      const deadline = Date.now() + timeoutMs;
      const poll = () => {
        const m = buf.match(/mark-it: token=([0-9a-f]+)/);
        if (m) {
          resolveToken(m[1]!);
          return;
        }
        if (Date.now() > deadline) {
          reject(new Error(`token not seen on stderr within ${timeoutMs}ms (got: ${buf})`));
          return;
        }
        setTimeout(poll, 50);
      };
      poll();
    });
}

async function seedDb(dbPath: string): Promise<{ orgId: string; docBId: string; p1Id: string; p2Id: string }> {
  const { Database: BunDb } = await import("bun:sqlite");
  const db = new BunDb(dbPath, { create: true });
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  const { runMigrations } = await import("../src/db/migrate.js");
  const { migrationsDir } = await import("../src/db/paths.js");
  runMigrations(db as unknown as import("../src/db/index.js").Db, migrationsDir());

  const { createOrg, createUser, upsertProject, upsertDocument } = await import("../src/db/queries.js");
  const dbTyped = db as unknown as import("../src/db/index.js").Db;

  const org = createOrg(dbTyped, "acme");
  createUser(dbTyped, org.id, "@andreas", null);

  // p1 contains plan.md (will be upserted by CLI on start too) + plan-c.md
  const p1 = upsertProject(dbTyped, org.id, "p1");
  // Pre-seed plan.md so it's already in DB with same file_path the CLI will use
  upsertDocument(dbTyped, p1.id, FIXTURE_A, "plan.md");

  // p2 contains doc-b.md
  const p2 = upsertProject(dbTyped, org.id, "p2");
  const docB = upsertDocument(dbTyped, p2.id, FIXTURE_B, "doc-b.md");

  db.close();
  return { orgId: org.id, docBId: docB.id, p1Id: p1.id, p2Id: p2.id };
}

let server: ChildProcess;
let dbPath: string;
let docBId: string;
let token: string;

test.beforeAll(async () => {
  const tmp = mkdtempSync(join(tmpdir(), "mi-tree-"));
  dbPath = join(tmp, "mi.db");
  const seeded = await seedDb(dbPath);
  docBId = seeded.docBId;

  server = spawn(
    "bun",
    [
      CLI,
      "review",
      FIXTURE_A,
      "--org",
      "acme",
      "--project",
      "p1",
      "--user",
      "@andreas",
      "--db",
      dbPath,
      "--no-open",
      "--port",
      String(TREE_PORT),
    ],
    {
      env: { ...process.env, MARK_IT_NO_AUTO_EXIT: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const getToken = watchForToken(server);

  await waitForServer(`http://localhost:${TREE_PORT}/api/session`);
  token = await getToken();
});

test.afterAll(() => {
  server?.kill("SIGTERM");
});

async function gotoApp(page: Page) {
  await page.goto(`http://localhost:${TREE_PORT}/?token=${token}`);
  await page.waitForSelector("[data-mrsf-line]", { timeout: 15_000 });
}

async function dispatchAdd(page: Page, line: number) {
  const target = await page.locator(`[data-mrsf-line="${line}"]`).first();
  const text = (await target.textContent()) ?? "";
  await page.evaluate(
    ({ line, text }) => {
      document.dispatchEvent(
        new CustomEvent("mrsf:add", {
          detail: { commentId: null, line, end_line: line, action: "add", selectionText: text },
        }),
      );
    },
    { line, text },
  );
}

async function submitDraft(page: Page, text: string) {
  await page.locator('[data-testid="comment-draft-input"]').fill(text);
  await page.locator('[data-testid="comment-draft-submit"]').click();
  await expect(page.locator('[data-testid="comment-draft"]')).toHaveCount(0);
}

test("TREE1: tree pane is present and active doc is highlighted", async ({ page }) => {
  await gotoApp(page);

  // Tree pane should be visible
  await expect(page.locator(".mi-tree")).toBeVisible();

  // The active doc (plan.md, in p1) should have data-active
  const activeBtn = page.locator(".mi-tree-doc[data-active]");
  await expect(activeBtn).toHaveCount(1);
  await expect(activeBtn).toContainText("plan.md");
});

test("TREE2: p1 is open by default; clicking p2 summary toggles it open", async ({ page }) => {
  await gotoApp(page);

  // p1 should be open (it contains the active doc)
  const p1Details = page.locator(".mi-tree-project").filter({ hasText: "p1" });
  await expect(p1Details).toHaveAttribute("open", "");

  // p2 should be closed
  const p2Details = page.locator(".mi-tree-project").filter({ hasText: "p2" });
  await expect(p2Details).not.toHaveAttribute("open", "");

  // Click p2 summary to open it
  await p2Details.locator(".mi-tree-project-summary").click();
  await expect(p2Details).toHaveAttribute("open", "");

  // doc-b.md should now be visible in p2
  await expect(p2Details.locator(".mi-tree-doc")).toContainText("doc-b.md");
});

test("TREE3: clicking doc-b switches active doc in-place (no page reload)", async ({ page }) => {
  await gotoApp(page);

  // Open p2
  const p2Details = page.locator(".mi-tree-project").filter({ hasText: "p2" });
  await p2Details.locator(".mi-tree-project-summary").click();

  // Click doc-b
  const docBBtn = p2Details.locator(".mi-tree-doc").filter({ hasText: "doc-b.md" });
  await docBBtn.click();

  // Wait for the centre view to update — doc-b has "Doc B Heading" as first h1
  await expect(page.locator(".mi-rendered h1, .mi-raw-line").first()).toContainText(
    /Doc B Heading/,
    { timeout: 10_000 },
  );

  // data-active should now be on doc-b button
  const activeBtn = page.locator(".mi-tree-doc[data-active]");
  await expect(activeBtn).toContainText("doc-b.md");

  // URL bar should NOT have changed (still no hash/path change)
  expect(page.url()).toBe(`http://localhost:${TREE_PORT}/?token=${token}`);
});

test("TREE4: comment added after switch persists to the new doc's sidecar_yaml", async ({ page }) => {
  await gotoApp(page);

  // Switch to doc-b (open p2 if needed — it may already be open if a prior test switched to doc-b)
  const p2Details = page.locator(".mi-tree-project").filter({ hasText: "p2" });
  const isP2Open = await p2Details.getAttribute("open");
  if (isP2Open === null) {
    await p2Details.locator(".mi-tree-project-summary").click();
  }
  const docBBtn = p2Details.locator(".mi-tree-doc").filter({ hasText: "doc-b.md" });
  await docBBtn.click();

  // Wait for doc-b content to appear
  await expect(page.locator("[data-mrsf-line]").first()).toBeVisible({ timeout: 10_000 });

  // Add a comment
  const firstLine = page.locator("[data-mrsf-line]").first();
  const lineNum = await firstLine.getAttribute("data-mrsf-line");
  const lineText = (await firstLine.textContent()) ?? "";
  await page.evaluate(
    ({ line, text }) => {
      document.dispatchEvent(
        new CustomEvent("mrsf:add", {
          detail: {
            commentId: null,
            line: Number(line),
            end_line: Number(line),
            action: "add",
            selectionText: text,
          },
        }),
      );
    },
    { line: lineNum, text: lineText },
  );
  await submitDraft(page, "Comment on doc-b after switch");

  // Wait for thread to appear
  await expect(page.locator('[data-testid="thread"]')).toBeVisible({ timeout: 5_000 });

  // Verify comment is in doc-b's sidecar_yaml in DB, NOT in plan.md's
  const { Database: BunDb } = await import("bun:sqlite");
  const db = new BunDb(dbPath);

  const docBRow = db
    .query<{ sidecar_yaml: string | null }, [string]>(
      "SELECT sidecar_yaml FROM documents WHERE id = ?",
    )
    .get(docBId);
  db.close();

  expect(docBRow?.sidecar_yaml).toContain("Comment on doc-b after switch");
});

test("TREE5: /api/tree returns tree annotated with isActive", async () => {
  const res = await fetch(`http://localhost:${TREE_PORT}/api/tree`, {
    headers: { "X-Mark-It-Token": token },
  });
  expect(res.status).toBe(200);
  const tree = await res.json() as {
    org: { name: string };
    projects: Array<{
      name: string;
      documents: Array<{ name: string; isActive: boolean }>;
    }>;
  };
  expect(tree.org.name).toBe("acme");
  // Exactly one document should have isActive: true (regardless of which one is active)
  const allDocs = tree.projects.flatMap((p) => p.documents);
  const activeDocs = allDocs.filter((d) => d.isActive);
  expect(activeDocs).toHaveLength(1);
  // The active doc must be either plan.md (initial) or doc-b.md (if TREE3/4 switched)
  const [activeDoc] = activeDocs;
  expect(["plan.md", "doc-b.md"]).toContain(activeDoc!.name);
});

test("TREE6: a slow superseded refresh doesn't clobber a faster later doc switch", async ({ page }) => {
  await gotoApp(page);

  // Delay the FIRST /api/document response (triggered by switching to doc-b)
  // well past the second switch's response, so if the client applied
  // whichever /api/document response arrived last (instead of whichever
  // refresh() was started last), doc-b's stale content would win.
  let delayedOnce = false;
  await page.route(
    (url) => url.pathname === "/api/document",
    async (route) => {
      if (!delayedOnce) {
        delayedOnce = true;
        await new Promise((r) => setTimeout(r, 1_000));
      }
      await route.continue();
    },
  );

  // Other tests in this file share the same server session, so p1/p2's
  // open/closed state and the currently-active doc both depend on whatever
  // ran before — open each project only if it isn't already.
  const p1Details = page.locator(".mi-tree-project").filter({ hasText: "p1" });
  const p2Details = page.locator(".mi-tree-project").filter({ hasText: "p2" });
  if ((await p2Details.getAttribute("open")) === null) {
    await p2Details.locator(".mi-tree-project-summary").click();
  }

  // Switch to doc-b — its refresh() will hang on the delayed /api/document.
  await p2Details.locator(".mi-tree-doc").filter({ hasText: "doc-b.md" }).click();
  // Give the select POST + SSE broadcast + refresh() start time to land
  // (well under the 1s delay) before firing the second, undelayed switch.
  await page.waitForTimeout(200);

  // Switch back to plan.md — this refresh() is not delayed and should win.
  if ((await p1Details.getAttribute("open")) === null) {
    await p1Details.locator(".mi-tree-project-summary").click();
  }
  await p1Details.locator(".mi-tree-doc").filter({ hasText: "plan.md" }).click();

  // Wait past the first switch's artificial delay.
  await page.waitForTimeout(1_200);

  await expect(page.locator(".mi-rendered h1, .mi-raw-line").first()).not.toContainText(
    /Doc B Heading/,
  );
  const activeBtn = page.locator(".mi-tree-doc[data-active]");
  await expect(activeBtn).toContainText("plan.md");
});
