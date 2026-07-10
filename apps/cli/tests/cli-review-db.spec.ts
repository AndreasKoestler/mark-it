/**
 * cli-review-db.spec.ts
 *
 * Verifies that `mark-it review <file> --org <o> --project <p> --user <u> --db <db>`
 * boots a server in DB-backed mode: auto-creates the project and document rows,
 * and serves the correct /api/session response.
 */
import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "../src/db/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(__dirname, "..", "src", "index.ts");
const FIXTURE = resolve(__dirname, "..", "fixtures", "plan.md");

const DB_REVIEW_PORT = 5198;

async function waitForServer(url: string, timeoutMs = 25_000): Promise<void> {
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

function spawnMarkIt(args: string[], env?: Record<string, string>): ChildProcess {
  return spawn("bun", [CLI, ...args], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
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
  runMigrations(db as unknown as Db, migrationsDir());
  const { createOrg, createUser } = await import("../src/db/queries.js");
  const org = createOrg(db as unknown as Db, "acme");
  createUser(db as unknown as Db, org.id, "@andreas", null);
  db.close();
}

test("review --org/--project/--user boots in DB mode and creates project/document rows", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "mi-db-review-"));
  const dbPath = join(tmp, "mi.db");
  await seedDb(dbPath);

  const child = spawnMarkIt(
    [
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
      String(DB_REVIEW_PORT),
    ],
    { MARK_IT_NO_AUTO_EXIT: "1" },
  );

  const serverUrl = `http://localhost:${DB_REVIEW_PORT}`;
  const getToken = watchForToken(child);

  try {
    await waitForServer(`${serverUrl}/api/session`);
    const token = await getToken();
    const auth = { "X-Mark-It-Token": token };

    // /api/session should return org/user info
    const sessionRes = await fetch(`${serverUrl}/api/session`, { headers: auth });
    expect(sessionRes.status).toBe(200);
    const session = (await sessionRes.json()) as {
      org?: { name: string };
      user?: { handle: string };
      active?: { documentName?: string };
    };
    expect(session.org?.name).toBe("acme");
    expect(session.user?.handle).toBe("@andreas");
    expect(session.active?.documentName).toBe("plan.md");

    // Verify project + document rows were created in the DB
    const { Database: BunDb2 } = await import("bun:sqlite");
    const db2 = new BunDb2(dbPath);
    const projectRow = db2
      .query<{ name: string }, [string]>("SELECT name FROM projects WHERE name = ?")
      .get("demo");
    expect(projectRow?.name).toBe("demo");

    const docRow = db2
      .query<{ name: string }, [string]>("SELECT name FROM documents WHERE name = ?")
      .get("plan.md");
    expect(docRow?.name).toBe("plan.md");
    db2.close();

    // /api/sidecar should work with the token...
    const sidecarRes = await fetch(`${serverUrl}/api/sidecar`, { headers: auth });
    expect(sidecarRes.status).toBe(200);
    const sc = (await sidecarRes.json()) as { doc?: { mrsf_version?: string } };
    expect(sc.doc?.mrsf_version).toBe("1.0");

    // ...and must be rejected without one — this is a session-bearing run,
    // so /api/session (which reveals the real userId/handle enforceIdentity
    // checks against) and /api/sidecar must not be reachable anonymously.
    const noAuthSession = await fetch(`${serverUrl}/api/session`);
    expect(noAuthSession.status).toBe(401);
    const noAuthSidecar = await fetch(`${serverUrl}/api/sidecar`);
    expect(noAuthSidecar.status).toBe(401);
  } finally {
    child.kill("SIGTERM");
  }
});

test("review --user with non-member exits non-zero", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "mi-db-review-no-user-"));
  const dbPath = join(tmp, "mi.db");

  // Seed only the org, no users
  const { Database: BunDb } = await import("bun:sqlite");
  const db = new BunDb(dbPath, { create: true });
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  const { runMigrations } = await import("../src/db/migrate.js");
  const { migrationsDir } = await import("../src/db/paths.js");
  runMigrations(db as unknown as Db, migrationsDir());
  const { createOrg } = await import("../src/db/queries.js");
  createOrg(db as unknown as Db, "acme");
  db.close();

  const result = await new Promise<{ code: number; stderr: string }>((res) => {
    const child = spawnMarkIt(
      [
        "review",
        FIXTURE,
        "--org",
        "acme",
        "--project",
        "demo",
        "--user",
        "@nope",
        "--db",
        dbPath,
        "--no-open",
      ],
      {},
    );
    let stderr = "";
    child.stderr?.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("exit", (code) => res({ code: code ?? 1, stderr }));
  });

  expect(result.code).not.toBe(0);
  expect(result.stderr).toMatch(/not a member/);
});
