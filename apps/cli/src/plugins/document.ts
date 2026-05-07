import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { Plugin } from "vite";
import type { ServerResponse } from "node:http";
import type { SessionRegistry } from "../daemon/sessions.js";
import { resolveSession } from "../server.js";

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

export function markItDocumentPlugin(registry: SessionRegistry): Plugin {
  return {
    name: "mark-it-document",
    configureServer(server) {
      server.middlewares.use("/api/document", async (req, res, next) => {
        if (req.method !== "GET") {
          next();
          return;
        }
        const r = resolveSession(req, registry);
        if ("error" in r) {
          json(res, r.status, { error: r.error });
          return;
        }
        try {
          const { spec } = r.session;
          const content = await readFile(spec.filePath, "utf8");
          json(res, 200, {
            path: spec.filePath,
            name: basename(spec.filePath),
            content,
          });
        } catch (err) {
          json(res, 500, { error: String(err) });
        }
      });
    },
  };
}
