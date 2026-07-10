import { randomUUID } from "node:crypto";
import type { Plugin } from "vite";
import type { ServerResponse } from "node:http";
import { resolveComment } from "@mrsf/cli";
import type { SessionRegistry } from "../daemon/sessions.js";
import { resolveSession } from "../server.js";
import type { EventEnvelope } from "../agent/buffer.js";
import { broadcastAgentEvent } from "./agent-stream.js";
import { readJson } from "../util/read-json.js";

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

interface AgentSendBody {
  text: string;
  resolveIds?: string[];
  comments?: unknown;
}

export function markItAgentPlugin(registry: SessionRegistry): Plugin {
  return {
    name: "mark-it-agent",
    configureServer(server) {
      server.middlewares.use("/api/agent", async (req, res, next) => {
        // Don't shadow /api/agent/events (handled by markItAgentStreamPlugin).
        if (req.url?.startsWith("/api/agent/events")) {
          next();
          return;
        }
        if (req.method !== "POST") {
          next();
          return;
        }
        const r = resolveSession(req, registry);
        if ("error" in r) {
          json(res, r.status, { error: r.error });
          return;
        }
        const sess = r.session;
        try {
          const body = await readJson<AgentSendBody>(req);
          const text = typeof body.text === "string" ? body.text : "";
          const ids = Array.isArray(body.resolveIds) ? body.resolveIds : [];

          if (ids.length > 0) {
            const missing: string[] = [];
            await sess.withWriteLock(async () => {
              const doc = await sess.sidecar.load();
              if (!Array.isArray(doc.comments)) doc.comments = [];
              for (const id of ids) {
                if (!resolveComment(doc, id)) missing.push(id);
              }
              if (missing.length === ids.length) {
                throw new Error(`resolve: none of the ids found: ${missing.join(", ")}`);
              }
              await sess.sidecar.save(doc);
            });
            if (missing.length > 0) {
              // Partial success is OK (some ids resolved); surface unknowns.
              console.error(
                `mark-it: resolveIds not found: ${missing.join(", ")}`,
              );
            }
          }

          const env: EventEnvelope = {
            id: randomUUID(),
            type: "send",
            data: {
              docId: sess.docId,
              text,
              comments: body.comments ?? null,
              resolveIds: ids,
            },
          };
          sess.pushAgentEvent(env);
          broadcastAgentEvent(sess.agentSseClients, env);

          json(res, 200, { ok: true, eventId: env.id });
        } catch (err) {
          json(res, 500, { error: String(err) });
        }
      });
    },
  };
}
