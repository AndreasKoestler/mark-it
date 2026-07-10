import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createDiscovery, type DaemonInfo } from "./discovery.js";
import type { ActiveDocumentSpec, Session } from "../server.js";

const __filename = fileURLToPath(import.meta.url);
const CLI_ENTRY = resolve(dirname(__filename), "..", "index.ts");

export interface RegisterResult {
  docId: string;
  url: string;
  focused: boolean;
}

/**
 * Returns a live `DaemonInfo` for the current MARK_IT_HOME, spawning the
 * daemon and waiting for it to come up if necessary. Single-flight via the
 * spawn lock — concurrent CLI invocations cooperate.
 */
export async function ensureDaemonRunning(opts: {
  spawnTimeoutMs?: number;
  idleSecs?: number;
  /** Forwarded as `--db` when spawning a fresh daemon (multi-user mode). */
  dbPath?: string;
} = {}): Promise<DaemonInfo> {
  const discovery = createDiscovery();
  const existing = await discovery.read();
  if (existing) return existing;

  // Acquire the spawn lock so concurrent clients don't race.
  let release: (() => void) | null = null;
  try {
    release = await discovery.acquireSpawnLock();
  } catch {
    // Another client is spawning; just wait for the file.
    return waitForDaemonFile(discovery, opts.spawnTimeoutMs ?? 10_000);
  }

  try {
    const child = spawn(
      "bun",
      [
        CLI_ENTRY,
        "daemon",
        "--port",
        "0",
        "--host",
        "127.0.0.1",
        "--idle-secs",
        String(opts.idleSecs ?? 600),
        ...(opts.dbPath ? ["--db", opts.dbPath] : []),
      ],
      {
        env: { ...process.env },
        // Detach so the daemon outlives this CLI invocation.
        detached: true,
        stdio: ["ignore", "ignore", "ignore"],
      },
    );
    child.unref();
    return await waitForDaemonFile(discovery, opts.spawnTimeoutMs ?? 10_000);
  } finally {
    release?.();
  }
}

async function waitForDaemonFile(
  discovery: ReturnType<typeof createDiscovery>,
  timeoutMs: number,
): Promise<DaemonInfo> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const info = await discovery.read();
    if (info) return info;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(
    `mark-it: daemon did not start within ${timeoutMs}ms — see ~/.mark-it for stale state`,
  );
}

export async function registerDoc(
  info: DaemonInfo,
  spec: ActiveDocumentSpec & { session?: Session | null },
): Promise<RegisterResult> {
  const res = await fetch(`http://127.0.0.1:${info.port}/api/registry/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Mark-It-Token": info.token,
    },
    body: JSON.stringify(spec),
  });
  if (!res.ok) {
    throw new Error(`mark-it: registerDoc failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as RegisterResult;
}

export async function unregisterDoc(info: DaemonInfo, docId: string): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${info.port}/api/registry/unregister`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Mark-It-Token": info.token,
    },
    body: JSON.stringify({ docId }),
  });
  if (!res.ok) {
    throw new Error(`mark-it: unregisterDoc failed: ${res.status} ${await res.text()}`);
  }
}
