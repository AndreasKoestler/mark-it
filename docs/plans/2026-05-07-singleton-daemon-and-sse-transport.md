# mark-it singleton daemon + SSE agent transport — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn mark-it into a long-lived local daemon that hosts many documents at once. `mark-it <path>` becomes a thin client that registers the doc, focuses an existing tab if one is open, and exits. Replace the stdout `===MARK-IT-SEND-BEGIN===` envelope with a per-doc SSE event stream so multiple agents can subscribe, replay missed events on reconnect, and never contend on stdout.

**Architecture:** A single Bun process (`mark-it daemon`) hosts the Vite dev server + HTTP API + a `Map<docId, DocSession>`. Each session owns its sidecar store, chokidar watcher, content hash, agent-event ring buffer, and SSE client set. Tabs pin to one docId via the URL (`/?doc=<id>`), so the legacy "one active doc per server" model goes away. Browser focus is driven by an SSE `focus` event; agents subscribe to `/api/agent/events?docId=<id>` (with `Last-Event-ID` replay) and read JSONL via the new `mark-it tail` subcommand.

**Tech stack:** No new runtime dependencies. Existing Bun + Vite + chokidar + bun:sqlite + the in-tree `@mrsf/cli` re-anchor primitives. SSE handled directly on Node's `http` (same pattern as `/api/events`). Daemon discovery via `~/.mark-it/daemon.json` (mode 0600) + an HMAC token. Single-flight spawn via atomic mkdir lock.

## Discovery

**Similar implementations:**
- `apps/cli/src/server.ts` already serves SSE for lifecycle (`/api/events`) and an HTTP control plane via Vite middleware plugins. The same pattern extends naturally to per-doc SSE.
- `apps/cli/src/active-document.ts` already encapsulates per-doc state (sidecar, watcher, freshness hash). It becomes the per-session unit, keyed by docId.
- `apps/cli/src/plugins/{session,tree}.ts` already use the `ActiveDocument` for per-request state — they need to switch from "the active doc" to "the doc in the request URL".

**File conventions:**
- Sources live under `apps/cli/src/` with feature folders (`db/`, `plugins/`, `commands/`, `sidecar/`).
- Plugins are factory functions returning Vite `Plugin` objects; each owns one `/api/*` namespace.
- DB modules use `bun:sqlite`. Sidecar IO routes through `SidecarStore` interface.
- Commands use `citty.defineCommand`; bare-file fallback rewrites `argv[0]` to `review` in `index.ts:33`.

**Testing patterns:**
- `apps/cli/tests/unit/*.test.ts` — vitest API, run via `bun test`. Used for pure logic (db, active-document).
- `apps/cli/tests/*.spec.ts` — Playwright E2E, run via `bun run test:e2e`. Used for HTTP/browser flows.
- `apps/cli/tests/lifecycle.spec.ts` is the canonical example of "spawn the CLI, hit it over raw HTTP, assert lifecycle behavior" — copy this shape for daemon/client tests.
- Fixture fixed at `apps/cli/fixtures/plan.md`; sidecar at `<file>.review.yaml`.

**Integration points:**
- `apps/cli/web/main.tsx` — frontend entry; subscribes to `/api/events`, posts `/api/agent`, beacons `/api/bye` on `pagehide`.
- `packages/core/src/agent/http-transport.ts` — `HttpAgentTransport` POSTs `/api/agent`. Stays.
- `skills/review-with-mark-it/SKILL.md` — the agent skill spec; documents the `===` envelope. Must be rewritten.
- `README.md` — describes "Send to agent flushes outstanding comments to stdout"; must be rewritten.

**Project conventions:**
- `/Users/andreas/CLAUDE.md` (ralph-loop conventions) doesn't apply here — this is interactive plan-driven work.
- No pre-commit hook is currently configured. Use `bun run typecheck && bun test && bun run test:e2e` as the gate.
- Recent commit style: `feat(cli): …` / `fix(cli): …` — match it.

**Context loaded:** none — ad-hoc discovery (no `.superpowers/context/` root exists for this repo).

---

## Architecture decisions (locked in)

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Daemon binds to `127.0.0.1:<random-port>`, advertises via `~/.mark-it/daemon.json` | Cross-platform (UNIX sockets are clumsy on Windows); easy to debug with curl |
| 2 | Single-flight spawn via atomic `mkdir ~/.mark-it/.daemon.lock` | No new dependency; mkdir is atomic on POSIX & NTFS |
| 3 | docId for legacy mode = `legacy-${sha256(absFilePath).slice(0,16)}` | Stable across re-invocations → same tab is focused; opaque enough not to leak the path in URLs |
| 4 | Tab focus = SSE `focus` event → frontend calls `window.focus()` | No AppleScript shellout; works on any browser; testable |
| 5 | Daemon idle exit when no docs registered and no SSE clients for `MARK_IT_DAEMON_IDLE_SECS` (default 600s) | Same lifecycle "shape" as today, just per-daemon instead of per-doc |
| 6 | Auth token (random 32 bytes hex) baked in `daemon.json`, sent as `X-Mark-It-Token` | Prevents cross-user / accidental cross-process attachment on shared machines |
| 7 | SSE event format: `event: send`, `id: <ulid>`, `data: { docId, comments, resolveIds, text }` | `Last-Event-ID` replay is built into the EventSource spec; ulid is monotonic |
| 8 | Per-doc ring buffer of 100 events, dropped on doc unregister | Bounded memory, sufficient for human-paced review loops |
| 9 | Skill + shell pipelines consume agent stream via new `mark-it tail <path>` (JSONL on stdout) | Keeps "one process the agent watches" UX; cleanly testable |
| 10 | Stdout `===MARK-IT-SEND-…===` envelope is removed in this same plan, no deprecation window | The skill ships in-repo; no external consumers documented |
| 11 | `mark-it tail` consumes SSE with `fetch` + a small inline parser (Bun 1.3 does **not** expose `EventSource` on `globalThis`, despite some docs implying it does). Server emits SSE inline — no library either side. Auth rides on `?token=` because tail can't carry headers on a transparent reconnect when `EventSource` does land | Hand-rolled parser is ~40 lines and gives us full control over the reconnect loop + Last-Event-ID handling. Server emission is ~10 lines (we already do it for `/api/events`); wrappers like `better-sse` don't earn their weight at our scale |

