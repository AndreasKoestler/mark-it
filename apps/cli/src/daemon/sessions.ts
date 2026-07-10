import chokidar, { type FSWatcher } from "chokidar";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { reanchorDocumentText, applyReanchorResults } from "@mrsf/cli";
import { DbSidecarStore, DiskSidecarStore, type SidecarStore } from "../sidecar/store.js";
import { docIdForSpec } from "./ids.js";
import { createEventBuffer, type EventBuffer, type EventEnvelope } from "../agent/buffer.js";
import type { Db } from "../db/index.js";
import type { ActiveDocumentSpec, Session } from "../server.js";
import type { ServerResponse } from "node:http";

export interface DocSession {
  docId: string;
  spec: ActiveDocumentSpec;
  session: Session | null;
  sidecar: SidecarStore;
  agentBuffer: EventBuffer;
  agentSseClients: Set<ServerResponse>;
  lifecycleClients: Set<ServerResponse>;
  ensureFreshAnchors(): Promise<void>;
  /**
   * Runs `fn` after any previously-queued write for this doc has settled, so
   * every sidecar load-mutate-save cycle is serialized instead of racing on
   * stale in-memory state. Every mutation path must go through this.
   */
  withWriteLock<T>(fn: () => Promise<T>): Promise<T>;
  pushAgentEvent(env: EventEnvelope): void;
  dispose(): Promise<void>;
}

export interface SessionRegistry {
  register(
    spec: ActiveDocumentSpec,
    ext?: { db?: Db; session?: Session | null },
  ): DocSession;
  get(docId: string): DocSession | undefined;
  unregister(docId: string): Promise<void>;
  size(): number;
  all(): DocSession[];
  /** docId of the "default" session for legacy single-tab mode. */
  activeDocId(): string | undefined;
  setActive(docId: string): void;
  getActive(): DocSession | undefined;
  broadcast(docId: string, event: string): void;
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Hard cap on concurrent registered docs (one chokidar watcher each). */
export const MAX_REGISTERED_DOCS = 64;

export function createSessionRegistry(deps: {
  broadcast: (docId: string, event: string) => void;
  maxDocs?: number;
}): SessionRegistry {
  const sessions = new Map<string, DocSession>();
  let active: string | undefined;
  const maxDocs = deps.maxDocs ?? MAX_REGISTERED_DOCS;

  function makeStore(
    s: ActiveDocumentSpec,
    ext?: { db?: Db; session?: Session | null },
  ): SidecarStore {
    if (ext?.db && ext.session && s.documentId) {
      return new DbSidecarStore(ext.db, s.documentId, s.filePath);
    }
    return new DiskSidecarStore(s.filePath, `${s.filePath}.review.yaml`);
  }

  function build(
    spec: ActiveDocumentSpec,
    ext?: { db?: Db; session?: Session | null },
  ): DocSession {
    const docId = docIdForSpec(spec);
    const session = ext?.session ?? null;
    const sidecar = makeStore(spec, ext);
    const agentBuffer = createEventBuffer({ capacity: 100 });
    const agentSseClients = new Set<ServerResponse>();
    const lifecycleClients = new Set<ServerResponse>();
    let lastAnchoredHash: string | undefined;
    let inflight: Promise<void> | null = null;
    let writeQueue: Promise<unknown> = Promise.resolve();

    function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
      const result = writeQueue.then(fn, fn);
      // Chain the queue on a version that always resolves, so one failed
      // write doesn't wedge every write queued after it — callers still see
      // the real outcome via `result`.
      writeQueue = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    }

    async function ensureFreshAnchors(): Promise<void> {
      if (inflight) return inflight;
      inflight = (async () => {
        try {
          let content: string;
          try {
            content = await readFile(spec.filePath, "utf8");
          } catch {
            return;
          }
          const h = hashContent(content);
          if (h === lastAnchoredHash) return;
          await withWriteLock(async () => {
            const doc = await sidecar.load();
            if (Array.isArray(doc.comments) && doc.comments.length > 0) {
              const results = await reanchorDocumentText(doc, content);
              applyReanchorResults(doc, results);
              await sidecar.save(doc);
            }
          });
          lastAnchoredHash = h;
        } catch (err) {
          console.error(`mark-it[${docId}]: re-anchor failed:`, err);
        } finally {
          inflight = null;
        }
      })();
      return inflight;
    }

    // Watch the parent directory rather than the file itself. macOS fsevents
    // (and most editors using atomic write = rename(tmp, target)) silently
    // breaks single-file watches: the inode chokidar held a reference to is
    // gone, and `change` events stop firing forever. Watching the parent
    // dir + filtering by path survives every editor's save strategy.
    const watcher: FSWatcher = chokidar.watch(dirname(spec.filePath), {
      persistent: true,
      ignoreInitial: true,
      depth: 0,
      awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 25 },
    });
    async function onFileChange(changedPath: string) {
      if (changedPath !== spec.filePath) return;
      await ensureFreshAnchors();
      deps.broadcast(docId, "change");
    }
    watcher.on("change", onFileChange);
    // `add` fires after rename(tmp, target) atomic writes — same effect as
    // `change` for our purposes (the file content updated).
    watcher.on("add", onFileChange);

    return {
      docId,
      spec,
      session,
      sidecar,
      agentBuffer,
      agentSseClients,
      lifecycleClients,
      ensureFreshAnchors,
      withWriteLock,
      pushAgentEvent(env) {
        agentBuffer.push(env);
      },
      async dispose() {
        await watcher.close();
        for (const c of agentSseClients) {
          try { c.end(); } catch { /* ignore */ }
        }
        agentSseClients.clear();
        for (const c of lifecycleClients) {
          try { c.end(); } catch { /* ignore */ }
        }
        lifecycleClients.clear();
      },
    };
  }

  return {
    register(spec, ext) {
      const docId = docIdForSpec(spec);
      const existing = sessions.get(docId);
      if (existing) {
        active = docId;
        return existing;
      }
      if (sessions.size >= maxDocs) {
        throw new Error(
          `mark-it: too many open documents (max ${maxDocs}) — close some tabs first`,
        );
      }
      const sess = build(spec, ext);
      sessions.set(docId, sess);
      active = docId;
      return sess;
    },
    get: (id) => sessions.get(id),
    async unregister(id) {
      const s = sessions.get(id);
      if (!s) return;
      await s.dispose();
      sessions.delete(id);
      if (active === id) {
        active = sessions.keys().next().value;
      }
    },
    size: () => sessions.size,
    all: () => [...sessions.values()],
    activeDocId: () => active,
    setActive(id) {
      if (!sessions.has(id)) throw new Error(`setActive: unknown doc ${id}`);
      active = id;
    },
    getActive: () => (active ? sessions.get(active) : undefined),
    broadcast: (docId, event) => deps.broadcast(docId, event),
  };
}
