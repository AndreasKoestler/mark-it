import type { Plugin } from "vite";
import type { ServerResponse } from "node:http";
import type { ActiveDocument } from "../active-document.js";
import type { Session } from "../server.js";
import type { Db } from "../db/index.js";
import { loadTreeForOrg } from "../db/queries.js";

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

export function markItTreePlugin(
  db: Db | undefined,
  session: Session | null,
  active: ActiveDocument,
): Plugin {
  return {
    name: "mark-it-tree",
    configureServer(server) {
      server.middlewares.use("/api/tree", (req, res) => {
        if (req.method !== "GET") {
          res.statusCode = 405;
          res.end();
          return;
        }
        if (!db || !session) {
          json(res, 200, { legacy: true, projects: [] });
          return;
        }
        const tree = loadTreeForOrg(db, session.orgId);
        const activeId = active.getActive().spec.documentId;
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
