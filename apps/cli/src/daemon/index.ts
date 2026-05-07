import { randomBytes } from "node:crypto";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { createSessionRegistry } from "./sessions.js";
import { createDiscovery, type DaemonInfo } from "./discovery.js";
import { markItAuthPlugin } from "./auth-plugin.js";
import { markItRegistryPlugin } from "../plugins/registry.js";
import { markItDocumentPlugin } from "../plugins/document.js";
import { markItSidecarPlugin } from "../plugins/sidecar.js";
import { markItAgentPlugin } from "../plugins/agent.js";
import { markItEventsPlugin } from "../plugins/events.js";
import { markItSessionPlugin } from "../plugins/session.js";
import { markItTreePlugin } from "../plugins/tree.js";
import type { Db } from "../db/index.js";

const WEB_ROOT = new URL("../../web/", import.meta.url).pathname;

export interface StartDaemonOptions {
  port: number;
  host: string;
  /** Idle exit threshold in seconds. 0 disables (manual stop only). */
  idleSecs: number;
  /** Optional DB path (multi-user mode). */
  db?: Db;
}

interface DaemonLifecycle {
  start(): void;
  bump(): void;
}

function createDaemonLifecycle(opts: {
  idleSecs: number;
  hasActivity: () => boolean;
  onExit: () => void | Promise<void>;
}): DaemonLifecycle {
  let lastActivity = Date.now();
  let timer: NodeJS.Timeout | null = null;
  const intervalMs = Math.min(5_000, Math.max(500, opts.idleSecs * 200));

  function tick() {
    if (opts.idleSecs <= 0) return;
    if (opts.hasActivity()) {
      lastActivity = Date.now();
      return;
    }
    if (Date.now() - lastActivity >= opts.idleSecs * 1000) {
      void opts.onExit();
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(tick, intervalMs);
      timer.unref();
    },
    bump() {
      lastActivity = Date.now();
    },
  };
}

export async function startDaemon(opts: StartDaemonOptions): Promise<void> {
  const token = randomBytes(32).toString("hex");
  const discovery = createDiscovery();
  // Pick a random unprivileged port up-front so we don't fight Vite's
  // 5173-then-retry logic, which is slow when 5173 is held by another
  // dev server and noisy in test output.
  const wantPort = opts.port > 0 ? opts.port : await pickFreePort();

  const registry = createSessionRegistry({
    broadcast: (docId, event) => {
      const sess = registry.get(docId);
      if (!sess) return;
      broadcastSseClients(sess.lifecycleClients, event);
    },
  });

  const originHolder = { value: "" };

  const lifecycle = createDaemonLifecycle({
    idleSecs: opts.idleSecs,
    // Active as long as a doc is registered. Each register/SSE-connect/HTTP
    // hit also bumps activity to absorb post-bye grace windows.
    hasActivity: () => registry.size() > 0,
    onExit: async () => {
      console.error(`mark-it daemon: idle for ${opts.idleSecs}s, exiting.`);
      await discovery.clear();
      process.exit(0);
    },
  });

  const server = await createServer({
    root: WEB_ROOT,
    server: {
      port: wantPort,
      strictPort: false,
      host: opts.host,
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
      markItAuthPlugin(token),
      react({ jsxRuntime: "automatic" }),
      markItRegistryPlugin({
        registry,
        db: opts.db,
        defaultSession: null,
        origin: () => originHolder.value,
        token,
        bumpActivity: () => lifecycle.bump(),
      }),
      markItDocumentPlugin(registry),
      markItSidecarPlugin(registry, null),
      markItEventsPlugin(registry, {
        onConnect: () => lifecycle.bump(),
      }),
      markItAgentPlugin(registry),
      markItSessionPlugin(registry, null, opts.db),
      markItTreePlugin(opts.db, null, registry),
    ],
    define: {
      __MARK_IT_FILE_NAME__: JSON.stringify("(daemon)"),
    },
    clearScreen: false,
  });

  await server.listen();
  const port =
    (server.httpServer?.address() as { port: number } | null)?.port ?? opts.port;
  const origin = `http://${opts.host}:${port}`;
  originHolder.value = origin;

  await discovery.write({ port, token, pid: process.pid });

  const onSignal = async (sig: NodeJS.Signals) => {
    console.error(`mark-it daemon: received ${sig}, shutting down`);
    await discovery.clear();
    for (const sess of registry.all()) {
      try {
        await registry.unregister(sess.docId);
      } catch {
        /* swallow */
      }
    }
    await server.close();
    process.exit(0);
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  console.error(
    `mark-it daemon: listening on ${origin} (pid ${process.pid}, idle=${opts.idleSecs}s)`,
  );
  lifecycle.start();
}

async function pickFreePort(): Promise<number> {
  const { createServer: createNetServer } = await import("node:net");
  return new Promise((resolveOk, reject) => {
    const srv = createNetServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolveOk(port));
    });
  });
}

function broadcastSseClients(clients: Set<import("node:http").ServerResponse>, event: string): void {
  const payload = `event: ${event}\ndata: {}\n\n`;
  for (const c of clients) {
    try {
      c.write(payload);
    } catch {
      clients.delete(c);
    }
  }
}

export type { DaemonInfo };
