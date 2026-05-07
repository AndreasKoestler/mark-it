import type { Plugin } from "vite";
import type { ServerResponse } from "node:http";
import type { SessionRegistry } from "../daemon/sessions.js";
import { resolveSession } from "../server.js";
import type { EventEnvelope } from "../agent/buffer.js";

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function formatEvent(env: EventEnvelope): string {
  return `id: ${env.id}\nevent: ${env.type}\ndata: ${JSON.stringify(env.data)}\n\n`;
}

export function markItAgentStreamPlugin(
  registry: SessionRegistry,
  hooks: { onDocConnect?(docId: string): void } = {},
): Plugin {
  return {
    name: "mark-it-agent-stream",
    configureServer(server) {
      server.middlewares.use("/api/agent/events", (req, res) => {
        if (req.method !== "GET") {
          res.statusCode = 405;
          res.end();
          return;
        }
        const r = resolveSession(req, registry);
        if ("error" in r) {
          writeJson(res, r.status, { error: r.error });
          return;
        }
        const sess = r.session;

        res.statusCode = 200;
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");

        // Replay buffered events the client missed (best-effort).
        const lastEventId = req.headers["last-event-id"];
        const since = typeof lastEventId === "string" ? lastEventId : undefined;
        for (const env of sess.agentBuffer.replaySince(since)) {
          res.write(formatEvent(env));
        }

        res.write("event: ready\ndata: {}\n\n");
        sess.agentSseClients.add(res);
        // Tail subscribers count as "this doc is in use" — cancel any
        // pending bye-driven unregister for the same docId.
        hooks.onDocConnect?.(sess.docId);

        req.on("close", () => {
          sess.agentSseClients.delete(res);
        });
      });
    },
  };
}

export function broadcastAgentEvent(
  clients: Set<ServerResponse>,
  env: EventEnvelope,
): void {
  const payload = formatEvent(env);
  for (const c of clients) {
    try {
      c.write(payload);
    } catch {
      clients.delete(c);
    }
  }
}
