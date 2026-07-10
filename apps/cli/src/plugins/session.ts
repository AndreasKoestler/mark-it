import { basename } from "node:path";
import type { Plugin } from "vite";
import type { ServerResponse } from "node:http";
import type { SessionRegistry } from "../daemon/sessions.js";
import { resolveSession } from "../server.js";
import type { Db } from "../db/index.js";
import { findDocumentById } from "../db/queries.js";
import { readJson } from "../util/read-json.js";

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

export function markItSessionPlugin(registry: SessionRegistry, db?: Db): Plugin {
  return {
    name: "mark-it-session",
    configureServer(server) {
      server.middlewares.use("/api/session", (req, res) => {
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
        const { spec, docId, session } = r.session;
        if (!session) {
          json(res, 200, {
            legacy: true,
            docId,
            active: { filePath: spec.filePath, name: basename(spec.filePath) },
          });
          return;
        }
        json(res, 200, {
          docId,
          org: { id: session.orgId, name: session.orgName },
          user: { id: session.userId, handle: session.userHandle },
          active: {
            documentId: spec.documentId,
            documentName: spec.documentName,
            projectId: spec.projectId,
            projectName: spec.projectName,
            filePath: spec.filePath,
          },
        });
      });

      server.middlewares.use("/api/document/select", async (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end();
          return;
        }
        if (!db) {
          res.statusCode = 400;
          res.end();
          return;
        }
        const current = resolveSession(req, registry);
        const session = "error" in current ? null : current.session.session;
        if (!session) {
          res.statusCode = 400;
          res.end();
          return;
        }
        try {
          const body = await readJson<{ documentId: string }>(req);
          const doc = findDocumentById(db, body.documentId);
          if (!doc) {
            json(res, 404, { error: "document not found" });
            return;
          }
          // Cross-org guard via JOIN to projects.
          const project = db
            .query<{ org_id: string; name: string }, [string]>(
              "SELECT org_id, name FROM projects WHERE id = ?",
            )
            .get(doc.project_id);
          if (!project || project.org_id !== session.orgId) {
            json(res, 403, { error: "cross-org access denied" });
            return;
          }
          // Register (or reuse) a session for the requested doc and make it
          // the registry's active doc — legacy in-place tab swap.
          const sess = registry.register(
            {
              filePath: doc.file_path,
              documentId: doc.id,
              documentName: doc.name,
              projectId: doc.project_id,
              projectName: project.name,
            },
            { db, session },
          );
          registry.setActive(sess.docId);
          await sess.ensureFreshAnchors();
          // Tell connected tabs to re-fetch.
          registry.broadcast(sess.docId, "change");
          json(res, 200, { ok: true, docId: sess.docId });
        } catch (err) {
          json(res, 500, { error: String(err) });
        }
      });
    },
  };
}
