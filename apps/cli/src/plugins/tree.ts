import type { Plugin } from "vite";
import type { ServerResponse } from "node:http";
import type { SessionRegistry } from "../daemon/sessions.js";
import { resolveSession } from "../server.js";
import type { Db } from "../db/index.js";
import { loadTreeForOrg } from "../db/queries.js";

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

export function markItTreePlugin(db: Db | undefined, registry: SessionRegistry): Plugin {
  return {
    name: "mark-it-tree",
    configureServer(server) {
      server.middlewares.use("/api/tree", (req, res) => {
        if (req.method !== "GET") {
          res.statusCode = 405;
          res.end();
          return;
        }
        const r = resolveSession(req, registry);
        const session = "error" in r ? null : r.session.session;
        if (!db || !session) {
          json(res, 200, { legacy: true, projects: [] });
          return;
        }
        const tree = loadTreeForOrg(db, session.orgId);
        const activeId =
          "session" in r ? r.session.spec.documentId : undefined;
        const annotated = {
          ...tree,
          projects: tree.projects.map((p) => ({
            ...p,
            documents: p.documents.map((d) => ({ ...d, isActive: d.id === activeId })),
          })),
        };
        json(res, 200, annotated);
      });
    },
  };
}
