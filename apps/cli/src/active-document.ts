import chokidar, { type FSWatcher } from "chokidar";
import { readFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { reanchorDocumentText, applyReanchorResults } from "@mrsf/cli";
import { DbSidecarStore, DiskSidecarStore, type SidecarStore } from "./sidecar/store.js";
import type { Db } from "./db/index.js";
import type { ActiveDocumentSpec, Session } from "./server.js";

export interface ActiveDocument {
  getActive(): { spec: ActiveDocumentSpec; sidecar: SidecarStore };
  setActive(spec: ActiveDocumentSpec): Promise<void>;
  dispose(): Promise<void>;
}

export function createActiveDocument(deps: {
  initial: ActiveDocumentSpec;
  db?: Db;
  session?: Session | null;
  clients: Set<ServerResponse>;
  broadcastSse: (clients: Set<ServerResponse>, event: string) => void;
}): ActiveDocument {
  let spec = deps.initial;
  let sidecar = makeStore(spec);
  let watcher = armWatcher(spec.filePath);

  function makeStore(s: ActiveDocumentSpec): SidecarStore {
    if (deps.db && deps.session && s.documentId) {
      return new DbSidecarStore(deps.db, s.documentId, s.filePath);
    }
    return new DiskSidecarStore(s.filePath, `${s.filePath}.review.yaml`);
  }

  function armWatcher(filePath: string): FSWatcher {
    const w = chokidar.watch(filePath, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 25 },
    });
    w.on("change", async () => {
      try {
        const doc = await sidecar.load();
        if (Array.isArray(doc.comments) && doc.comments.length > 0) {
          const content = await readFile(filePath, "utf8");
          const results = await reanchorDocumentText(doc, content);
          applyReanchorResults(doc, results);
          await sidecar.save(doc);
        }
      } catch (err) {
        console.error("mark-it: re-anchor failed:", err);
      }
      deps.broadcastSse(deps.clients, "change");
    });
    return w;
  }

  return {
    getActive: () => ({ spec, sidecar }),
    async setActive(next) {
      await watcher.close();
      spec = next;
      sidecar = makeStore(next);
      watcher = armWatcher(next.filePath);
      deps.broadcastSse(deps.clients, "change");
    },
    async dispose() {
      await watcher.close();
    },
  };
}
