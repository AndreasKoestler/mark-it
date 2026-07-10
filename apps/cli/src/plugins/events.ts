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
  /** Called by the browser's pagehide beacon (server-wide). */
  onBye?(): void;
  /** Per-doc bye — schedules unregister after a grace window. */
  onByeForDoc?(docId: string): void;
  /** Per-doc connect — cancels any pending unregister for that doc. */
  onDocConnect?(docId: string): void;
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
        // Per-doc bye lets the daemon schedule unregister of an unwatched
        // session after a grace window. Reads ?doc from URL since /api/bye
        // is fired by sendBeacon, which can't carry headers.
        if (lifecycle.onByeForDoc) {
          const url = new URL(req.url ?? "", "http://localhost");
          const docId = url.searchParams.get("doc");
          if (docId) lifecycle.onByeForDoc(docId);
        }
        json(res, 200, { ok: true });
      });

      server.middlewares.use("/api/events", (req, res) => {
        if (req.method !== "GET") {
          res.statusCode = 405;
          res.end();
          return;
        }
        const r = resolveSession(req, registry);
        if ("error" in r) {
          json(res, r.status, { error: r.error });
          return;
        }
        const sess = r.session;

        res.statusCode = 200;
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.write("event: ready\ndata: {}\n\n");

        sess.lifecycleClients.add(res);
        lifecycle.onDocConnect?.(sess.docId);
        if (lifecycle.globalClients) lifecycle.globalClients.add(res);
        lifecycle.onConnect?.();

        req.on("close", () => {
          sess.lifecycleClients.delete(res);
          if (lifecycle.globalClients) lifecycle.globalClients.delete(res);
        });
      });
    },
  };
}
