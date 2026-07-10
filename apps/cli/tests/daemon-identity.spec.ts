/**
 * daemon-identity.spec.ts
 *
 * Regression test for the daemon-mode identity gap found in the 2026-07-10
 * codebase review (F1a): `mark-it open --org/--project/--user` resolved a
 * user but never threaded the session into the daemon, so `enforceIdentity`
 * silently no-opped (any author could be forged) and DB-tagged documents
 * fell back to disk `.review.yaml` persistence instead of the database.
 *
 * This spawns the daemon, runs the real `open` CLI command against it with
 * `--org/--project/--user`, then verifies both halves directly against the
 * daemon's HTTP API: identity is enforced, and comments land in the DB.
 */
import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "../src/db/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(__dirname, "..", "src", "index.ts");
const FIXTURE = resolve(__dirname, "..", "fixtures", "plan.md");

interface DaemonInfo {
  port: number;
  token: string;
  pid: number;
}

function runCli(
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((res) => {
    const child = spawn("bun", [CLI, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("exit", (code) => res({ code: code ?? 0, stdout, stderr }));
  });
}

async function waitForDaemonFile(home: string, timeoutMs = 15_000): Promise<DaemonInfo> {
  const file = join(home, ".mark-it", "daemon.json");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      try {
        return JSON.parse(readFileSync(file, "utf8")) as DaemonInfo;
      } catch {
        /* not yet flushed */
      }
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`daemon.json did not appear in ${home} within ${timeoutMs}ms`);
}

async function seedDb(dbPath: string): Promise<{ orgId: string; userId: string }> {
  const { Database: BunDb } = await import("bun:sqlite");
  const db = new BunDb(dbPath, { create: true });
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  const { runMigrations } = await import("../src/db/migrate.js");
  const { migrationsDir } = await import("../src/db/paths.js");
  runMigrations(db as unknown as Db, migrationsDir());
  const { createOrg, createUser } = await import("../src/db/queries.js");
  const org = createOrg(db as unknown as Db, "acme");
  const user = createUser(db as unknown as Db, org.id, "@andreas", null);
  db.close();
  return { orgId: org.id, userId: user.id };
}

const FIXTURE_SIDECAR = `${FIXTURE}.review.yaml`;

test("open --org/--project/--user: forged identity rejected, comments persist to the DB not disk", async () => {
  // FIXTURE is a shared fixture file; a prior failing run (or a differently
  // -configured server) could have left a stale disk sidecar next to it.
  rmSync(FIXTURE_SIDECAR, { force: true });

  const home = mkdtempSync(join(tmpdir(), "mark-it-home-identity-"));
  const dbDir = mkdtempSync(join(tmpdir(), "mark-it-db-identity-"));
  const dbPath = join(dbDir, "mi.db");
  const { orgId, userId } = await seedDb(dbPath);

  let daemon: ChildProcess | undefined;
  try {
    const openResult = await runCli(
      [
        "open",
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
      ],
      { MARK_IT_HOME: home },
    );
    expect(openResult.code).toBe(0);
    const docId = openResult.stdout.trim();
    expect(docId).toBeTruthy();
    // A real session should never fall back to the legacy content hash id.
    expect(docId).not.toMatch(/^legacy-/);

    const info = await waitForDaemonFile(home);

    // Forged author/x_user_id must now be rejected — before the fix,
    // enforceIdentity short-circuited on a null session and let this through.
    const forged = await fetch(
      `http://127.0.0.1:${info.port}/api/sidecar?doc=${docId}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Mark-It-Token": info.token },
        body: JSON.stringify({
          action: "add",
          payload: { text: "forged", author: "@evil-hacker", x_user_id: "bad-id", line: 1 },
        }),
      },
    );
    expect(forged.status).toBe(403);

    // The legitimate user's identity must be accepted.
    const legit = await fetch(
      `http://127.0.0.1:${info.port}/api/sidecar?doc=${docId}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Mark-It-Token": info.token },
        body: JSON.stringify({
          action: "add",
          payload: { text: "legit comment", author: "@andreas", x_user_id: userId, line: 1 },
        }),
      },
    );
    expect(legit.status).toBe(200);

    // And it must have landed in the DB — not a disk `.review.yaml` sidecar —
    // since this doc was opened with --org/--project/--user.
    const { Database: BunDb } = await import("bun:sqlite");
    const { loadTreeForOrg } = await import("../src/db/queries.js");
    const verifyDb = new BunDb(dbPath, { readonly: true });
    const tree = loadTreeForOrg(verifyDb as unknown as Db, orgId);
    const doc = tree.projects.flatMap((p) => p.documents).find((d) => d.file_path === FIXTURE);
    expect(doc).toBeTruthy();
    const row = verifyDb
      .query<{ sidecar_yaml: string | null }, [string]>(
        "SELECT sidecar_yaml FROM documents WHERE id = ?",
      )
      .get(doc!.id);
    expect(row?.sidecar_yaml).toContain("legit comment");
    verifyDb.close();

    expect(existsSync(FIXTURE_SIDECAR)).toBe(false);
  } finally {
    // Best-effort daemon teardown: read its pid from the discovery file if
    // the daemon itself is a child of a since-exited `open` invocation.
    if (existsSync(join(home, ".mark-it", "daemon.json"))) {
      try {
        const info = JSON.parse(
          readFileSync(join(home, ".mark-it", "daemon.json"), "utf8"),
        ) as DaemonInfo;
        process.kill(info.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    daemon?.kill("SIGKILL");
    rmSync(FIXTURE_SIDECAR, { force: true });
  }
});