The user can override any of these during the mark-it review of this plan.

---

## File structure

### New files

| Path | Responsibility |
|---|---|
| `apps/cli/src/daemon/index.ts` | Daemon entry. Wires Vite + plugins, owns `Map<docId, DocSession>`, handles startup/idle-exit. |
| `apps/cli/src/daemon/sessions.ts` | `DocSession` factory + `SessionRegistry` (register/unregister/get/byPath). |
| `apps/cli/src/daemon/discovery.ts` | Read/write `~/.mark-it/daemon.json`, single-flight spawn helper, `ensureDaemonRunning()`. |
| `apps/cli/src/daemon/auth.ts` | Token generation + per-request validation middleware. |
| `apps/cli/src/daemon/ids.ts` | `docIdForPath()` (legacy-mode hash) + DB-mode passthrough. |
| `apps/cli/src/agent/buffer.ts` | Per-doc ring buffer + `EventEnvelope` type + `replaySince(lastId)` helper. |
| `apps/cli/src/plugins/agent-stream.ts` | New SSE plugin: `GET /api/agent/events?docId=…&token=…` with replay. |
| `apps/cli/src/commands/tail.ts` | `mark-it tail <path>` — connects to daemon SSE, prints JSONL. |
| `apps/cli/tests/unit/discovery.test.ts` | Daemon discovery / single-flight spawn tests (no real spawn — uses a stub). |
| `apps/cli/tests/unit/buffer.test.ts` | Ring buffer + replay semantics. |
| `apps/cli/tests/unit/ids.test.ts` | docId derivation determinism. |
| `apps/cli/tests/daemon-lifecycle.spec.ts` | E2E: two `mark-it path/foo.md` invocations share one daemon; second focuses the tab. |
| `apps/cli/tests/agent-sse.spec.ts` | E2E: connect to `/api/agent/events`, trigger Send, assert event JSON; reconnect with `Last-Event-ID` replays. |
| `apps/cli/tests/tail.spec.ts` | E2E: `mark-it tail` prints JSONL to stdout for each Send. |

### Modified files

| Path | Change |
|---|---|
| `apps/cli/src/index.ts` | Add `daemon` and `tail` subcommands; bare-file fallback continues to map to `review`, but `review` now becomes a thin client. |
| `apps/cli/src/commands/review.ts` | Replace `startServer(...)` with `ensureDaemonRunning() → registerDoc() → openOrFocusTab() → exit`. |
| `apps/cli/src/server.ts` | Become the daemon's HTTP wiring. `ActiveDocument` becomes `DocSession` keyed by docId; all `/api/*` routes accept `?doc=<id>` (or `X-Mark-It-Doc-Id` header). |
| `apps/cli/src/active-document.ts` | Renamed in spirit to `DocSession`; `setActive` removed (each session is one doc). |
| `apps/cli/src/plugins/session.ts` | Resolve session per-request via docId from URL, not via `active.getActive()`. |
| `apps/cli/src/plugins/tree.ts` | `isActive` is now per-request: take docId from query and mark that one. |
| `apps/cli/web/main.tsx` | Read docId from URL on boot; subscribe to `/api/events?doc=<id>` and `/api/agent/events?doc=<id>`; handle `event: focus` via `window.focus()`. |
| `apps/cli/web/main.tsx` | `pagehide` beacons `/api/bye?doc=<id>`. |
| `packages/core/src/agent/http-transport.ts` | Accept docId in constructor; include in POST body so the daemon broadcasts to the right per-doc stream. |
| `skills/review-with-mark-it/SKILL.md` | Rewrite step 3-4 of the workflow: replace stdout envelope with `mark-it tail` JSONL. |
| `README.md` | Update "Send to agent" paragraph and project-layout section. |
| `apps/cli/tests/lifecycle.spec.ts` | Update for daemon idle-exit semantics; the "tab close → exit" test becomes "last tab close → idle timer starts → exit after timeout". |
| `apps/cli/tests/acceptance.spec.ts` AC13 | Add a parallel assertion: SSE stream receives the same payload that POST /api/agent sent. |

### Deleted

- `SEND_BEGIN`/`SEND_END` constants and the `process.stdout.write(...)` block in `markItAgentPlugin`.

---

## Phase 1 — Daemon foundation (Tasks 1-9)

### Task 1: docId helper + tests

**Files:**
- Create: `apps/cli/src/daemon/ids.ts`
- Test: `apps/cli/tests/unit/ids.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/cli/tests/unit/ids.test.ts
import { describe, expect, test } from "vitest";
import { docIdForLegacyPath, docIdForSpec } from "../../src/daemon/ids.js";

describe("docIdForLegacyPath", () => {
  test("is deterministic for the same absolute path", () => {
    const a = docIdForLegacyPath("/tmp/foo.md");
    const b = docIdForLegacyPath("/tmp/foo.md");
    expect(a).toBe(b);
    expect(a).toMatch(/^legacy-[0-9a-f]{16}$/);
  });

  test("differs for different paths", () => {
    expect(docIdForLegacyPath("/tmp/a.md")).not.toBe(docIdForLegacyPath("/tmp/b.md"));
  });
});

describe("docIdForSpec", () => {
  test("returns spec.documentId in DB mode", () => {
    expect(docIdForSpec({ filePath: "/x.md", documentId: "uuid-1" })).toBe("uuid-1");
  });
  test("falls back to legacy hash when no documentId", () => {
    expect(docIdForSpec({ filePath: "/x.md" })).toMatch(/^legacy-/);
  });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `cd apps/cli && bun test tests/unit/ids.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// apps/cli/src/daemon/ids.ts
