import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(__dirname, "..", "src", "index.ts");

function run(
  args: string[],
  dbPath: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((res) => {
    const child = spawn("bun", [CLI, ...args], {
      env: { ...process.env, MARK_IT_DB_PATH: dbPath },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("exit", (code) => res({ code: code ?? 0, stdout, stderr }));
  });
}

test("org create + user add + project list round-trip", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "mi-test-"));
  const dbPath = join(tmp, "mi.db");

  const r1 = await run(["org", "create", "acme"], dbPath);
  expect(r1.code).toBe(0);
  expect(r1.stdout).toMatch(/Created org acme/);

  const r2 = await run(["user", "add", "@andreas", "--org", "acme"], dbPath);
  expect(r2.code).toBe(0);
  expect(r2.stdout).toMatch(/Added user @andreas/);

  const r3 = await run(["user", "list", "--org", "acme"], dbPath);
  expect(r3.code).toBe(0);
  expect(r3.stdout).toMatch(/@andreas/);

  // Inline DB inspection.
  const db = new Database(dbPath);
  const row = db.query("SELECT handle FROM users WHERE handle = ?").get("@andreas");
  expect(row).toBeTruthy();
  db.close();
});

test("org create duplicate exits non-zero", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "mi-test-"));
  const dbPath = join(tmp, "mi.db");

  await run(["org", "create", "acme"], dbPath);
  const r = await run(["org", "create", "acme"], dbPath);
  expect(r.code).not.toBe(0);
  expect(r.stderr).toMatch(/already exists/);
});

test("org list shows created orgs", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "mi-test-"));
  const dbPath = join(tmp, "mi.db");

  await run(["org", "create", "alpha"], dbPath);
  await run(["org", "create", "beta"], dbPath);
  const r = await run(["org", "list"], dbPath);
  expect(r.code).toBe(0);
  expect(r.stdout).toMatch(/alpha/);
  expect(r.stdout).toMatch(/beta/);
});

test("user add without org fails", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "mi-test-"));
  const dbPath = join(tmp, "mi.db");

  const r = await run(["user", "add", "@nobody", "--org", "ghost"], dbPath);
  expect(r.code).not.toBe(0);
  expect(r.stderr).toMatch(/does not exist/);
});

test("project list empty for org with no projects", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "mi-test-"));
  const dbPath = join(tmp, "mi.db");

  await run(["org", "create", "solo"], dbPath);
  const r = await run(["project", "list", "--org", "solo"], dbPath);
  expect(r.code).toBe(0);
  expect(r.stdout.trim()).toBe("");
});

test("user add normalises handle without @", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "mi-test-"));
  const dbPath = join(tmp, "mi.db");

  await run(["org", "create", "acme"], dbPath);
  const r = await run(["user", "add", "noat", "--org", "acme"], dbPath);
  expect(r.code).toBe(0);
  // handle should be stored as @noat
  expect(r.stdout).toMatch(/@noat/);
});
