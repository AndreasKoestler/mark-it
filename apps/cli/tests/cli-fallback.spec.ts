/**
 * cli-fallback.spec.ts
 *
 * Verifies argv routing:
 *  - Bare-file `mark-it <file>` (no subcommand) is a thin client that
 *    spawns/uses the daemon, registers the doc, and exits.
 *  - Explicit `mark-it review <file> --port N` keeps the legacy long-running
 *    behaviour for tests and shell pipelines that want it.
 */
import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(__dirname, "..", "src", "index.ts");
const FIXTURE = resolve(__dirname, "..", "fixtures", "plan.md");

const FALLBACK_PORT = 5194;

async function waitForServer(url: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch {
      /* not up yet */
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

test("bare file arg (no subcommand) is a thin client: registers via daemon and exits", async () => {
  const home = mkdtempSync(join(tmpdir(), "mark-it-fb-"));
  const child = spawnMarkIt([FIXTURE, "--no-open"], { MARK_IT_HOME: home });
  const stdoutChunks: string[] = [];
  child.stdout?.on("data", (chunk) => stdoutChunks.push(String(chunk)));
  child.stderr?.on("data", (chunk) => process.stderr.write(`[mark-it] ${chunk}`));

  // The thin client should exit on its own within a few seconds.
  const code = await new Promise<number | null>((resolveCode) => {
    const timer = setTimeout(() => resolveCode(null), 15_000);
    child.once("exit", (c) => {
      clearTimeout(timer);
      resolveCode(c ?? 0);
    });
  });
  expect(code).toBe(0);

  // It should have printed the docId.
  const stdout = stdoutChunks.join("");
  expect(stdout).toMatch(/^legacy-[0-9a-f]{16}\n/);

  // The daemon it spawned should still be running and reachable.
  const daemonFile = join(home, ".mark-it", "daemon.json");
  expect(existsSync(daemonFile)).toBe(true);
  const info = JSON.parse(readFileSync(daemonFile, "utf8")) as {
    port: number;
    token: string;
    pid: number;
  };
  const list = await fetch(`http://127.0.0.1:${info.port}/api/registry/list`, {
    headers: { "X-Mark-It-Token": info.token },
  });
  expect(list.status).toBe(200);
  const body = (await list.json()) as { docs: Array<{ filePath: string }> };
  expect(body.docs.find((d) => d.filePath === FIXTURE)).toBeTruthy();

  // Tear the daemon down.
  process.kill(info.pid, "SIGTERM");
});

test("review subcommand explicit boots a long-running server (legacy mode)", async () => {
  const reviewPort = FALLBACK_PORT + 1;
  const child = spawnMarkIt(
    ["review", FIXTURE, "--no-open", "--port", String(reviewPort)],
    { MARK_IT_NO_AUTO_EXIT: "1" },
  );

  const serverUrl = `http://localhost:${reviewPort}`;

  try {
    await waitForServer(`${serverUrl}/api/sidecar`);

    const sidecarRes = await fetch(`${serverUrl}/api/sidecar`);
    expect(sidecarRes.status).toBe(200);
  } finally {
    child.kill("SIGTERM");
  }
});