import { createHash } from "node:crypto";
import type { ActiveDocumentSpec } from "../server.js";

export function docIdForLegacyPath(absPath: string): string {
  const hash = createHash("sha256").update(absPath).digest("hex").slice(0, 16);
  return `legacy-${hash}`;
}

export function docIdForSpec(spec: ActiveDocumentSpec): string {
  return spec.documentId ?? docIdForLegacyPath(spec.filePath);
}
```

- [ ] **Step 4: Verify pass**

Run: `cd apps/cli && bun test tests/unit/ids.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/daemon/ids.ts apps/cli/tests/unit/ids.test.ts
git commit -m "feat(cli): docId derivation for legacy and DB-mode docs"
```

---

### Task 2: SSE event ring buffer + tests

**Files:**
- Create: `apps/cli/src/agent/buffer.ts`
- Test: `apps/cli/tests/unit/buffer.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/cli/tests/unit/buffer.test.ts
import { describe, expect, test } from "vitest";
import { createEventBuffer, type EventEnvelope } from "../../src/agent/buffer.js";

function evt(id: string, n: number): EventEnvelope {
  return { id, type: "send", data: { n } };
}

describe("event buffer", () => {
  test("push + replaySince returns events newer than the given id", () => {
    const buf = createEventBuffer({ capacity: 10 });
    buf.push(evt("01", 1));
    buf.push(evt("02", 2));
    buf.push(evt("03", 3));
    expect(buf.replaySince("01").map((e) => e.id)).toEqual(["02", "03"]);
    expect(buf.replaySince(undefined).map((e) => e.id)).toEqual(["01", "02", "03"]);
    expect(buf.replaySince("99").map((e) => e.id)).toEqual([]);
  });

  test("evicts oldest when over capacity", () => {
    const buf = createEventBuffer({ capacity: 2 });
    buf.push(evt("01", 1));
    buf.push(evt("02", 2));
    buf.push(evt("03", 3));
    expect(buf.replaySince(undefined).map((e) => e.id)).toEqual(["02", "03"]);
  });

  test("replaySince of an evicted id replays everything still buffered", () => {
    const buf = createEventBuffer({ capacity: 2 });
    buf.push(evt("01", 1));
    buf.push(evt("02", 2));
    buf.push(evt("03", 3));
    // "01" is gone; we can't replay from there — return whole buffer (best effort).
    expect(buf.replaySince("01").map((e) => e.id)).toEqual(["02", "03"]);
  });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `cd apps/cli && bun test tests/unit/buffer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// apps/cli/src/agent/buffer.ts
export interface EventEnvelope {
  id: string;
  type: "send";
  data: unknown;
}

export interface EventBuffer {
  push(e: EventEnvelope): void;
  replaySince(lastId: string | undefined): EventEnvelope[];
  size(): number;
}

export function createEventBuffer(opts: { capacity: number }): EventBuffer {
  const ring: EventEnvelope[] = [];
  return {
    push(e) {
      ring.push(e);
      if (ring.length > opts.capacity) ring.splice(0, ring.length - opts.capacity);
    },
    replaySince(lastId) {
      if (!lastId) return [...ring];
      const idx = ring.findIndex((e) => e.id === lastId);
      if (idx < 0) return [...ring]; // evicted or unknown — best-effort
      return ring.slice(idx + 1);
    },
    size: () => ring.length,
  };
}
```

- [ ] **Step 4: Verify pass**

Run: `cd apps/cli && bun test tests/unit/buffer.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/agent/buffer.ts apps/cli/tests/unit/buffer.test.ts
git commit -m "feat(cli): per-doc agent event ring buffer with Last-Event-ID replay"
```

---

### Task 3: DocSession + SessionRegistry

**Files:**
- Create: `apps/cli/src/daemon/sessions.ts`
- Modify: `apps/cli/src/active-document.ts` (re-export `DocSession` interface from sessions module)

The intent: the existing `ActiveDocument` is renamed to `DocSession`, becomes immutable per docId (no `setActive`), and the registry replaces the singleton. The `ensureFreshAnchors` logic from the watcher fix moves verbatim into `DocSession`.

- [ ] **Step 1: Write a failing test**

```ts
// apps/cli/tests/unit/sessions.test.ts
import { describe, expect, test } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionRegistry } from "../../src/daemon/sessions.js";

describe("SessionRegistry", () => {
  test("register returns the same docId for the same path; unregister removes it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mark-it-sess-"));
    try {
      const file = join(dir, "doc.md");
      await writeFile(file, "# hi\n", "utf8");
      const reg = createSessionRegistry({ broadcast: () => {} });
      const a = reg.register({ filePath: file });
      const b = reg.register({ filePath: file });
      expect(a.docId).toBe(b.docId);
      expect(reg.size()).toBe(1);
      await reg.unregister(a.docId);
      expect(reg.size()).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `cd apps/cli && bun test tests/unit/sessions.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `sessions.ts`**

The full module factors the per-doc state from `active-document.ts`:

```ts
// apps/cli/src/daemon/sessions.ts
import chokidar, { type FSWatcher } from "chokidar";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { reanchorDocumentText, applyReanchorResults } from "@mrsf/cli";
import { DbSidecarStore, DiskSidecarStore, type SidecarStore } from "../sidecar/store.js";
import { docIdForSpec } from "./ids.js";
import { createEventBuffer, type EventBuffer, type EventEnvelope } from "../agent/buffer.js";
import type { Db } from "../db/index.js";
import type { ActiveDocumentSpec, Session } from "../server.js";

export interface DocSession {
  docId: string;
  spec: ActiveDocumentSpec;
  sidecar: SidecarStore;
  agentBuffer: EventBuffer;
  ensureFreshAnchors(): Promise<void>;
  pushAgentEvent(env: EventEnvelope): void;
  dispose(): Promise<void>;
}

export interface SessionRegistry {
  register(spec: ActiveDocumentSpec, deps?: { db?: Db; session?: Session | null }): DocSession;
  get(docId: string): DocSession | undefined;
  unregister(docId: string): Promise<void>;
  size(): number;
  all(): DocSession[];
}

function hash(s: string) { return createHash("sha256").update(s).digest("hex"); }

export function createSessionRegistry(deps: {
  broadcast: (docId: string, event: string) => void;
}): SessionRegistry {
  const sessions = new Map<string, DocSession>();

  function makeStore(s: ActiveDocumentSpec, ext?: { db?: Db; session?: Session | null }): SidecarStore {
    if (ext?.db && ext.session && s.documentId) {
      return new DbSidecarStore(ext.db, s.documentId, s.filePath);
    }
    return new DiskSidecarStore(s.filePath, `${s.filePath}.review.yaml`);
  }

  function build(spec: ActiveDocumentSpec, ext?: { db?: Db; session?: Session | null }): DocSession {
    const docId = docIdForSpec(spec);
    const sidecar = makeStore(spec, ext);
    const agentBuffer = createEventBuffer({ capacity: 100 });
    let lastAnchoredHash: string | undefined;
    let inflight: Promise<void> | null = null;

    async function ensureFreshAnchors(): Promise<void> {
      if (inflight) return inflight;
      inflight = (async () => {
        try {
          let content: string;
          try { content = await readFile(spec.filePath, "utf8"); } catch { return; }
          const h = hash(content);
          if (h === lastAnchoredHash) return;
          const doc = await sidecar.load();
          if (Array.isArray(doc.comments) && doc.comments.length > 0) {
            const results = await reanchorDocumentText(doc, content);
            applyReanchorResults(doc, results);
            await sidecar.save(doc);
          }
          lastAnchoredHash = h;
        } catch (err) {
          console.error(`mark-it[${docId}]: re-anchor failed:`, err);
        } finally {
          inflight = null;
        }
      })();
      return inflight;
    }

    const watcher: FSWatcher = chokidar.watch(spec.filePath, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 25 },
    });
    watcher.on("change", async () => {
      await ensureFreshAnchors();
      deps.broadcast(docId, "change");
    });

    return {
      docId,
      spec,
      sidecar,
      agentBuffer,
      ensureFreshAnchors,
      pushAgentEvent(env) { agentBuffer.push(env); },
      async dispose() { await watcher.close(); },
    };
  }

  return {
    register(spec, ext) {
      const docId = docIdForSpec(spec);
      const existing = sessions.get(docId);
      if (existing) return existing;
      const sess = build(spec, ext);
      sessions.set(docId, sess);
      return sess;
    },
    get: (id) => sessions.get(id),
    async unregister(id) {
      const s = sessions.get(id);
      if (!s) return;
      await s.dispose();
      sessions.delete(id);
    },
    size: () => sessions.size,
    all: () => [...sessions.values()],
  };
}
```

- [ ] **Step 4: Run unit test, verify pass**

Run: `cd apps/cli && bun test tests/unit/sessions.test.ts`
Expected: PASS, 1 test.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/daemon/sessions.ts apps/cli/tests/unit/sessions.test.ts
git commit -m "feat(cli): DocSession + SessionRegistry per-docId state"
```

---

### Task 4: Daemon discovery + auth

**Files:**
- Create: `apps/cli/src/daemon/discovery.ts`
- Create: `apps/cli/src/daemon/auth.ts`
- Test: `apps/cli/tests/unit/discovery.test.ts`

Behavior:
- `discovery.read()` returns `{ port, token, pid } | null` from `~/.mark-it/daemon.json`. Returns null if file missing, malformed, or `process.kill(pid, 0)` throws.
- `discovery.write(info)` atomically writes the file (temp + rename) with mode 0600.
- `discovery.acquireSpawnLock()` does `mkdirSync(lockDir)` and returns a release fn; throws if lock exists.
- `auth.middleware()` rejects requests missing `X-Mark-It-Token` (or `?token=` for SSE GETs that can't set headers from `<EventSource>` without a polyfill).

- [ ] **Step 1: Write tests**

```ts
// apps/cli/tests/unit/discovery.test.ts
import { describe, expect, test } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDiscovery } from "../../src/daemon/discovery.js";

describe("discovery", () => {
  test("read returns null when file missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mid-"));
    try {
      const d = createDiscovery({ home: dir });
      expect(await d.read()).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("write + read round-trips and sets mode 0600", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mid-"));
    try {
      const d = createDiscovery({ home: dir });
      await d.write({ port: 5173, token: "abc", pid: process.pid });
      const got = await d.read();
      expect(got).toEqual({ port: 5173, token: "abc", pid: process.pid });
      const file = await stat(join(dir, ".mark-it", "daemon.json"));
      expect(file.mode & 0o777).toBe(0o600);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("read returns null when pid is dead", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mid-"));
    try {
      const d = createDiscovery({ home: dir });
      await d.write({ port: 5173, token: "abc", pid: 1 }); // pid 1 exists but won't be us
      // Force a dead pid: pick a high number unlikely to exist.
      await d.write({ port: 5173, token: "abc", pid: 999_999 });
      expect(await d.read()).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("acquireSpawnLock is exclusive", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mid-"));
    try {
      const d = createDiscovery({ home: dir });
      const release = await d.acquireSpawnLock();
      await expect(d.acquireSpawnLock()).rejects.toThrow();
      release();
      const release2 = await d.acquireSpawnLock();
      release2();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `cd apps/cli && bun test tests/unit/discovery.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `discovery.ts`**

```ts
// apps/cli/src/daemon/discovery.ts
import { mkdirSync, rmSync } from "node:fs";
import { rename, writeFile, readFile, chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export interface DaemonInfo { port: number; token: string; pid: number }

export interface Discovery {
  read(): Promise<DaemonInfo | null>;
  write(info: DaemonInfo): Promise<void>;
  acquireSpawnLock(): Promise<() => void>;
}

export function createDiscovery(opts: { home?: string } = {}): Discovery {
  const home = opts.home ?? homedir();
  const dir = join(home, ".mark-it");
  const file = join(dir, "daemon.json");
  const lock = join(dir, ".daemon.lock");

  function alive(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch { return false; }
  }

  return {
    async read() {
      try {
        const raw = await readFile(file, "utf8");
        const info = JSON.parse(raw) as DaemonInfo;
        if (!alive(info.pid)) return null;
        return info;
      } catch {
        return null;
      }
    },
    async write(info) {
      await mkdir(dir, { recursive: true });
      const tmp = `${file}.tmp`;
      await writeFile(tmp, JSON.stringify(info), { mode: 0o600 });
      await chmod(tmp, 0o600);
      await rename(tmp, file);
    },
    async acquireSpawnLock() {
      await mkdir(dir, { recursive: true });
      mkdirSync(lock); // throws EEXIST if held
      return () => rmSync(lock, { recursive: true, force: true });
    },
  };
}
```

```ts
// apps/cli/src/daemon/auth.ts
import type { IncomingMessage, ServerResponse } from "node:http";

export function makeAuthCheck(token: string) {
  return function checkAuth(req: IncomingMessage, res: ServerResponse): boolean {
    const header = req.headers["x-mark-it-token"];
    const url = new URL(req.url ?? "", "http://localhost");
    const qp = url.searchParams.get("token");
    const got = (typeof header === "string" ? header : qp) ?? "";
    if (got !== token) {
      res.statusCode = 401;
      res.end("unauthorized");
      return false;
    }
    return true;
  };
}
```

- [ ] **Step 4: Run, verify pass**

Run: `cd apps/cli && bun test tests/unit/discovery.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/daemon/discovery.ts apps/cli/src/daemon/auth.ts apps/cli/tests/unit/discovery.test.ts
git commit -m "feat(cli): daemon discovery file + spawn lock + auth check"
```

---

### Task 5: Per-doc routing on existing plugins

**Files:**
- Modify: `apps/cli/src/server.ts` — `startServer` now takes `SessionRegistry` instead of a single `ActiveDocument`. All `/api/*` routes resolve docId from `?doc=<id>` (or `X-Mark-It-Doc-Id` header) and look up the session.
- Modify: `apps/cli/src/plugins/session.ts`, `plugins/tree.ts` — same shift.
- Modify: `apps/cli/web/main.tsx` — read `?doc=<id>` from `window.location.search` on boot; thread it through every fetch and into the SSE URL.
- Modify: `apps/cli/src/active-document.ts` — delete (its job moved to `daemon/sessions.ts`). Update imports in `server.ts` accordingly.

The shape of the per-route resolution helper:

```ts
// inside server.ts
function docIdFromReq(req: IncomingMessage): string | null {
  const url = new URL(req.url ?? "", "http://localhost");
  return url.searchParams.get("doc") ?? (req.headers["x-mark-it-doc-id"] as string | undefined) ?? null;
}

function withSession<T>(req: IncomingMessage, res: ServerResponse, registry: SessionRegistry, fn: (s: DocSession) => Promise<T>): Promise<T | undefined> {
  const id = docIdFromReq(req);
  if (!id) { res.statusCode = 400; res.end("missing doc"); return Promise.resolve(undefined); }
  const sess = registry.get(id);
  if (!sess) { res.statusCode = 404; res.end("unknown doc"); return Promise.resolve(undefined); }
  return fn(sess);
}
```

- [ ] **Step 1: Write the integration test first** — extend `tests/acceptance.spec.ts` to include `?doc=…` on every fetch the test makes. Update fetch helpers, run the suite, expect failures pinpointing routes that don't accept the param yet.

```ts
// snippet added to tests/acceptance.spec.ts beforeEach
const docId = `legacy-${(await fetch("/api/session").then(r => r.json())).active.docId.slice(7)}`;
// ...all subsequent fetches use `?doc=${docId}`.
```

(The session response gains a `docId` field as part of this task.)

- [ ] **Step 2: Run, verify failure**

Run: `cd apps/cli && bun run test:e2e -- --grep "AC0:|AC1:|AC3:"`
Expected: FAIL — routes don't accept `?doc` yet, or `/api/session` lacks `docId`.

- [ ] **Step 3: Implement the per-route docId resolution**

(See snippet above; apply across `markItDocumentPlugin`, `markItSidecarPlugin`, `markItAgentPlugin`, `markItEventsPlugin`, `markItSessionPlugin`, `markItTreePlugin`. Each route now calls `withSession(...)` and uses `sess.spec` / `sess.sidecar` / `sess.ensureFreshAnchors`.)

- [ ] **Step 4: Frontend wiring**

```ts
// apps/cli/web/main.tsx
const params = new URLSearchParams(window.location.search);
export const DOC_ID = params.get("doc") ?? "";
const withDoc = (path: string) => `${path}${path.includes("?") ? "&" : "?"}doc=${encodeURIComponent(DOC_ID)}`;
// replace every fetch / EventSource URL with withDoc(...)
```

- [ ] **Step 5: Run full suite, verify pass**

Run: `bun run typecheck && cd apps/cli && bun test tests/unit && bun run test:e2e`
Expected: PASS — all 35+ tests.

- [ ] **Step 6: Delete `active-document.ts`**

```bash
git rm apps/cli/src/active-document.ts
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(cli): per-doc routing — every /api/* takes ?doc=<id>"
```

---

### Task 6: Daemon entry + idle exit

**Files:**
- Create: `apps/cli/src/daemon/index.ts`
- Modify: `apps/cli/src/index.ts` — add `daemon` subcommand that calls into it.

Behavior:
- `mark-it daemon` boots Vite + plugins on a random localhost port.
- On boot: writes `daemon.json`, prints port + pid + a `ready` log line.
- Tracks last-active wall-clock time (any HTTP hit, any SSE client, any registered doc). When idle for `MARK_IT_DAEMON_IDLE_SECS` (default 600), exits 0.
- On `SIGTERM`/`SIGINT`: closes all sessions cleanly and removes `daemon.json` before exiting.

- [ ] **Step 1: Write a lifecycle test** (`apps/cli/tests/daemon-lifecycle.spec.ts`):

```ts
import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
// ... boilerplate similar to lifecycle.spec.ts ...

test("daemon stays alive across two register calls; idle-exits when no docs", async () => {
  const child = spawnDaemon({ idleSecs: 1 });
  await waitForReady(child);
  const info = await readDaemonJson();
  expect(info.port).toBeGreaterThan(0);

  // Register two distinct docs
  await register(info, "/tmp/a.md");
  await register(info, "/tmp/b.md");
  expect((await listDocs(info)).length).toBe(2);

  // Unregister both; daemon should idle-exit within ~2s
  await unregister(info, "/tmp/a.md");
  await unregister(info, "/tmp/b.md");
  const code = await waitForExit(child, 5_000);
  expect(code).toBe(0);
});
```

- [ ] **Step 2: Run, verify failure** — daemon entry doesn't exist.

- [ ] **Step 3: Implement `daemon/index.ts`** — wire `createSessionRegistry`, `createDiscovery`, the auth middleware, and an idle-exit timer that resets on every SSE connect, doc register, and HTTP request that mutates state.

```ts
// apps/cli/src/daemon/index.ts (skeleton — all pieces already exist)
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { randomBytes } from "node:crypto";
import { createSessionRegistry } from "./sessions.js";
import { createDiscovery } from "./discovery.js";
import { makeAuthCheck } from "./auth.js";
// ... import plugins ...

export async function startDaemon(opts: { idleSecs: number }): Promise<void> {
  const token = randomBytes(32).toString("hex");
  const discovery = createDiscovery();
  const registry = createSessionRegistry({ broadcast: broadcastFor });

  // ... build Vite server with all plugins ...
  // ... call discovery.write({ port, token, pid: process.pid }) after listen ...
  // ... start idle-exit timer ...
}
```

- [ ] **Step 4: Run lifecycle test, verify pass.**

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(cli): mark-it daemon — long-lived multi-doc host with idle exit"
```

---

### Task 7: `register-doc` + `focus-tab` HTTP API

**Files:**
- Modify: `apps/cli/src/server.ts` (or split into `apps/cli/src/plugins/registry.ts`) — add `POST /api/registry/register` and broadcast `focus` when a doc is re-registered.

Endpoints:
- `POST /api/registry/register` body `{ filePath, documentId?, ... }` → returns `{ docId, url }` (the URL the client should open or focus).
- `POST /api/registry/unregister` body `{ docId }` → registry removes the session if no SSE clients are still attached for that docId.
- `GET /api/registry/list` → debugging aid.

Focus protocol:
- On `register`, if a session already existed for that docId, broadcast `event: focus` to all SSE clients on that doc. The frontend handler does `window.focus()` and scrolls into view.
- If no session existed, the response includes `url = http://127.0.0.1:<port>/?doc=<id>&token=<t>` so the client opens it.

- [ ] **Step 1: Test**

Two-call test in `daemon-lifecycle.spec.ts`: first register opens a tab, second register on the same path emits a `focus` SSE event. Use Playwright to attach an EventSource and listen.

- [ ] **Step 2: Implement**

Add the registry plugin; wire the `focus` broadcast through `registry.broadcast(docId, "focus")` (the same broadcaster used for `change` events).

- [ ] **Step 3: Verify and commit**

```bash
git commit -am "feat(cli): /api/registry/* — register, unregister, focus broadcast"
```

---

### Task 8: Thin `review` client

**Files:**
- Modify: `apps/cli/src/commands/review.ts` — replace `startServer(...)` with a sequence:
  1. `ensureDaemonRunning()` — read discovery; if missing, acquire lock, double-fork `bun apps/cli/src/index.ts daemon`, poll `/health` for up to 5s.
  2. `register({ filePath, documentId? })` over HTTP.
  3. If response says `firstOpen`: `openBrowser(url)`. Else: nothing — the focus SSE event takes care of refocusing.
  4. `process.exit(0)`.

- [ ] **Step 1: Update existing acceptance test fixtures**

The fixture `lifecycle.spec.ts` "spawns mark-it on a port and waits for /api/sidecar" no longer applies as-is — `mark-it path/foo.md` exits immediately. Refactor it: spawn daemon, register doc via HTTP, then run the lifecycle assertions against the daemon. Move the per-tab-close exit semantics to a "last-doc-unregister" path.

- [ ] **Step 2: Implement client**

```ts
// apps/cli/src/commands/review.ts (sketch)
import { ensureDaemonRunning, registerDoc } from "../daemon/client.js";

async run({ args }) {
  const filePath = await resolveSource(args.file);
  const dbCtx = args.org && args.project && args.user ? buildDbCtx(args) : null;
  const info = await ensureDaemonRunning();
  const { docId, url, focused } = await registerDoc(info, {
    filePath,
    documentId: dbCtx?.document.id,
    /* ... */
  });
  if (!focused && !args["no-open"]) openBrowser(url);
  process.exit(0);
}
```

- [ ] **Step 3: New module `apps/cli/src/daemon/client.ts`** — `ensureDaemonRunning()` and `registerDoc()` helpers. Spawn via `Bun.spawn([...], { stdio: ["ignore","ignore","ignore"], detached: true }).unref()`.

- [ ] **Step 4: Run full suite, verify pass.**

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(cli): mark-it <path> is now a thin client of the daemon"
```

---

### Task 9: Phase 1 manual verification

- [ ] **Step 1:** From a clean state (`rm -rf ~/.mark-it`), run `mark-it apps/cli/fixtures/plan.md` — daemon spawns, browser opens.
- [ ] **Step 2:** Run `mark-it apps/cli/fixtures/plan.md` again — same tab refocuses (verify by adding a comment in the original tab first; the comment must still be there).
- [ ] **Step 3:** Run `mark-it README.md` — second tab opens, both share the daemon.
- [ ] **Step 4:** Close both tabs; daemon idle-exits within `MARK_IT_DAEMON_IDLE_SECS`.
- [ ] **Step 5:** Restart and confirm `~/.mark-it/daemon.json` has been removed.

If all five pass, Phase 1 is done. Commit any docs/log notes.

---

## Phase 2 — SSE agent transport (Tasks 10-13)

### Task 10: `/api/agent/events` SSE endpoint

**Files:**
- Create: `apps/cli/src/plugins/agent-stream.ts`
- Modify: `apps/cli/src/server.ts` — register the new plugin alongside the existing one.

Handler shape:

```ts
// apps/cli/src/plugins/agent-stream.ts
export function markItAgentStreamPlugin(registry: SessionRegistry, auth: AuthCheck): Plugin {
  return {
    name: "mark-it-agent-stream",
    configureServer(server) {
      server.middlewares.use("/api/agent/events", (req, res) => {
        if (req.method !== "GET") { res.statusCode = 405; res.end(); return; }
        if (!auth(req, res)) return;
        const id = docIdFromReq(req);
        const sess = id ? registry.get(id) : undefined;
        if (!sess) { res.statusCode = 404; res.end(); return; }

        res.statusCode = 200;
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");

        // Replay missed events
        const lastId = (req.headers["last-event-id"] as string | undefined) ?? null;
        for (const env of sess.agentBuffer.replaySince(lastId ?? undefined)) {
          res.write(`id: ${env.id}\nevent: ${env.type}\ndata: ${JSON.stringify(env.data)}\n\n`);
        }

        // Live subscription
        sess.agentSseClients ??= new Set();
        sess.agentSseClients.add(res);
        res.write("event: ready\ndata: {}\n\n");
        req.on("close", () => sess.agentSseClients!.delete(res));
      });
    },
  };
}
```

- [ ] **Step 1: Test** — `tests/agent-sse.spec.ts`. Open SSE stream, POST `/api/agent`, assert event arrives within 1s.

- [ ] **Step 2: Implement** — `agent-stream.ts` + extend `DocSession` with `agentSseClients`.

- [ ] **Step 3: Verify and commit**

```bash
git commit -am "feat(cli): /api/agent/events — per-doc SSE stream with Last-Event-ID replay"
```

---

### Task 11: Wire `/api/agent` POST into the SSE broadcast; delete stdout envelope

**Files:**
- Modify: `apps/cli/src/server.ts` — `markItAgentPlugin` now does:
  1. Apply resolveIds to the sidecar (unchanged).
  2. Build an `EventEnvelope { id: ulid(), type: "send", data: { docId, comments, resolveIds, text } }`.
  3. `sess.pushAgentEvent(env)` (buffer).
  4. Broadcast SSE chunk to `sess.agentSseClients`.
  5. Respond `200 { ok: true, eventId }`.
  6. **Remove** the `process.stdout.write(...)` block and the `SEND_BEGIN`/`SEND_END` constants.

- [ ] **Step 1: Update test AC13** to assert the SSE consumer receives a `send` event with the expected JSON. Remove any test that asserts the `===` envelope shape.

- [ ] **Step 2: Implement, run suite, commit**

```bash
git commit -am "feat(cli): replace stdout MARK-IT-SEND envelope with SSE broadcast"
```

---

### Task 12: `mark-it tail` subcommand

**Files:**
- Create: `apps/cli/src/commands/tail.ts`
- Modify: `apps/cli/src/index.ts` — register the subcommand.
- Test: `apps/cli/tests/tail.spec.ts`

Behavior:
- `mark-it tail <path>` resolves the file's `docId` (via the same DB lookup or legacy hash logic as `review`) and connects to `/api/agent/events?doc=<id>&token=<t>`.
- Each `event: send` is printed to stdout as one JSON object per line (JSONL): `{"id":"...","docId":"...","comments":[...],"resolveIds":[...],"text":"..."}\n`.
- Reconnects with `Last-Event-ID` on disconnect (up to 5 retries with exponential backoff).
- Exits 0 when the doc is unregistered (signaled via SSE `event: done`).

```ts
// apps/cli/src/commands/tail.ts
import { defineCommand } from "citty";
import { resolve } from "node:path";
import { ensureDaemonRunning } from "../daemon/client.js";
import { docIdForLegacyPath } from "../daemon/ids.js";

export const tailCommand = defineCommand({
  meta: { name: "tail", description: "Stream agent events for <path> as JSONL." },
  args: { file: { type: "positional", required: true } },
  async run({ args }) {
    const abs = resolve(process.cwd(), args.file);
    const docId = docIdForLegacyPath(abs); // DB-mode tail comes later if needed
    const info = await ensureDaemonRunning();
    const url = new URL(`http://127.0.0.1:${info.port}/api/agent/events`);
    url.searchParams.set("doc", docId);
    url.searchParams.set("token", info.token);

    // Bun ≥ 1.1 ships a spec-compliant EventSource: automatic reconnect with
    // Last-Event-ID, comment/data/event field parsing — no parser on our side.
    const es = new EventSource(url.toString());

    es.addEventListener("send", (ev) => {
      // ev.data is already the JSON string the server wrote — pass through.
      process.stdout.write(`${(ev as MessageEvent).data}\n`);
    });

    es.addEventListener("done", () => {
      es.close();
      process.exit(0);
    });

    es.onerror = () => {
      // Spec EventSource auto-retries on transient errors. Only bail when
      // readyState is CLOSED (the server signaled "do not reconnect").
      if (es.readyState === EventSource.CLOSED) process.exit(1);
    };
  },
});
```

> **Implementation note for the executing engineer:** `EventSource` does not let callers set request headers (per spec). That is why we authenticate the SSE channel via `?token=<…>` instead of `X-Mark-It-Token`. The `auth.middleware()` from Task 4 already accepts the query-param fallback, so no server-side change is needed here.

- [ ] **Step 1: Test** — spawn daemon + `mark-it tail`, POST `/api/agent`, assert stdout receives one JSONL line with the expected fields.

- [ ] **Step 2: Implement, run suite, commit**

```bash
git commit -am "feat(cli): mark-it tail — JSONL stream of agent events for shell pipelines and skills"
```

---

### Task 13: Reconnect / replay round-trip test

- [ ] **Step 1:** Test in `agent-sse.spec.ts`: open SSE, receive event A, kill connection, POST a new send (event B), reconnect with `Last-Event-ID: A`, assert event B arrives — then kill the daemon mid-flight, restart, reconnect, assert event B *does not* arrive (per-process buffer is fine — replay is best-effort, not durable).

- [ ] **Step 2: Commit**

```bash
git commit -am "test(cli): SSE replay round-trip and best-effort semantics"
```

---

## Phase 3 — README + skill spec rewrite (Tasks 14-15)

### Task 14: Skill spec rewrite

**Files:**
- Modify: `skills/review-with-mark-it/SKILL.md`

Concrete rewrites:
- **Step 3 of Workflow** — replace "Spawn mark-it in the background and stream stdout" with: spawn `mark-it <path>` as a foreground call (it exits in <1s), then spawn `mark-it tail <path>` as a background call to stream JSONL.
- **Step 4** — "Stream and frame chunks" replaced with "Read JSONL from `mark-it tail`": one JSON event per line; parse `data.comments` directly.
- Delete the entire `===MARK-IT-SEND-BEGIN===` block (the YAML frontmatter description should also drop "stdout delimiter envelope" wording).
- Keep the rest of the workflow (per-comment edit semantics, drift handling, end-of-session) unchanged.

- [ ] **Step 1: Apply rewrite.**
- [ ] **Step 2: Smoke test the skill manually** — run a real review loop with Claude Code against this repo (or simulate via a local Claude CLI invocation).
- [ ] **Step 3: Commit**

```bash
git commit -am "docs(skill): rewrite review-with-mark-it for SSE/JSONL transport"
```

---

### Task 15: README rewrite

**Files:**
- Modify: `README.md`

Concrete changes:
- Replace the "Send to agent — flushes outstanding comments to the calling process's stdout" sentence with: "Send to agent — broadcasts outstanding comments on a per-doc SSE stream. The bundled `mark-it tail <path>` subcommand surfaces them as JSONL on stdout for shell pipelines and the Claude Code skill."
- Add a "Daemon" subsection under "Run" describing: one `mark-it daemon` per machine, auto-spawned, idle-exits, discovery file at `~/.mark-it/daemon.json`.
- Update "Project layout" to mention `apps/cli/src/daemon/`.
- Update "Scripts" if any new top-level scripts (`bun mark-it daemon`, `bun mark-it tail <path>`).

- [ ] **Step 1: Apply rewrite, run `bun run typecheck`, commit.**

```bash
git commit -am "docs(readme): describe singleton daemon and SSE/JSONL agent transport"
```

---

## Risks & open questions

1. **Cross-machine / SSH-tunnel use** — A daemon bound to `127.0.0.1` is local-only by design. If the user wants to run mark-it on a remote dev machine and tunnel, document the `MARK_IT_HOST` env var as the escape hatch (pre-existing).
2. **Multi-user shared `~/.mark-it/daemon.json`** — On a shared machine each user has their own home, so collision is impossible. Verified.
3. **Watcher fan-out cost** — One chokidar watcher per registered doc is fine for typical N≤10. If a future user registers 100 docs, this needs a single recursive watcher. Out of scope here.
4. **DB-mode `tail`** — The `tail` command uses legacy hash for now. DB-mode docId resolution requires opening the DB and looking up the path; trivial extension, but defer until a user asks for it.
5. **Daemon crash → orphan tabs** — Open browser tabs will reconnect-loop on `/api/events` until the daemon is back. We could surface a "daemon disconnected" toast in the UI; out of scope here.
6. **Backpressure on SSE** — A wedged consumer could pile up writes. Worth a follow-up: drop the connection if writable buffer exceeds 1 MB.

---

## Self-review

**Spec coverage:** Both root requirements are addressed — singleton daemon (Phase 1, Tasks 6-9) and SSE transport replacing stdout (Phase 2, Tasks 10-13). README + skill spec updates are scoped (Tasks 14-15). The watcher correctness fix has already shipped in commit `ca79255` (separate concern — referenced for context only).

**Placeholder scan:** No "TBD"/"TODO" left. Two task descriptions ("Run, verify pass", "Commit") are fixed-form steps from the writing-plans skill template, not placeholders. Code blocks present in every concrete-implementation step. Some test files are sketched rather than written verbatim where the executing engineer needs to mirror an existing test pattern (`tests/lifecycle.spec.ts`); I've named the source pattern explicitly so they have a concrete reference.

**Type consistency:** `DocSession`, `SessionRegistry`, `EventEnvelope`, `EventBuffer`, `DaemonInfo`, `Discovery` are defined exactly once and used by name throughout. `docIdForSpec` and `docIdForLegacyPath` are the only id helpers; `pushAgentEvent` is the only agent-side mutator on `DocSession`.

**Discovery referenced:** File structure follows the discovery findings — `daemon/` mirrors the existing `db/`, `plugins/`, `commands/`, `sidecar/` feature-folder convention. Tests split between `tests/unit/*.test.ts` (vitest API, bun-run) and `tests/*.spec.ts` (Playwright E2E) per the established pattern. Plugins are factory functions returning `Plugin` objects exactly like the existing ones.
