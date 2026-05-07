import { defineCommand } from "citty";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { ensureDaemonRunning, registerDoc } from "../daemon/client.js";
import { openDbForCommand, requireOrg, normaliseHandle } from "./util.js";
import { findUserByHandle, upsertProject, upsertDocument } from "../db/queries.js";

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

    if (args.org && args.project && args.user) {
      const { db } = openDbForCommand({ db: args.db });
      const org = requireOrg(db, args.org);
      const handle = normaliseHandle(args.user);
      const user = findUserByHandle(db, org.id, handle);
      if (!user) {
        console.error(`mark-it: user ${handle} is not a member of org ${org.name}`);
        process.exit(1);
      }
      const project = upsertProject(db, org.id, args.project);
      const docName = args["doc-name"] ?? basename(filePath);
      const document = upsertDocument(db, project.id, filePath, docName);
      documentId = document.id;
      documentName = document.name;
      projectId = project.id;
      projectName = project.name;
    }

    const info = await ensureDaemonRunning();
    const result = await registerDoc(info, {
      filePath,
      documentId,
      documentName,
      projectId,
      projectName,
    });

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
  spawn(cmd, [url], { stdio: "ignore", detached: true }).unref();
}
