/**
 * identity-enforcement.spec.ts
 *
 * Verifies that POST /api/sidecar enforces identity (returns 403) when
 * author/x_user_id don't match the session, and allows override via
 * MARK_IT_ALLOW_AUTHOR_OVERRIDE=1.
 */
import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(__dirname, "..", "src", "index.ts");
const FIXTURE = resolve(__dirname, "..", "fixtures", "plan.md");

const IDENTITY_PORT = 5196;

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

function spawnMarkItDb(
  dbPath: string,
  port: number,
  env?: Record<string, string>,
): ChildProcess {
  return spawn(
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
      String(port),
    ],
    {
      env: { ...process.env, MARK_IT_NO_AUTO_EXIT: "1", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
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

test("identity enforcement: forged author/x_user_id returns 403", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "mi-identity-"));
  const dbPath = join(tmp, "mi.db");
  await seedDb(dbPath);

  const child = spawnMarkItDb(dbPath, IDENTITY_PORT);
  const serverUrl = `http://localhost:${IDENTITY_PORT}`;
  const getToken = watchForToken(child);

  try {
    await waitForServer(`${serverUrl}/api/session`);
    const token = await getToken();

    // Forge a different author + x_user_id — should get 403
    const res = await fetch(`${serverUrl}/api/sidecar`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Mark-It-Token": token },
      body: JSON.stringify({
        action: "add",
        payload: {
          text: "Forged comment",
          author: "@evil-hacker",
          x_user_id: "bad-id",
          line: 1,
        },
      }),
    });
    expect(res.status).toBe(403);
  } finally {
    child.kill("SIGTERM");
  }
});

test("identity enforcement: correct author/x_user_id returns 200", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "mi-identity-"));
  const dbPath = join(tmp, "mi.db");
  await seedDb(dbPath);

  const port = IDENTITY_PORT + 1;
  const child = spawnMarkItDb(dbPath, port);
  const serverUrl = `http://localhost:${port}`;
  const getToken = watchForToken(child);

  try {
    await waitForServer(`${serverUrl}/api/session`);
    const token = await getToken();
    const auth = { "X-Mark-It-Token": token };

    // Fetch session (with the token — it's no longer readable anonymously)
    // to get the real userId.
    const sessionRes = await fetch(`${serverUrl}/api/session`, { headers: auth });
    const session = (await sessionRes.json()) as { user?: { id: string; handle: string } };
    const userId = session.user?.id!;
    const handle = session.user?.handle!;

    // Use the correct author + x_user_id — should get 200
    const res = await fetch(`${serverUrl}/api/sidecar`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({
        action: "add",
        payload: {
          text: "Legit comment",
          author: handle,
          x_user_id: userId,
          line: 1,
        },
      }),
    });
    expect(res.status).toBe(200);
  } finally {
    child.kill("SIGTERM");
  }
});

test("identity enforcement: MARK_IT_ALLOW_AUTHOR_OVERRIDE=1 bypasses check", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "mi-identity-"));
  const dbPath = join(tmp, "mi.db");
  await seedDb(dbPath);

  const port = IDENTITY_PORT + 2;
  const child = spawnMarkItDb(dbPath, port, { MARK_IT_ALLOW_AUTHOR_OVERRIDE: "1" });
  const serverUrl = `http://localhost:${port}`;
  const getToken = watchForToken(child);

  try {
    await waitForServer(`${serverUrl}/api/session`);
    const token = await getToken();

    // Forged author — override env should bypass the identity check (but
    // the token is still required to reach the endpoint at all).
    const res = await fetch(`${serverUrl}/api/sidecar`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Mark-It-Token": token },
      body: JSON.stringify({
        action: "add",
        payload: {
          text: "Override comment",
          author: "@anyone",
          x_user_id: "any-id",
          line: 1,
        },
      }),
    });
    expect(res.status).toBe(200);
  } finally {
    child.kill("SIGTERM");
  }
});
