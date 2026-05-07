import type { Plugin } from "vite";
import type { ServerResponse } from "node:http";
import type { SessionRegistry } from "../daemon/sessions.js";
import { resolveSession } from "../server.js";

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

interface EventsLifecycle {
  /** Called when a new SSE client connects (resets idle timers, etc). */
  onConnect?(): void;
  /** Called by the browser's pagehide beacon. */
  onBye?(): void;
  /** Optional shared set of all SSE clients (legacy whole-server semantics). */
  globalClients?: Set<ServerResponse>;
}

export function markItEventsPlugin(
  registry: SessionRegistry,
  lifecycle: EventsLifecycle = {},
): Plugin {
  return {
    name: "mark-it-events",
    configureServer(server) {
      server.middlewares.use("/api/bye", (req, res, next) => {
        if (req.method !== "POST" && req.method !== "GET") {
          next();
          return;
        }
        lifecycle.onBye?.();
        json(res, 200, { ok: true });
      });

      server.middlewares.use("/api/events", (req, res) => {
        const r = resolveSession(req, registry);
        const sess = "session" in r ? r.session : null;

        res.statusCode = 200;
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.write("event: ready\ndata: {}\n\n");

        if (sess) sess.lifecycleClients.add(res);
        if (lifecycle.globalClients) lifecycle.globalClients.add(res);
        lifecycle.onConnect?.();

        req.on("close", () => {
          if (sess) sess.lifecycleClients.delete(res);
          if (lifecycle.globalClients) lifecycle.globalClients.delete(res);
        });
      });
    },
  };
}
