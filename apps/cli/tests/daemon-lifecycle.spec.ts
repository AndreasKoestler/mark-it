/**
 * daemon-lifecycle.spec.ts
 *
 * Spawns the mark-it daemon end-to-end (NO browser) and exercises the
 * registry HTTP API + idle exit. Uses MARK_IT_HOME to redirect the
 * daemon.json into a per-test tmpdir so the user's real daemon isn't
 * touched.
 */
import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(__dirname, "..", "src", "index.ts");
const FIXTURE_A = resolve(__dirname, "..", "fixtures", "plan.md");
const FIXTURE_B = resolve(__dirname, "..", "fixtures", "doc-b.md");

interface DaemonInfo { port: number; token: string; pid: number }

function spawnDaemon(env: Record<string, string>, port = 0, idleSecs = 1): ChildProcess {
  return spawn(
    "bun",
    [CLI, "daemon", "--port", String(port), "--host", "127.0.0.1", "--idle-secs", String(idleSecs)],
    { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] },
  );
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

async function callJson<T>(
  info: DaemonInfo,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: T }> {
  const res = await fetch(`http://127.0.0.1:${info.port}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-Mark-It-Token": info.token,
      ...(init.headers ?? {}),
    },
  });
  const body = (await res.json().catch(() => ({}))) as T;
  return { status: res.status, body };
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  if (child.exitCode != null) return child.exitCode;
  return new Promise((resolveExit) => {
    const timer = setTimeout(() => resolveExit(null), timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolveExit(code ?? 0);
    });
  });
}

test("daemon registers two docs, focuses an existing tab on re-register, idle-exits when both unregister", async () => {
  const home = mkdtempSync(join(tmpdir(), "mark-it-home-"));
  const daemon = spawnDaemon({ MARK_IT_HOME: home }, 0, 2);
  daemon.stderr?.on("data", (chunk) => process.stderr.write(`[daemon] ${chunk}`));

  try {
    const info = await waitForDaemonFile(home);
    expect(info.port).toBeGreaterThan(0);
    expect(info.token).toMatch(/^[0-9a-f]{64}$/);

    // Auth required: requests without the token should be rejected.
    const noAuth = await fetch(`http://127.0.0.1:${info.port}/api/registry/health`);
    expect(noAuth.status).toBe(401);

    // Register doc A.
    const a1 = await callJson<{ docId: string; url: string; focused: boolean }>(
      info,
      "/api/registry/register",
      { method: "POST", body: JSON.stringify({ filePath: FIXTURE_A }) },
    );
    expect(a1.status).toBe(200);
    expect(a1.body.docId).toMatch(/^legacy-/);
    expect(a1.body.focused).toBe(false);
    expect(a1.body.url).toContain(`http://127.0.0.1:${info.port}/`);
    expect(a1.body.url).toContain(`doc=${a1.body.docId}`);
    expect(a1.body.url).toContain(`token=${info.token}`);

    // Register A again — should focus the existing session.
    const a2 = await callJson<{ docId: string; focused: boolean }>(
      info,
      "/api/registry/register",
      { method: "POST", body: JSON.stringify({ filePath: FIXTURE_A }) },
    );
    expect(a2.status).toBe(200);
    expect(a2.body.docId).toBe(a1.body.docId);
    expect(a2.body.focused).toBe(true);

    // Register B (different file → different docId).
    const b1 = await callJson<{ docId: string }>(info, "/api/registry/register", {
      method: "POST",
      body: JSON.stringify({ filePath: FIXTURE_B }),
    });
    expect(b1.body.docId).not.toBe(a1.body.docId);

    // List shows two docs.
    const list = await callJson<{ docs: Array<{ docId: string }> }>(
      info,
      "/api/registry/list",
    );
    expect(list.body.docs).toHaveLength(2);

    // Unregister both.
    await callJson(info, "/api/registry/unregister", {
      method: "POST",
      body: JSON.stringify({ docId: a1.body.docId }),
    });
    await callJson(info, "/api/registry/unregister", {
      method: "POST",
      body: JSON.stringify({ docId: b1.body.docId }),
    });

    // Daemon should idle-exit within roughly idle-secs + tick interval (~5s upper bound here).
    const code = await waitForExit(daemon, 15_000);
    expect(code).toBe(0);

    // discovery file removed.
    expect(existsSync(join(home, ".mark-it", "daemon.json"))).toBe(false);
  } finally {
    if (daemon.exitCode == null) daemon.kill("SIGKILL");
  }
});
