import { basename } from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import type { Db } from "./db/index.js";
import {
  createSessionRegistry,
  type DocSession,
  type SessionRegistry,
} from "./daemon/sessions.js";
import { docIdForSpec } from "./daemon/ids.js";
import { markItAuthPlugin } from "./daemon/auth-plugin.js";
import { markItDocumentPlugin } from "./plugins/document.js";
import { markItSidecarPlugin } from "./plugins/sidecar.js";
import { markItAgentPlugin } from "./plugins/agent.js";
import { markItAgentStreamPlugin } from "./plugins/agent-stream.js";
import { markItEventsPlugin } from "./plugins/events.js";
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

const IDLE_EXIT_GRACE_MS =
  Number(process.env.MARK_IT_IDLE_EXIT_GRACE_MS) || 3_000;

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

/**
 * Resolve the DocSession for a request. `?doc=<id>` (or `X-Mark-It-Doc-Id`)
 * picks one explicitly; otherwise the registry's "active" session is used
 * (legacy single-tab semantics — daemon mode requires explicit doc selection
 * for routes that need disambiguation).
 */
export function resolveSession(
  req: IncomingMessage,
  registry: SessionRegistry,
): { session: DocSession } | { error: string; status: number } {
  const url = new URL(req.url ?? "", "http://localhost");
  const explicit =
    url.searchParams.get("doc") ??
    (typeof req.headers["x-mark-it-doc-id"] === "string"
      ? (req.headers["x-mark-it-doc-id"] as string)
      : null);

  if (explicit) {
    const sess = registry.get(explicit);
    if (!sess) return { error: `unknown doc: ${explicit}`, status: 404 };
    return { session: sess };
  }

  const fallback = registry.getActive();
  if (fallback) return { session: fallback };
  return { error: "no sessions", status: 404 };
}

export async function startServer(opts: StartServerOptions): Promise<void> {
  const lifecycle = createLifecycle();
  const registry = createSessionRegistry({
    broadcast: (_docId, event) => {
      broadcastSse(lifecycle.clients, event);
    },
  });

  const initialDoc = registry.register(opts.initialActive, {
    db: opts.db,
    session: opts.session ?? null,
  });

  const reanchorPromise = initialDoc.ensureFreshAnchors();

  // Only session-bearing (multi-user/DB) runs need a token: /api/session
  // reveals the real userId/handle in that mode, and enforceIdentity's check
  // is only meaningful if that identity isn't freely readable by anyone who
  // can reach the port. Plain single-user legacy mode has no identity to
  // protect, so it stays frictionless with no token, as documented.
  const token = opts.session ? randomBytes(32).toString("hex") : null;

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
      ...(token ? [markItAuthPlugin(token)] : []),
      react({ jsxRuntime: "automatic" }),
      markItDocumentPlugin(registry),
      markItSidecarPlugin(registry),
      markItEventsPlugin(registry, {
        globalClients: lifecycle.clients,
        onConnect: () => lifecycle.onClientConnect(),
        onBye: () => lifecycle.onBye(),
      }),
      markItAgentStreamPlugin(registry),
      markItAgentPlugin(registry),
      markItSessionPlugin(registry, opts.db),
      markItTreePlugin(opts.db, registry),
    ],
    define: {
      __MARK_IT_FILE_NAME__: JSON.stringify(basename(opts.initialActive.filePath)),
    },
    clearScreen: false,
  });

  await server.listen();
  const url = server.resolvedUrls?.local[0] ?? `http://localhost:${opts.port}/`;
  const openUrl = token ? `${url}?token=${encodeURIComponent(token)}` : url;
  server.printUrls();
  console.error(`mark-it: serving ${opts.initialActive.filePath}`);
  if (token) console.error(`mark-it: token=${token}`);

  await reanchorPromise;

  if (opts.open) {
    openBrowser(openUrl);
  }
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

export { docIdForSpec };
