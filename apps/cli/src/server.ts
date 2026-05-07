import { readFile } from "node:fs/promises";
import { basename, relative } from "node:path";
import { spawn } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import {
  addComment,
  editComment,
  resolveComment,
  unresolveComment,
  removeComment,
  type MrsfDocument,
  type AddCommentOptions,
} from "@mrsf/cli";
import type { Db } from "./db/index.js";
import { createActiveDocument, type ActiveDocument } from "./active-document.js";
import { markItSessionPlugin } from "./plugins/session.js";
import { markItTreePlugin } from "./plugins/tree.js";

export interface Session {
  orgId: string;
  orgName: string;
  userId: string;
  userHandle: string;
}

export interface ActiveDocumentSpec {
  filePath: string;
  documentId?: string;
  documentName?: string;
  projectId?: string;
  projectName?: string;
}

export interface StartServerOptions {
  port: number;
  open: boolean;
  db?: Db;
  session?: Session | null;
  initialActive: ActiveDocumentSpec;
}

const WEB_ROOT = new URL("../web/", import.meta.url).pathname;

class IdentityError extends Error {}

function enforceIdentity(session: Session | null, action: string, payload: unknown): void {
  if (!session) return; // legacy bare-file mode
  if (process.env.MARK_IT_ALLOW_AUTHOR_OVERRIDE === "1") return;
  // Mutations that don't carry an author are pure references (resolve/unresolve/delete
  // by id, resolveAll). Skip them — we still trust the pinned local server boundary.
  const writeActions = new Set(["add", "reply", "edit"]);
  if (!writeActions.has(action)) return;
  const p = payload as { author?: string; actor?: string; x_user_id?: string };
  const author = p.author ?? p.actor;
  if (author !== session.userHandle || p.x_user_id !== session.userId) {
    throw new IdentityError("403: identity mismatch");
  }
}

/**
 * Turns "tab closed" into a process exit.
 *
 * The browser fires `navigator.sendBeacon("/api/bye")` on `pagehide`, giving
 * us an explicit, reliable signal that the user is leaving. We schedule a
 * grace timer on bye; a new SSE connect within the window cancels it (this
 * is what absorbs page reloads — pagehide → bye, then the reload connects
 * fresh and we cancel).
 */
const IDLE_EXIT_GRACE_MS = Number(process.env.MARK_IT_IDLE_EXIT_GRACE_MS) || 3_000;

interface Lifecycle {
  clients: Set<ServerResponse>;
  onClientConnect(): void;
  onBye(): void;
}

function createLifecycle(): Lifecycle {
  const clients = new Set<ServerResponse>();
  let everSawClient = false;
  let exitTimer: NodeJS.Timeout | null = null;
  const autoExitDisabled = process.env.MARK_IT_NO_AUTO_EXIT === "1";

  function scheduleExit() {
    if (autoExitDisabled || exitTimer) return;
    exitTimer = setTimeout(() => {
      console.error(`mark-it: client gone for ${IDLE_EXIT_GRACE_MS}ms, exiting.`);
      process.exit(0);
    }, IDLE_EXIT_GRACE_MS);
    exitTimer.unref();
  }

  function cancelExit() {
    if (exitTimer) {
      clearTimeout(exitTimer);
      exitTimer = null;
    }
  }

  return {
    clients,
    onClientConnect() {
      everSawClient = true;
      cancelExit();
    },
    onBye() {
      if (everSawClient) scheduleExit();
    },
  };
}

export async function startServer(opts: StartServerOptions): Promise<void> {
  const lifecycle = createLifecycle();

  const active = createActiveDocument({
    initial: opts.initialActive,
    db: opts.db,
    session: opts.session,
    clients: lifecycle.clients,
    broadcastSse,
  });

  // Kick off the startup re-anchor in parallel with Vite's startup work.
  const reanchorPromise = active.ensureFreshAnchors();

  const server = await createServer({
    root: WEB_ROOT,
    server: {
      port: opts.port,
      strictPort: false,
      host: process.env.MARK_IT_HOST,
      warmup: { clientFiles: ["./main.tsx"] },
    },
    optimizeDeps: {
      entries: ["main.tsx"],
      include: [
        "react",
        "react-dom/client",
        "react/jsx-runtime",
        "@mrsf/rehype-mrsf",
        "@mrsf/rehype-mrsf/controller",
      ],
      exclude: ["@mark-it/core", "@mark-it/react"],
    },
    plugins: [
      react({ jsxRuntime: "automatic" }),
      markItDocumentPlugin(active),
      markItSidecarPlugin(active, opts.session ?? null),
      markItEventsPlugin(lifecycle),
      markItAgentPlugin(active),
      markItSessionPlugin(active, opts.session ?? null, opts.db),
      markItTreePlugin(opts.db, opts.session ?? null, active),
    ],
    define: {
      __MARK_IT_FILE_NAME__: JSON.stringify(basename(opts.initialActive.filePath)),
    },
    clearScreen: false,
  });

  await server.listen();
  const url = server.resolvedUrls?.local[0] ?? `http://localhost:${opts.port}/`;
  server.printUrls();
  console.error(`mark-it: serving ${opts.initialActive.filePath}`);

  await reanchorPromise;

  if (opts.open) {
    openBrowser(url);
  }
}

