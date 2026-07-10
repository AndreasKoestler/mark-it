/**
 * acceptance-multiuser.spec.ts
 *
 * Variant of AC3 for DB-backed mode:
 * - Boots the server with --org/--project/--user
 * - Adds a comment via the UI
 * - Verifies the sidecar YAML is stored in documents.sidecar_yaml (NOT on disk)
 * - Verifies x_user_id is present in the stored YAML
 */
import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(__dirname, "..", "src", "index.ts");
const FIXTURE = resolve(__dirname, "..", "fixtures", "plan.md");

const MULTIUSER_PORT = 5197;

async function waitForServer(url: string, timeoutMs = 25_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch {
      // not ready
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

async function seedDb(dbPath: string): Promise<void> {
  const { Database: BunDb } = await import("bun:sqlite");
  const db = new BunDb(dbPath, { create: true });
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  const { runMigrations } = await import("../src/db/migrate.js");
  const { migrationsDir } = await import("../src/db/paths.js");
  runMigrations(db as unknown as import("../src/db/index.js").Db, migrationsDir());
  const { createOrg, createUser } = await import("../src/db/queries.js");
  const org = createOrg(db as unknown as import("../src/db/index.js").Db, "acme");
  createUser(db as unknown as import("../src/db/index.js").Db, org.id, "@andreas", null);
  db.close();
}

let server: ChildProcess;
let dbPath: string;
let token: string;

test.beforeAll(async () => {
  const tmp = mkdtempSync(join(tmpdir(), "mi-multiuser-"));
  dbPath = join(tmp, "mi.db");
  await seedDb(dbPath);

  server = spawn(
    "bun",
    [
      CLI,
      "review",
      FIXTURE,
      "--org",
      "acme",
      "--project",
      "demo",
      "--user",
      "@andreas",
      "--db",
      dbPath,
      "--no-open",
      "--port",
      String(MULTIUSER_PORT),
    ],
    {
      env: { ...process.env, MARK_IT_NO_AUTO_EXIT: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const getToken = watchForToken(server);

  await waitForServer(`http://localhost:${MULTIUSER_PORT}/api/session`);
  token = await getToken();
});

test.afterAll(() => {
  server?.kill("SIGTERM");
});

async function gotoApp(page: Page) {
  await page.goto(`http://localhost:${MULTIUSER_PORT}/?token=${token}`);
  await page.waitForSelector("[data-mrsf-line]");
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

test("DB mode: comment writes to sidecar_yaml in DB, not to disk", async ({ page }) => {
  await gotoApp(page);
  await dispatchAdd(page, 17);
  await submitDraft(page, "DB-backed comment for multiuser test");

  // Confirm the comment shows up in the UI
  const thread = page.locator('[data-testid="thread"][data-line="17"]');
  await expect(thread).toBeVisible();

  // Verify no .review.yaml file appeared on disk
  const sidecarOnDisk = `${FIXTURE}.review.yaml`;
  expect(existsSync(sidecarOnDisk)).toBe(false);

  // Verify sidecar_yaml was written to the DB
  const { Database: BunDb } = await import("bun:sqlite");
  const db = new BunDb(dbPath);
  const row = db
    .query<{ sidecar_yaml: string | null }, []>(
      "SELECT sidecar_yaml FROM documents LIMIT 1",
    )
    .get();
  db.close();

  expect(row?.sidecar_yaml).toBeTruthy();
  expect(row!.sidecar_yaml).toContain("DB-backed comment for multiuser test");
  expect(row!.sidecar_yaml).toContain("mrsf_version");
});

test("DB mode: stored YAML contains x_user_id", async ({ page }) => {
  await gotoApp(page);
  await dispatchAdd(page, 13);
  await submitDraft(page, "Comment with user identity");

  // Give a moment for the POST to complete
  await page.waitForTimeout(300);

  // Fetch session to get the user ID
  const sessionRes = await fetch(`http://localhost:${MULTIUSER_PORT}/api/session`, {
    headers: { "X-Mark-It-Token": token },
  });
  const session = (await sessionRes.json()) as { user?: { id: string } };
  const userId = session.user?.id;
  expect(userId).toBeTruthy();

  const { Database: BunDb2 } = await import("bun:sqlite");
  const db2 = new BunDb2(dbPath);
  const row = db2
    .query<{ sidecar_yaml: string | null }, []>(
      "SELECT sidecar_yaml FROM documents LIMIT 1",
    )
    .get();
  db2.close();

  expect(row?.sidecar_yaml).toContain("x_user_id:");
  expect(row!.sidecar_yaml).toContain(userId!);
});
