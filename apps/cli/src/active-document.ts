import chokidar, { type FSWatcher } from "chokidar";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { reanchorDocumentText, applyReanchorResults } from "@mrsf/cli";
import { DbSidecarStore, DiskSidecarStore, type SidecarStore } from "./sidecar/store.js";
import type { Db } from "./db/index.js";
import type { ActiveDocumentSpec, Session } from "./server.js";

export interface ActiveDocument {
  getActive(): { spec: ActiveDocumentSpec; sidecar: SidecarStore };
  setActive(spec: ActiveDocumentSpec): Promise<void>;
  ensureFreshAnchors(): Promise<void>;
  dispose(): Promise<void>;
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
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
  // Hash of the file content the sidecar was last anchored against. The
  // watcher updates this on `change`; the GET path uses it as a staleness
  // probe so a missed watcher event still produces a fresh response.
  let lastAnchoredHash: string | undefined;
  let inflight: Promise<void> | null = null;

  function makeStore(s: ActiveDocumentSpec): SidecarStore {
    if (deps.db && deps.session && s.documentId) {
      return new DbSidecarStore(deps.db, s.documentId, s.filePath);
    }
    return new DiskSidecarStore(s.filePath, `${s.filePath}.review.yaml`);
  }

  async function ensureFreshAnchors(): Promise<void> {
    if (inflight) return inflight;
    const currentSpec = spec;
    const currentSidecar = sidecar;
    inflight = (async () => {
      try {
        let content: string;
        try {
          content = await readFile(currentSpec.filePath, "utf8");
        } catch {
          return;
        }
        const hash = hashContent(content);
        if (hash === lastAnchoredHash) return;
        const doc = await currentSidecar.load();
        if (Array.isArray(doc.comments) && doc.comments.length > 0) {
          const results = await reanchorDocumentText(doc, content);
          applyReanchorResults(doc, results);
          await currentSidecar.save(doc);
        }
        lastAnchoredHash = hash;
      } catch (err) {
        console.error("mark-it: re-anchor failed:", err);
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  function armWatcher(filePath: string): FSWatcher {
    const w = chokidar.watch(filePath, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 25 },
    });
    w.on("change", async () => {
      await ensureFreshAnchors();
      deps.broadcastSse(deps.clients, "change");
    });
    return w;
  }

  return {
    getActive: () => ({ spec, sidecar }),
    ensureFreshAnchors,
    async setActive(next) {
      await watcher.close();
      spec = next;
      sidecar = makeStore(next);
      lastAnchoredHash = undefined;
      watcher = armWatcher(next.filePath);
      deps.broadcastSse(deps.clients, "change");
    },
    async dispose() {
      await watcher.close();
    },
  };
}
