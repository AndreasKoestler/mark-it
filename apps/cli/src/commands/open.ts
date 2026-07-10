import { defineCommand } from "citty";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { ensureDaemonRunning, registerDoc } from "../daemon/client.js";
import { openDbForCommand, resolveDbBackedDoc } from "./util.js";
import type { Session } from "../server.js";

export const openCommand = defineCommand({
  meta: {
    name: "open",
    description:
      "Register a Markdown file with the mark-it daemon (spawning it if needed) and focus its tab.",
  },
  args: {
    file: {
      type: "positional",
      description: "Path to the Markdown file. Omit to read from stdin.",
      required: false,
    },
    "no-open": {
      type: "boolean",
      description: "Don't open the browser even if the doc is new.",
      default: false,
    },
    org: { type: "string", required: false },
    project: { type: "string", required: false },
    user: { type: "string", required: false },
    "doc-name": { type: "string", required: false },
    db: { type: "string", required: false },
  },
  async run({ args }) {
    const filePath = await resolveSource(args.file);

    let documentId: string | undefined;
    let documentName: string | undefined;
    let projectId: string | undefined;
    let projectName: string | undefined;
    let session: Session | undefined;
    let dbPath: string | undefined;

    if (args.org && args.project && args.user) {
      const opened = openDbForCommand({ db: args.db });
      dbPath = opened.dbPath;
      const resolved = resolveDbBackedDoc(
        opened.db,
        { org: args.org, project: args.project, user: args.user, "doc-name": args["doc-name"] },
        filePath,
      );
      documentId = resolved.documentId;
      documentName = resolved.documentName;
      projectId = resolved.projectId;
      projectName = resolved.projectName;
      session = resolved.session;
    }

    // Forward --db so a freshly-spawned daemon opens the same database this
    // invocation resolved the org/project/document against — otherwise the
    // daemon has no DB to persist into and comments silently fall back to
    // disk despite --org/--project/--user.
    let result;
    try {
      const info = await ensureDaemonRunning({ dbPath });
      result = await registerDoc(info, {
        filePath,
        documentId,
        documentName,
        projectId,
        projectName,
        session,
      });
    } catch (err) {
      console.error(`mark-it: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }

    // Print the docId to stdout so shell pipelines / mark-it tail can pick it up.
    process.stdout.write(`${result.docId}\n`);

    if (!result.focused && !args["no-open"]) {
      openBrowser(result.url);
    }
  },
});

async function resolveSource(maybePath: string | undefined): Promise<string> {
  if (maybePath) {
    const abs = resolve(process.cwd(), maybePath);
    if (!existsSync(abs)) {
      console.error(`mark-it: file not found: ${abs}`);
      process.exit(1);
    }
    return abs;
  }
  if (process.stdin.isTTY) {
    console.error("mark-it: pass a file path or pipe Markdown into stdin.");
    process.exit(1);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const dir = mkdtempSync(join(tmpdir(), "mark-it-"));
  const tmpPath = join(dir, "stdin.md");
  writeFileSync(tmpPath, Buffer.concat(chunks).toString("utf8"), "utf8");
  console.error(`mark-it: stdin captured to ${tmpPath}`);
  return tmpPath;
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open" :
    process.platform === "win32" ? "start" :
    "xdg-open";
  const child = spawn(cmd, [url], { stdio: "ignore", detached: true });
  child.on("error", (err) => {
    console.error(`mark-it: failed to open browser (${cmd}): ${err.message}`);
  });
  child.unref();
}
