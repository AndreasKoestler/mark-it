import type { Plugin } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SessionRegistry } from "../daemon/sessions.js";
import type { Db } from "../db/index.js";
import type { ActiveDocumentSpec, Session } from "../server.js";
import { docIdForSpec } from "../daemon/ids.js";

interface RegistryDeps {
  registry: SessionRegistry;
  db?: Db;
  /** Daemon origin (resolved lazily — Vite's listen port isn't known at plugin-construction time). */
  origin: () => string;
  /** Token to include on the returned URL so the browser can authenticate. */
  token: string;
  /** Called when client activity should reset the daemon's idle timer. */
  bumpActivity?: () => void;
}

interface RegisterRequestBody extends ActiveDocumentSpec {
  /** Caller-resolved identity for this doc, e.g. from `mark-it open --org/--project/--user`. */
  session?: Session | null;
}

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
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

export function markItRegistryPlugin(deps: RegistryDeps): Plugin {
  return {
    name: "mark-it-registry",
    configureServer(server) {
      server.middlewares.use("/api/registry/list", (req, res) => {
        if (req.method !== "GET") {
          res.statusCode = 405;
          res.end();
          return;
        }
        deps.bumpActivity?.();
        json(res, 200, {
          docs: deps.registry.all().map((s) => ({
            docId: s.docId,
            filePath: s.spec.filePath,
            documentName: s.spec.documentName ?? null,
          })),
        });
      });

      server.middlewares.use("/api/registry/register", async (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end();
          return;
        }
        try {
          const body = await readJson<RegisterRequestBody>(req);
          const { session, ...spec } = body;
          if (!spec.filePath) {
            json(res, 400, { error: "filePath required" });
            return;
          }
          if (session && !deps.db) {
            // A session with no DB behind it would silently fall back to
            // disk persistence (see daemon/sessions.ts's makeStore) despite
            // --org/--project/--user — fail loudly instead. This daemon was
            // spawned without --db, or with a different one than the caller
            // resolved its org/project/document against.
            json(res, 409, {
              error:
                "mark-it: daemon has no database open — restart it with a matching --db, " +
                "or drop --org/--project/--user for disk-sidecar mode",
            });
            return;
          }
          const newId = docIdForSpec(spec);
          const wasRegistered = deps.registry.get(newId) !== undefined;
          const sess = deps.registry.register(spec, {
            db: deps.db,
            session: session ?? null,
          });
          deps.registry.setActive(sess.docId);

          if (wasRegistered) {
            // Tell any open tab on this doc to come to the front.
            deps.registry.broadcast(sess.docId, "focus");
          }

          deps.bumpActivity?.();
          const url = `${deps.origin()}/?doc=${encodeURIComponent(sess.docId)}&token=${encodeURIComponent(deps.token)}`;
          json(res, 200, { docId: sess.docId, url, focused: wasRegistered });
        } catch (err) {
          json(res, 500, { error: String(err) });
        }
      });

      server.middlewares.use("/api/registry/unregister", async (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end();
          return;
        }
        try {
          const body = await readJson<{ docId?: string }>(req);
          if (!body.docId) {
            json(res, 400, { error: "docId required" });
            return;
          }
          await deps.registry.unregister(body.docId);
          deps.bumpActivity?.();
          json(res, 200, { ok: true });
        } catch (err) {
          json(res, 500, { error: String(err) });
        }
      });

      server.middlewares.use("/api/registry/health", (req, res) => {
        if (req.method !== "GET") {
          res.statusCode = 405;
          res.end();
          return;
        }
        deps.bumpActivity?.();
        json(res, 200, { ok: true, docs: deps.registry.size() });
      });
    },
  };
}
