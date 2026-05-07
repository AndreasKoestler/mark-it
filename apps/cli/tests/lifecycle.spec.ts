import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { request as httpRequest, type IncomingMessage, type ClientRequest } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Lifecycle test — runs its own mark-it on a dedicated port and verifies the
 * exit behavior end-to-end via raw HTTP. We use a small grace window (200ms)
 * so the test is fast and robust against background browser processes that
 * auto-discover localhost services.
 *
 * Production exit is driven by /api/bye (the browser fires sendBeacon on
 * `pagehide`). This test exercises that path directly.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = resolve(__dirname, "..", "src", "index.ts");
const FIXTURE_PATH = resolve(__dirname, "..", "fixtures", "plan.md");

const GRACE_MS = 200;

async function waitForServer(port: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/sidecar`);
      if (res.ok) return;
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`mark-it did not become ready on :${port} within ${timeoutMs}ms`);
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

function spawnMarkIt(port: number): ChildProcess {
  // Explicit `review` subcommand → legacy long-running server (the path this
  // test exercises). Bare-file is now a thin daemon client that exits in <1s.
  const child = spawn(
    "bun",
    [CLI_ENTRY, "review", FIXTURE_PATH, "--no-open", "--port", String(port)],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        MARK_IT_HOST: "127.0.0.1",
        MARK_IT_IDLE_EXIT_GRACE_MS: String(GRACE_MS),
      },
    },
  );
  child.stderr?.on("data", (chunk) => process.stderr.write(`[mark-it] ${chunk}`));
  return child;
}

async function openSseSocket(port: number): Promise<{ req: ClientRequest; res: IncomingMessage }> {
  const req = httpRequest({
    host: "127.0.0.1",
    port,
    path: "/api/events",
    method: "GET",
    headers: { Accept: "text/event-stream" },
  });
  req.end();
  const res = await new Promise<IncomingMessage>((resolveRes, rejectRes) => {
    req.once("response", resolveRes);
    req.once("error", rejectRes);
  });
  res.on("data", () => undefined);
  res.on("error", () => undefined);
  return { req, res };
}

test("/api/bye triggers exit; a fresh connect cancels grace (refresh case)", async () => {
  const port = 50_000 + Math.floor(Math.random() * 10_000);
  const child = spawnMarkIt(port);

  try {
    await waitForServer(port);

    // Establish a client so the lifecycle leaves the "warming" state.
    const initial = await openSseSocket(port);

    // Simulate a refresh: bye fires on pagehide, then a fresh SSE connect
    // arrives within the grace window. The new connect must cancel grace.
    const byeRes1 = await fetch(`http://127.0.0.1:${port}/api/bye`, {
      method: "POST",
      headers: { Connection: "close" },
    });
    expect(byeRes1.ok).toBe(true);
    initial.req.destroy();

    const reconnect = await openSseSocket(port);
    // Wait past grace; server must NOT exit because of the reconnect.
    await new Promise((r) => setTimeout(r, GRACE_MS * 4));
    expect(child.exitCode).toBeNull();

    // Now genuinely close the tab: bye, no follow-up connect.
    const byeRes2 = await fetch(`http://127.0.0.1:${port}/api/bye`, {
      method: "POST",
      headers: { Connection: "close" },
    });
    expect(byeRes2.ok).toBe(true);
    reconnect.req.destroy();

    const code = await waitForExit(child, GRACE_MS * 20 + 1_500);
    expect(code).toBe(0);
  } finally {
    if (child.exitCode == null) child.kill("SIGKILL");
  }
});
