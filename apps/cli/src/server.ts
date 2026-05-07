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
  editComment,
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

/**
 * Turns "tab closed" into a process exit.
 *
 * The browser fires `navigator.sendBeacon("/api/bye")` on `pagehide`, giving
 * us an explicit, reliable signal that the user is leaving. We schedule a
 * grace timer on bye; a new SSE connect within the window cancels it (this
 * is what absorbs page reloads — pagehide → bye, then the reload connects
 * fresh and we cancel).
 *
 * We deliberately do NOT use SSE socket close as an exit trigger. Node's
 * `req.on("close")` is unreliable on Vite's connect middleware for idle
 * keep-alive sockets — empirically, killing the client doesn't always fire
 * the event. The bye beacon side-steps that entirely.
 *
 * Known limitation: closing one of multiple tabs viewing the same file will
 * trigger an exit that kills the other tabs' SSE streams. Multi-tab review
 * isn't supported in v1.
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

  // Opt-out for harnesses that don't run a real browser tab.
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
  const sidecarPath = `${opts.filePath}.review.yaml`;
  const lifecycle = createLifecycle();

  // Kick off the startup re-anchor in parallel with Vite's own startup work.
  // It writes the sidecar before the first /api/sidecar GET because Vite's
  // listen() and the browser's first request take longer than this read +
  // fuzzy match in any realistic case; if the race ever lost, the worst case
  // is the user sees stale text for ~1 frame, then the sidecar arrives.
  const reanchorPromise = runStartupReanchor(opts.filePath, sidecarPath);

  const server = await createServer({
    root: WEB_ROOT,
    server: {
      port: opts.port,
      strictPort: false,
      // Allow tests / specific environments to pin the bind address. Default
      // is Vite's normal "loopback on all available families" behavior.
      host: process.env.MARK_IT_HOST,
      // Pre-fetch the entry so Vite's transform pipeline is hot before the
      // browser asks for it. Cuts ~150–300ms off first-paint in dev.
      warmup: { clientFiles: ["./main.tsx"] },
    },
    optimizeDeps: {
      // Tell esbuild up-front what to pre-bundle so the optimizer runs once
      // at startup instead of being triggered by the first browser request.
      entries: ["main.tsx"],
      include: [
        "react",
        "react-dom/client",
        "react/jsx-runtime",
        "@mrsf/rehype-mrsf",
        "@mrsf/rehype-mrsf/controller",
      ],
      // Workspace packages must NOT be pre-bundled — Vite would cache the
      // bundle and miss subsequent source edits, breaking HMR on cross-
      // package changes.
      exclude: ["@mark-it/core", "@mark-it/react"],
    },
    plugins: [
      // Skip plugin's runtime auto-detection — we know the React 19 automatic
      // runtime is the right answer.
      react({ jsxRuntime: "automatic" }),
      markItDocumentPlugin(opts.filePath),
      markItSidecarPlugin(opts.filePath, sidecarPath),
      markItEventsPlugin(lifecycle),
      markItAgentPlugin(opts.filePath, sidecarPath),
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

  // Wait for the startup re-anchor (already in flight) so the watcher arms
  // against a fresh sidecar; if it lost the race, that's harmless.
  await reanchorPromise;

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
    broadcastSse(lifecycle.clients, "change");
  });

  if (opts.open) {
    openBrowser(url);
  }
}

async function runStartupReanchor(
  filePath: string,
  sidecarPath: string,
): Promise<void> {
  if (!existsSync(sidecarPath)) return;
  try {
    const doc = await parseSidecar(sidecarPath);
    if (!Array.isArray(doc.comments) || doc.comments.length === 0) return;
    const content = await readFile(filePath, "utf8");
    const results = await reanchorDocumentText(doc, content);
    applyReanchorResults(doc, results);
    await writeSidecar(sidecarPath, doc);
  } catch (err) {
    console.error("mark-it: startup re-anchor failed:", err);
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
        const parsed = await parseSidecar(sidecarPath);
        // YAML "comments:" with no value parses as null — normalize to [].
        if (!Array.isArray(parsed.comments)) {
          parsed.comments = [];
        }
        return parsed;
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

/** Wraps each Send chunk so the receiving agent can frame multiple rounds. */
const SEND_BEGIN = "===MARK-IT-SEND-BEGIN===";
const SEND_END = "===MARK-IT-SEND-END===";

function markItAgentPlugin(filePath: string, sidecarPath: string): Plugin {
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
            const doc = existsSync(sidecarPath)
              ? await parseSidecar(sidecarPath)
              : null;
            if (doc) {
              if (!Array.isArray(doc.comments)) doc.comments = [];
              for (const id of ids) resolveComment(doc, id);
              await writeSidecar(sidecarPath, doc);
            }
          }

          json(res, 200, { ok: true });

          // Stream the chunk to the agent — wrapped in delimiter lines so the
          // receiving side can frame multiple rounds in one mark-it lifetime.
          // The server stays alive after this; exit is driven by the user
          // closing the browser tab (see Lifecycle / markItEventsPlugin).
          // process.stdout.write may return false when the consumer is slow;
          // for human send rates that's negligible — we don't honor backpressure.
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
      // Explicit "tab is closing" signal from the browser via sendBeacon on
      // pagehide. Short-circuits the wait for the SSE close event.
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

        // Best-effort cleanup so broadcastSse doesn't keep writing to dead
        // sockets. The close event isn't reliable enough to drive exit
        // decisions — that's what /api/bye is for.
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
    case "edit": {
      const p = payload as { commentId?: string; text?: string; actor?: string };
      if (!p?.commentId || !p.text) {
        throw new Error("edit: commentId and text are required");
      }
      editComment(doc, p.commentId, { text: p.text, actor: p.actor });
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
