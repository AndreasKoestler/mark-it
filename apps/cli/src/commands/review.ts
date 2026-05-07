import { defineCommand } from "citty";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startServer } from "../server.js";

export const reviewCommand = defineCommand({
  meta: { name: "review", description: "Open a Markdown file in mark-it's review UI." },
  args: {
    file: {
      type: "positional",
      description: "Path to the Markdown file. Omit to read from stdin.",
      required: false,
    },
    port: {
      type: "string",
      description: "Port to bind the dev server to (default: 5173).",
      default: "5173",
    },
    "no-open": {
      type: "boolean",
      description: "Do not auto-open the browser.",
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
    const port = Number(args.port) || 5173;
    const open = !args["no-open"];

    if (args.org && args.project && args.user) {
      console.error("mark-it: --org/--project/--user wired in Phase 3; running legacy mode for now.");
    }

    await startServer({ filePath, port, open });
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

  // Read stdin into a temp file.
  if (process.stdin.isTTY) {
    console.error("mark-it: pass a file path or pipe Markdown into stdin.");
    process.exit(1);
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const content = Buffer.concat(chunks).toString("utf8");

  const dir = mkdtempSync(join(tmpdir(), "mark-it-"));
  const tmpPath = join(dir, "stdin.md");
  writeFileSync(tmpPath, content, "utf8");
  console.error(`mark-it: stdin captured to ${tmpPath}`);
  return tmpPath;
}
