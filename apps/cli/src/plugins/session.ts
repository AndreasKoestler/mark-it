import { basename } from "node:path";
import type { Plugin } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ActiveDocument } from "../active-document.js";
import type { Session } from "../server.js";
import type { Db } from "../db/index.js";
import { findDocumentById } from "../db/queries.js";

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

export function markItSessionPlugin(
  active: ActiveDocument,
  session: Session | null,
  db?: Db,
): Plugin {
  return {
    name: "mark-it-session",
    configureServer(server) {
      server.middlewares.use("/api/session", (req, res) => {
        if (req.method !== "GET") {
          res.statusCode = 405;
          res.end();
          return;
        }
        const { spec } = active.getActive();
        if (!session) {
          json(res, 200, {
            legacy: true,
            active: { filePath: spec.filePath, name: basename(spec.filePath) },
          });
          return;
        }
        json(res, 200, {
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
        if (!session || !db) {
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
          await active.setActive({
            filePath: doc.file_path,
            documentId: doc.id,
            documentName: doc.name,
            projectId: doc.project_id,
            projectName: project.name,
          });
          json(res, 200, { ok: true });
        } catch (err) {
          json(res, 500, { error: String(err) });
        }
      });
    },
  };
}