function markItDocumentPlugin(active: ActiveDocument): Plugin {
  return {
    name: "mark-it-document",
    configureServer(server) {
      server.middlewares.use("/api/document", async (req, res, next) => {
        if (req.method !== "GET") {
          next();
          return;
        }
        try {
          const { spec } = active.getActive();
          const content = await readFile(spec.filePath, "utf8");
          json(res, 200, {
            path: spec.filePath,
            name: basename(spec.filePath),
            content,
          });
        } catch (err) {
          json(res, 500, { error: String(err) });
        }
      });
    },
  };
}

function markItSidecarPlugin(active: ActiveDocument, session: Session | null): Plugin {
  return {
    name: "mark-it-sidecar",
    configureServer(server) {
      async function loadDoc(): Promise<MrsfDocument> {
        const { spec, sidecar } = active.getActive();
        const doc = await sidecar.load();
        if (!doc.document) {
          doc.document = relative(process.cwd(), spec.filePath);
        }
        return doc;
      }

      server.middlewares.use("/api/sidecar", async (req, res, next) => {
        if (req.method === "GET") {
          try {
            // Watcher-driven re-anchoring is a latency optimization, not a
            // correctness path: editor swap-write patterns and bursty edits
            // can slip past chokidar. Re-checking on every GET ensures the
            // client never sees a stale anchor on refresh.
            await active.ensureFreshAnchors();
            const doc = await loadDoc();
            const { spec } = active.getActive();
            const sidecarPath = `${spec.filePath}.review.yaml`;
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
            const { spec, sidecar } = active.getActive();
            const updated = await applyAction(
              doc,
              body.action,
              body.payload,
              spec.filePath,
              session,
            );
            await sidecar.save(updated);
            const sidecarPath = `${spec.filePath}.review.yaml`;
            json(res, 200, { doc: updated, sidecarPath });
          } catch (err) {
            if (err instanceof IdentityError) {
              json(res, 403, { error: err.message });
              return;
            }
            json(res, 400, { error: String(err) });
          }
          return;
        }

        next();
      });
    },
  };
}

const SEND_BEGIN = "===MARK-IT-SEND-BEGIN===";
const SEND_END = "===MARK-IT-SEND-END===";

function markItAgentPlugin(active: ActiveDocument): Plugin {
  return {
    name: "mark-it-agent",
    configureServer(server) {
      server.middlewares.use("/api/agent", async (req, res, next) => {
        if (req.method !== "POST") {
          next();
          return;
        }
        try {
          const body = await readJson<{ text: string; resolveIds?: string[] }>(req);
          const text = typeof body.text === "string" ? body.text : "";
          const ids = Array.isArray(body.resolveIds) ? body.resolveIds : [];

          if (ids.length > 0) {
            const { sidecar } = active.getActive();
            const doc = await sidecar.load();
            if (!Array.isArray(doc.comments)) doc.comments = [];
            for (const id of ids) resolveComment(doc, id);
            await sidecar.save(doc);
          }

          json(res, 200, { ok: true });

          // Stream the chunk to the agent — wrapped in delimiter lines so the
          // receiving side can frame multiple rounds in one mark-it lifetime.
          res.on("finish", () => {
            const inner = text.endsWith("\n") ? text : text + "\n";
            process.stdout.write(`${SEND_BEGIN}\n${inner}${SEND_END}\n`);
          });
        } catch (err) {
          json(res, 500, { error: String(err) });
        }
      });
    },
  };
}

function markItEventsPlugin(lifecycle: Lifecycle): Plugin {
  return {
    name: "mark-it-events",
    configureServer(server) {
      server.middlewares.use("/api/bye", (req, res, next) => {
        if (req.method !== "POST" && req.method !== "GET") {
          next();
          return;
        }
        lifecycle.onBye();
        json(res, 200, { ok: true });
      });

      server.middlewares.use("/api/events", (req, res) => {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.write("event: ready\ndata: {}\n\n");
        lifecycle.clients.add(res);
        lifecycle.onClientConnect();

        req.on("close", () => {
          lifecycle.clients.delete(res);
        });
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
  session: Session | null,
): Promise<MrsfDocument> {
  enforceIdentity(session, action, payload);
  switch (action) {
    case "add": {
      const p = payload as Partial<AddCommentOptions> & {
        selected_text?: string;
        x_user_id?: string;
      };
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
      if (last && p.x_user_id) {
        (last as { x_user_id?: string } & typeof last).x_user_id = p.x_user_id;
      }
      return doc;
    }
    case "reply": {
      const p = payload as {
        parentId?: string;
        text?: string;
        author?: string;
        x_user_id?: string;
      };
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
      const lastReply = doc.comments[doc.comments.length - 1];
      if (lastReply && p.x_user_id) {
        (lastReply as { x_user_id?: string } & typeof lastReply).x_user_id = p.x_user_id;
      }
      return doc;
    }
    case "edit": {
      const p = payload as {
        commentId?: string;
        text?: string;
        actor?: string;
        x_user_id?: string;
      };
      if (!p?.commentId || !p.text) {
        throw new Error("edit: commentId and text are required");
      }
      editComment(doc, p.commentId, { text: p.text, actor: p.actor });
      if (p.x_user_id) {
        const target = doc.comments.find((c) => c.id === p.commentId);
        if (target) {
          (target as { x_user_id?: string } & typeof target).x_user_id = p.x_user_id;
        }
      }
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
      const p = payload as { commentId?: string; cascade?: boolean };
      if (!p?.commentId) throw new Error("delete: commentId required");
      if (!removeComment(doc, p.commentId, { cascade: p.cascade ?? false })) {
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
