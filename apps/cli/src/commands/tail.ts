import { defineCommand } from "citty";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ensureDaemonRunning } from "../daemon/client.js";
import { docIdForLegacyPath } from "../daemon/ids.js";
import type { DaemonInfo } from "../daemon/discovery.js";

export const tailCommand = defineCommand({
  meta: {
    name: "tail",
    description: "Stream agent events for a registered doc as JSONL on stdout.",
  },
  args: {
    file: {
      type: "positional",
      description:
        "Markdown path. Used to derive the legacy-mode docId. Omit when --doc-id is supplied.",
      required: false,
    },
    "doc-id": {
      type: "string",
      description:
        "Explicit docId to subscribe to. Use this for DB-mode docs (the value `mark-it open` printed on stdout).",
      required: false,
    },
  },
  async run({ args }) {
    const docId = await resolveDocId(args);
    const info = await ensureDaemonRunning();

    let lastEventId: string | undefined;
    const reconnectDelays = [250, 500, 1_000, 2_000, 4_000];
    let attempt = 0;

    while (true) {
      try {
        const exited = await runOnce(info, docId, lastEventId, (id) => {
          lastEventId = id;
        });
        if (exited === "done") return;
        attempt = 0; // any delivered event resets backoff
      } catch (err) {
        // Network blip or daemon restart — back off and try again, replaying
        // missed events via Last-Event-ID.
        const wait = reconnectDelays[Math.min(attempt, reconnectDelays.length - 1)];
        attempt += 1;
        if (process.env.MARK_IT_TAIL_DEBUG) {
          console.error(`mark-it tail: ${String(err)}; retry in ${wait}ms`);
        }
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  },
});

async function resolveDocId(args: {
  file?: string;
  "doc-id"?: string;
}): Promise<string> {
  if (args["doc-id"]) return args["doc-id"];
  if (!args.file) {
    console.error("mark-it tail: provide a file path or --doc-id");
    process.exit(1);
  }
  const abs = resolve(process.cwd(), args.file);
  if (!existsSync(abs)) {
    console.error(`mark-it tail: file not found: ${abs}`);
    process.exit(1);
  }
  return docIdForLegacyPath(abs);
}

/**
 * Runs one SSE connection lifetime: opens fetch, parses event blocks, prints
 * each `send` event as JSONL on stdout, exits on `done`. Returns "done" on a
 * graceful end, "closed" on a transient close, and throws on connect errors.
 */
async function runOnce(
  info: DaemonInfo,
  docId: string,
  lastEventId: string | undefined,
  onEventId: (id: string) => void,
): Promise<"done" | "closed"> {
  const url = new URL(`http://127.0.0.1:${info.port}/api/agent/events`);
  url.searchParams.set("doc", docId);
  url.searchParams.set("token", info.token);

  const headers: Record<string, string> = { Accept: "text/event-stream" };
  if (lastEventId) headers["Last-Event-ID"] = lastEventId;

  const res = await fetch(url.toString(), { headers });
  if (res.status === 404) {
    // Doc was unregistered — nothing more to stream.
    return "done";
  }
  if (!res.ok || !res.body) {
    throw new Error(`agent SSE: status ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) return "closed";
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const ev = parseSseBlock(block);
      if (!ev) continue;
      if (ev.id) onEventId(ev.id);
      if (ev.event === "send" && typeof ev.data === "string") {
        process.stdout.write(`${ev.data}\n`);
      } else if (ev.event === "done") {
        return "done";
      }
      // ready/focus/etc. → ignore
    }
  }
}

interface ParsedSseEvent {
  id?: string;
  event?: string;
  data?: string;
}

function parseSseBlock(block: string): ParsedSseEvent | null {
  const ev: ParsedSseEvent = {};
  const dataLines: string[] = [];
  for (const raw of block.split("\n")) {
    if (!raw || raw.startsWith(":")) continue;
    const colonAt = raw.indexOf(":");
    const field = colonAt === -1 ? raw : raw.slice(0, colonAt);
    const value = colonAt === -1 ? "" : raw.slice(colonAt + 1).replace(/^ /, "");
    if (field === "id") ev.id = value;
    else if (field === "event") ev.event = value;
    else if (field === "data") dataLines.push(value);
  }
  if (dataLines.length > 0) ev.data = dataLines.join("\n");
  if (!ev.id && !ev.event && ev.data === undefined) return null;
  return ev;
}
