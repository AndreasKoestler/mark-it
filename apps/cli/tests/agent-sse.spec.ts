/**
 * agent-sse.spec.ts
 *
 * Verifies the /api/agent/events SSE stream:
 *  - POST /api/agent broadcasts a `send` event to subscribers within 1s.
 *  - The event payload includes docId, text, comments, resolveIds, and a
 *    monotonic event id.
 *  - Reconnecting with `Last-Event-ID` replays missed events.
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

interface DaemonInfo { port: number; token: string; pid: number }

async function spawnDaemonAndRegister(home: string): Promise<{
  daemon: ChildProcess;
  info: DaemonInfo;
  docId: string;
}> {
  const daemon = spawn(
    "bun",
    [CLI, "daemon", "--port", "0", "--host", "127.0.0.1", "--idle-secs", "60"],
    { env: { ...process.env, MARK_IT_HOME: home }, stdio: ["ignore", "pipe", "pipe"] },
  );
  daemon.stderr?.on("data", (chunk) => process.stderr.write(`[daemon] ${chunk}`));

  const file = join(home, ".mark-it", "daemon.json");
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      try {
        const info = JSON.parse(readFileSync(file, "utf8")) as DaemonInfo;
        // Register the doc.
        const reg = await fetch(`http://127.0.0.1:${info.port}/api/registry/register`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Mark-It-Token": info.token },
          body: JSON.stringify({ filePath: FIXTURE }),
        });
        const body = (await reg.json()) as { docId: string };
        return { daemon, info, docId: body.docId };
      } catch {
        /* not yet */
      }
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("daemon did not start in time");
}

interface ParsedSseEvent { id?: string; event?: string; data?: string }

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (e: ParsedSseEvent) => boolean,
  timeoutMs: number,
): Promise<ParsedSseEvent[]> {
  const decoder = new TextDecoder();
  const collected: ParsedSseEvent[] = [];
  let buf = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { done, value } = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((resolveTimeout) =>
        setTimeout(() => resolveTimeout({ done: true, value: undefined }), Math.max(50, deadline - Date.now())),
      ),
    ]);
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const ev: ParsedSseEvent = {};
      for (const line of block.split("\n")) {
        if (line.startsWith("id:")) ev.id = line.slice(3).trim();
        else if (line.startsWith("event:")) ev.event = line.slice(6).trim();
        else if (line.startsWith("data:")) ev.data = line.slice(5).trim();
      }
      collected.push(ev);
      if (predicate(ev)) return collected;
    }
  }
  throw new Error(`SSE: predicate not satisfied within ${timeoutMs}ms (got ${JSON.stringify(collected)})`);
}

test("POST /api/agent broadcasts a `send` event to /api/agent/events subscribers", async () => {
  const home = mkdtempSync(join(tmpdir(), "mark-it-sse-"));
  const { daemon, info, docId } = await spawnDaemonAndRegister(home);

  try {
    const sseUrl = `http://127.0.0.1:${info.port}/api/agent/events?doc=${docId}&token=${info.token}`;
    const sseRes = await fetch(sseUrl);
    expect(sseRes.ok).toBe(true);
    expect(sseRes.headers.get("content-type")).toBe("text/event-stream");
    const reader = sseRes.body!.getReader();

    // Wait for the `ready` event.
    await readUntil(reader, (e) => e.event === "ready", 5_000);

    // Trigger a Send.
    const post = await fetch(`http://127.0.0.1:${info.port}/api/agent?doc=${docId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Mark-It-Token": info.token },
      body: JSON.stringify({ text: "hello agent", resolveIds: [], comments: [{ id: "c1" }] }),
    });
    expect(post.ok).toBe(true);
    const postBody = (await post.json()) as { ok: boolean; eventId: string };
    expect(postBody.ok).toBe(true);
    expect(postBody.eventId).toMatch(/^[0-9a-f-]{36}$/);

    // SSE consumer should see the `send` event.
    const events = await readUntil(reader, (e) => e.event === "send", 5_000);
    const sendEv = events.find((e) => e.event === "send")!;
    expect(sendEv.id).toBe(postBody.eventId);
    const data = JSON.parse(sendEv.data!) as {
      docId: string;
      text: string;
      comments: unknown;
      resolveIds: string[];
    };
    expect(data.docId).toBe(docId);
    expect(data.text).toBe("hello agent");
    expect(data.comments).toEqual([{ id: "c1" }]);
    expect(data.resolveIds).toEqual([]);
  } finally {
    process.kill(info.pid, "SIGTERM");
    await new Promise((r) => setTimeout(r, 100));
    if (daemon.exitCode == null) daemon.kill("SIGKILL");
  }
});

test("Last-Event-ID replays missed events on reconnect", async () => {
  const home = mkdtempSync(join(tmpdir(), "mark-it-sse-"));
  const { daemon, info, docId } = await spawnDaemonAndRegister(home);

  try {
    const sseUrl = `http://127.0.0.1:${info.port}/api/agent/events?doc=${docId}&token=${info.token}`;

    // First subscriber gets event A.
    const r1 = await fetch(sseUrl);
    const reader1 = r1.body!.getReader();
    await readUntil(reader1, (e) => e.event === "ready", 5_000);

    const a = await fetch(`http://127.0.0.1:${info.port}/api/agent?doc=${docId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Mark-It-Token": info.token },
      body: JSON.stringify({ text: "A" }),
    });
    const aBody = (await a.json()) as { eventId: string };
    await readUntil(reader1, (e) => e.id === aBody.eventId, 5_000);

    // Drop the connection.
    await reader1.cancel();

    // Server-side push of event B (no subscribers).
    const b = await fetch(`http://127.0.0.1:${info.port}/api/agent?doc=${docId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Mark-It-Token": info.token },
      body: JSON.stringify({ text: "B" }),
    });
    const bBody = (await b.json()) as { eventId: string };

    // Reconnect with Last-Event-ID = A; expect to receive B on replay.
    const r2 = await fetch(sseUrl, {
      headers: { "Last-Event-ID": aBody.eventId },
    });
    const reader2 = r2.body!.getReader();
    const replayed = await readUntil(
      reader2,
      (e) => e.event === "send" && e.id === bBody.eventId,
      5_000,
    );
    expect(replayed.find((e) => e.id === bBody.eventId)).toBeDefined();
  } finally {
    process.kill(info.pid, "SIGTERM");
    await new Promise((r) => setTimeout(r, 100));
    if (daemon.exitCode == null) daemon.kill("SIGKILL");
  }
});
