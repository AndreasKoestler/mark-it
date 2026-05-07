import { defineCommand } from "citty";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ensureDaemonRunning } from "../daemon/client.js";
import { docIdForLegacyPath } from "../daemon/ids.js";

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

    const url = new URL(`http://127.0.0.1:${info.port}/api/agent/events`);
    url.searchParams.set("doc", docId);
    url.searchParams.set("token", info.token);

    // Bun ≥ 1.1 ships a spec-compliant EventSource: automatic reconnect
    // with Last-Event-ID, comment/data/event field parsing — no parser
    // on our side. Auth rides on `?token=` because EventSource cannot
    // set custom headers per the WHATWG spec.
    const es = new EventSource(url.toString());

    es.addEventListener("send", (ev) => {
      // `ev.data` is the JSON string the server wrote — pass through.
      process.stdout.write(`${(ev as MessageEvent).data}\n`);
    });

    es.addEventListener("done", () => {
      es.close();
      process.exit(0);
    });

    es.onerror = () => {
      // Spec EventSource auto-retries on transient errors. Only bail
      // when readyState is CLOSED (the server signalled "do not reconnect").
      if (es.readyState === EventSource.CLOSED) process.exit(1);
    };
  },
});

async function resolveDocId(args: { file?: string; "doc-id"?: string }): Promise<string> {
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
