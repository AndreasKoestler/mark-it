/**
 * cli-fallback.spec.ts
 *
 * Verifies that invoking `mark-it <file> --no-open --port <p>` (no subcommand)
 * still routes to the `review` command and brings up a working server.
 */
import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(__dirname, "..", "src", "index.ts");
const FIXTURE = resolve(__dirname, "..", "fixtures", "plan.md");

const FALLBACK_PORT = 5194;

async function waitForServer(
  url: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch {
      // server not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Server at ${url} did not become ready within ${timeoutMs}ms`);
}

function spawnMarkIt(
  args: string[],
  env?: Record<string, string>,
): ChildProcess {
  return spawn("bun", [CLI, ...args], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

test("bare file arg (no subcommand) routes to review and boots server", async () => {
  const child = spawnMarkIt(
    [FIXTURE, "--no-open", "--port", String(FALLBACK_PORT)],
    { MARK_IT_NO_AUTO_EXIT: "1" },
  );

  const serverUrl = `http://localhost:${FALLBACK_PORT}`;

  try {
    await waitForServer(`${serverUrl}/api/sidecar`);

    // Verify /api/sidecar responds with 200 and JSON
    const sidecarRes = await fetch(`${serverUrl}/api/sidecar`);
    expect(sidecarRes.status).toBe(200);
    const sidecar = await sidecarRes.json() as { doc?: { mrsf_version?: string } };
    expect(sidecar).toHaveProperty("doc");
    expect(sidecar.doc).toHaveProperty("mrsf_version");

    // Verify /api/document responds with the fixture file name
    const docRes = await fetch(`${serverUrl}/api/document`);
    expect(docRes.status).toBe(200);
    const doc = await docRes.json() as { name?: string };
    expect(doc.name).toBe("plan.md");
  } finally {
    child.kill("SIGTERM");
  }
});

test("review subcommand explicit also boots server", async () => {
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
