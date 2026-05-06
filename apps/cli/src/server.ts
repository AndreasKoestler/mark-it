import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, relative } from "node:path";
import { spawn } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import chokidar from "chokidar";
import {
  parseSidecar,
  writeSidecar,
  addComment,
  resolveComment,
  unresolveComment,
  removeComment,
  reanchorDocumentText,
  applyReanchorResults,
  type MrsfDocument,
  type AddCommentOptions,
} from "@mrsf/cli";

export interface StartServerOptions {
  filePath: string;
  port: number;
  open: boolean;
}

const WEB_ROOT = new URL("../web/", import.meta.url).pathname;

export async function startServer(opts: StartServerOptions): Promise<void> {
  const sidecarPath = `${opts.filePath}.review.yaml`;
  const sseClients = new Set<ServerResponse>();

  const server = await createServer({
    root: WEB_ROOT,
    server: {
      port: opts.port,
      strictPort: false,
    },
    plugins: [
      react(),
      markItDocumentPlugin(opts.filePath),
      markItSidecarPlugin(opts.filePath, sidecarPath),
      markItEventsPlugin(sseClients),
    ],
    define: {
      __MARK_IT_FILE_NAME__: JSON.stringify(basename(opts.filePath)),
    },
    clearScreen: false,
  });

  await server.listen();
  const url = server.resolvedUrls?.local[0] ?? `http://localhost:${opts.port}/`;
  server.printUrls();
  console.error(`mark-it: serving ${opts.filePath}`);

  // File watcher: re-anchor comments and notify clients on change.
  const watcher = chokidar.watch(opts.filePath, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 25 },
  });

  watcher.on("change", async () => {
    try {
      if (existsSync(sidecarPath)) {
        const doc = await parseSidecar(sidecarPath);
        const content = await readFile(opts.filePath, "utf8");
        const results = await reanchorDocumentText(doc, content);
        applyReanchorResults(doc, results);
        await writeSidecar(sidecarPath, doc);
      }
    } catch (err) {
      console.error("mark-it: re-anchor failed:", err);
    }
    broadcastSse(sseClients, "change");
  });

  if (opts.open) {
    openBrowser(url);
  }
}

function markItDocumentPlugin(filePath: string): Plugin {
  return {
    name: "mark-it-document",
    configureServer(server) {
      server.middlewares.use("/api/document", async (req, res, next) => {
        if (req.method !== "GET") {
          next();
          return;
        }
        try {
          const content = await readFile(filePath, "utf8");
          json(res, 200, {
            path: filePath,
            name: basename(filePath),
            content,
          });
        } catch (err) {
          json(res, 500, { error: String(err) });
        }
      });
    },
  };
}

function markItSidecarPlugin(filePath: string, sidecarPath: string): Plugin {
  return {
    name: "mark-it-sidecar",
    configureServer(server) {
      const documentRel = relative(process.cwd(), filePath);

      async function loadDoc(): Promise<MrsfDocument> {
        if (!existsSync(sidecarPath)) {
          return {
            mrsf_version: "1.0",
            document: documentRel,
            comments: [],
          };
        }
        return await parseSidecar(sidecarPath);
      }

      server.middlewares.use("/api/sidecar", async (req, res, next) => {
        if (req.method === "GET") {
          try {
            const doc = await loadDoc();
            json(res, 200, { doc, sidecarPath });
          } catch (err) {
            json(res, 500, { error: String(err) });
          }
          return;
        }

        if (req.method === "POST") {
          try {
            const body = await readJson<{ action: string; payload?: unknown }>(req);
            const doc = await loadDoc();
            const updated = await applyAction(doc, body.action, body.payload, filePath);
            await writeSidecar(sidecarPath, updated);
            json(res, 200, { doc: updated, sidecarPath });
          } catch (err) {
            json(res, 400, { error: String(err) });
          }
          return;
        }

        next();
      });
    },
  };
}

function markItEventsPlugin(clients: Set<ServerResponse>): Plugin {
  return {
    name: "mark-it-events",
    configureServer(server) {
      server.middlewares.use("/api/events", (req, res) => {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.write("event: ready\ndata: {}\n\n");
        clients.add(res);
        req.on("close", () => clients.delete(res));
      });
    },
  };
}

function broadcastSse(clients: Set<ServerResponse>, event: string): void {
  const payload = `event: ${event}\ndata: {}\n\n`;
  for (const c of clients) {
    try {
      c.write(payload);
    } catch {
      clients.delete(c);
    }
  }
}

async function applyAction(
  doc: MrsfDocument,
  action: string,
  payload: unknown,
  filePath: string,
): Promise<MrsfDocument> {
  switch (action) {
    case "add": {
      const p = payload as Partial<AddCommentOptions> & { selected_text?: string };
      if (!p?.text || !p.author) throw new Error("add: text and author are required");
      const opts: AddCommentOptions = {
        text: p.text,
        author: p.author,
        line: p.line,
        end_line: p.end_line,
      };
      await addComment(doc, opts);
      const last = doc.comments[doc.comments.length - 1];
      if (last && p.selected_text) {
        last.selected_text = p.selected_text;
      }
      if (last && !last.selected_text && p.line) {
        const docContent = await readFile(filePath, "utf8");
        const lines = docContent.split(/\r?\n/);
        const startIdx = (p.line ?? 1) - 1;
        const endIdx = (p.end_line ?? p.line ?? 1) - 1;
        const slice = lines.slice(startIdx, endIdx + 1).join("\n");
        if (slice) last.selected_text = slice;
      }
      return doc;
    }
    case "reply": {
      const p = payload as { parentId?: string; text?: string; author?: string };
      if (!p?.parentId || !p.text || !p.author) {
        throw new Error("reply: parentId, text, author are required");
      }
      const parent = doc.comments.find((c) => c.id === p.parentId);
      if (!parent) throw new Error(`reply: parent ${p.parentId} not found`);
      await addComment(doc, {
        text: p.text,
        author: p.author,
        line: parent.line,
        end_line: parent.end_line,
        reply_to: p.parentId,
      });
      return doc;
    }
    case "resolve": {
      const p = payload as { commentId?: string };
      if (!p?.commentId) throw new Error("resolve: commentId required");
      if (!resolveComment(doc, p.commentId)) {
        throw new Error(`resolve: ${p.commentId} not found`);
      }
      return doc;
    }
    case "unresolve": {
      const p = payload as { commentId?: string };
      if (!p?.commentId) throw new Error("unresolve: commentId required");
      if (!unresolveComment(doc, p.commentId)) {
        throw new Error(`unresolve: ${p.commentId} not found`);
      }
      return doc;
    }
    case "delete": {
      const p = payload as { commentId?: string };
      if (!p?.commentId) throw new Error("delete: commentId required");
      if (!removeComment(doc, p.commentId)) {
        throw new Error(`delete: ${p.commentId} not found`);
      }
      return doc;
    }
    case "resolveAll": {
      for (const c of doc.comments) c.resolved = true;
      return doc;
    }
    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(raw) as T;
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open" :
    process.platform === "win32" ? "start" :
    "xdg-open";
  spawn(cmd, [url], { stdio: "ignore", detached: true }).unref();
}
