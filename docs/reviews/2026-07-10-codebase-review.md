# mark-it — Full Codebase Review

**Date:** 2026-07-10
**Scope:** entire repository (`apps/cli`, `packages/core`, `packages/react`, bundled skill, docs)
**Size reviewed:** ~5.8k LOC source (CLI 2.7k, core 0.5k, react 2.6k) + ~2.7k LOC tests
**Method:** four parallel deep-read agents, one per layer (CLI daemon/commands, CLI plugins/db, packages/core, packages/react+web), each instructed to check correctness, architecture, test coverage, and documentation with file:line citations. The most severe cross-cutting claims were independently re-verified directly against source after the agents reported (see [Verification notes](#verification-notes)). Findings are numbered (F1, F2, …) for reference.

---

## Executive summary

The hot path this tool cares most about — comment anchoring, re-anchoring on drift, the chokidar file-watch edge cases — is careful, well-commented, and mostly correct. The problems are concentrated at the *seams*: every place the codebase has two hand-maintained implementations of the same thing (two server plugin lists, two CLI command bodies, two drift-threshold checks, two SSE framing helpers, four `readJson` bodies), the copies have already drifted apart, and the drift breaks two things the README advertises as headline guarantees:

1. **Multi-user identity enforcement doesn't work in either mode it's supposed to work in** — broken by a different mechanism in each (F1).
2. **Concurrent comment writes silently lose data** — no locking anywhere in the mutation path, in three independent places (F2).

Neither of these is exotic to trigger — F1 requires only using the documented `--org/--project/--user` flags; F2 requires only two comments landing close together, which is the entire point of the "multi-user review" feature. Both are completely untested, which is consistent with them being invisible until this review.

Test coverage is uneven: the CLI's daemon lifecycle and DB layer are genuinely well-tested; `packages/react` has **zero** unit or component tests; and the Playwright acceptance suite, while covering real user flows, systematically bypasses the single highest-risk piece of logic in the whole system (mapping a text selection to a line-anchored comment) by dispatching an internal event directly instead of driving a real selection.

Documentation is bimodal — some non-obvious invariants are explained exactly where they matter (chokidar-on-parent-dir, bye/grace-window semantics, capture-phase click handling), while others are silent at exactly the point a bug later occurred. The most consequential documentation finding is self-referential: the **globally-installed copy of this repo's own `review-with-mark-it` skill is stale**, describing a pre-daemon architecture that no longer exists — and it's the exact file loaded at the start of this review.

None of this changes the assessment that the core engineering (MRSF integration, daemon lifecycle, chokidar handling) is careful work. The issues below are what a full-codebase pass is for.

---

## Critical findings (cross-layer synthesis)

### F1 — Multi-user identity enforcement is broken, by two different mechanisms, in the two modes meant to provide it

**Daemon mode** (`mark-it open --org/--project/--user`, the documented default entry point):
`apps/cli/src/commands/open.ts:41-57` resolves and validates the org/user, then builds an `ActiveDocumentSpec` — but `ActiveDocumentSpec` (`apps/cli/src/server.ts:28-34`) has no field for the resolved user at all, so it's silently dropped. On the daemon side, `apps/cli/src/daemon/index.ts:161-183` constructs **every** plugin that could use identity with a hardcoded `null` session: `markItRegistryPlugin({ defaultSession: null, ... })` (line 166), `markItSidecarPlugin(registry, null)` (line 172), `markItSessionPlugin(registry, null, opts.db)` (line 182), `markItTreePlugin(opts.db, null, registry)` (line 183). There is no parameter, flag, or code path anywhere in `commands/daemon.ts` or `daemon/index.ts`'s options to supply a real session — this isn't a conditional bug, it's a structurally absent wire. Two consequences: `apps/cli/src/plugins/sidecar.ts:19-33`'s `enforceIdentity` opens with `if (!session) return;`, so **any caller can forge any `author`/`x_user_id`**; and `apps/cli/src/daemon/sessions.ts:55`'s `makeStore` requires a truthy `session` to construct a `DbSidecarStore`, so DB-tagged documents silently fall back to persisting on disk as `.review.yaml`, never in the database at all, regardless of the `--org/--project/--user` flags used to open them.

**Legacy/DB server mode** (`mark-it review --org/--project/--user`, via `server.ts`'s `startServer`):
Here the session *is* threaded through correctly — `server.ts:154,162,163` passes `opts.session ?? null`, and `commands/review.ts:60-65` does build a real session object. But `server.ts:151-164`'s plugin list has **no auth plugin at all** — compare the daemon's list, which opens with `markItAuthPlugin(token)` (`daemon/index.ts:161`); this list has no equivalent gate on any `/api/*` route. Worse, `apps/cli/src/plugins/session.ts:52-63`'s `GET /api/session` handler returns `{ user: { id: session.userId, handle: session.userHandle }, ... }` to **any** unauthenticated caller who can reach the port. So the exact `userId`/`userHandle` pair `enforceIdentity` checks a write payload against is freely readable by anyone — the check is real, but there's no barrier to reading the answer key first.

**Net result:** the feature described in the README as "the server enforces that authors can only edit or reply as themselves" does not hold in either mode — in daemon mode because enforcement never runs, in server mode because its input is unauthenticated and its secret isn't secret. `identity-enforcement.spec.ts` only exercises `commands/review.ts`'s path and passes, which is why this has gone unnoticed — the spec never sends an unauthenticated read of `/api/session` first, and never exercises `open.ts`'s multi-user flags at all.

*Sources: CLI daemon/commands agent + CLI plugins/db agent, cross-verified directly (see Verification notes).*

### F2 — No concurrency control anywhere a comment gets written; three independent races

- **Lost-update race on every sidecar mutation** (`apps/cli/src/plugins/sidecar.ts:88-110`, `apps/cli/src/plugins/agent.ts:55-60`, `apps/cli/src/daemon/sessions.ts:73-99`): every mutating path does `load()` → mutate in memory → `save()` with no lock, mutex, or optimistic-concurrency check anywhere in the call chain (confirmed: no `lock`/`mutex` token exists in `sidecar.ts`, `sidecar/store.ts`, or `db/queries.ts`). The DB path's `saveSidecarBlob` (`apps/cli/src/db/queries.ts:93-98`) is a blind `UPDATE documents SET sidecar_yaml = ? WHERE id = ?` with no version column and no prior-value check — confirmed directly. Two comments landing close together (two people, or one person's edit racing an agent's "resolve") silently drop one, both requests returning `200 OK`. This directly undermines the multi-user feature's core promise.
- **Stale-response race in the React client** (`apps/cli/web/main.tsx:88-140`): `refresh()` has no request-generation guard — only an unmount guard. Two overlapping `refresh()` calls (e.g. from rapid tree-pane switching) can resolve out of order, and since the four state setters are applied independently (lines 107-110), a stale response can clobber part of the newer document's state.
- **Cross-tab/cross-user broadcast hijack in DB/tree mode**: `apps/cli/src/plugins/session.ts:106,109`'s `/api/document/select` flips one process-wide `registry.getActive()` pointer and broadcasts a bare `"change"` event to **every** connected client — the broadcast callback in `server.ts` discards its own `docId` argument (`broadcast: (_docId, event) => broadcastSse(lifecycle.clients, event)`). One user selecting a different document in the tree pane causes every other connected tab/user to silently refetch and follow along. `acceptance-tree.spec.ts`'s own TREE5 test confirms "active document" is a single global concept, but no test opens two concurrent browser contexts to check whether that's the intended design or an oversight — worth a deliberate decision either way.

*Sources: CLI plugins/db agent (lost-update race, confirmed directly) + React/web agent (client-side races).*

### F3 — Drift-threshold split-brain between `packages/core` and `packages/react`

`packages/core/src/sidemark.ts` imports `HIGH_THRESHOLD` from `@mrsf/cli/browser` (aliased `MRSF_HIGH_THRESHOLD`, value `0.8`), re-exports it (line 154) — but never uses it. Its own render-classification logic (`commentsForRender`, line 89) gates only on a locally-invented `PERFECT_SCORE = 0.99`. Meanwhile `packages/react/src/CommentSidebar.tsx:358` imports that re-exported constant and uses it independently: `const lowScore = score != null && score < MRSF_HIGH_THRESHOLD`. Both confirmed directly by grep. These are two independently-computed answers to "is this comment's anchor still trustworthy," using different thresholds, with nothing forcing them to agree. For comments whose re-anchor score falls below 0.8 but whose `anchored_text` still literally matches something in the source, the rendered document body can confidently highlight a specific location while the sidebar simultaneously flags the same comment as anchor-lost — a real, reachable, self-contradictory UI state. `packages/react/src/CommentSidebar.tsx:333-388`'s `driftInfo()` is, more broadly, a second independent reimplementation of `commentsForRender()`'s scoring logic — nothing keeps the two in sync, and no test would catch them diverging further.

*Source: packages/core agent + React/web agent (each found one half independently); threshold values cross-verified directly.*

### F4 — `formatForAgent` crashes the entire send batch on one malformed comment

`packages/core/src/agent/formatter.ts:29,35` calls `.text.split("\n")` on every comment and reply with no guard for a missing `text` field. A single comment record without `text` — plausible, since the sidecar YAML is an openly user-editable file the product explicitly supports hand-editing — throws an uncaught `TypeError` that aborts formatting for **every** comment in the batch, not just the malformed one. There is no upstream validation catching this (see F6's related note on unused `@mrsf/cli` validators).

*Source: packages/core agent.*

### F5 — Unrecoverable stale spawn-lock can wedge the entire CLI

`apps/cli/src/daemon/discovery.ts:65-69`'s `acquireSpawnLock()` is a bare `mkdirSync(lock)` with no TTL, no staleness check, and no PID recorded inside the lock directory. If the CLI process dies (SIGKILL, OOM) between acquiring the lock and its `finally` release (`client.ts:32,60-62`), the lock directory is never removed. Every subsequent `mark-it` invocation hits `EEXIST`, falls through to `waitForDaemonFile`, and after a 10s timeout throws `"daemon did not start within 10000ms — see ~/.mark-it for stale state"` — forever, until a human manually deletes `~/.mark-it/.daemon.lock`. Nothing in source or tests busts a stale lock.

*Source: CLI daemon/commands agent.*

### F6 — The globally-installed `review-with-mark-it` skill is stale (self-referential finding)

The repo's bundled copy (`skills/review-with-mark-it/SKILL.md`) was correctly rewritten for the daemon+SSE architecture (per `docs/plans/2026-05-07-singleton-daemon-and-sse-transport.md`'s Task 14, commit `728c968`). The **globally-installed** copy at `~/.claude/skills/review-with-mark-it/SKILL.md` was never re-synced — it still describes the old, removed design: a foreground-blocking process emitting a `===MARK-IT-SEND-BEGIN===` stdout envelope, with no daemon, no `mark-it tail`, no `/api/agent/events`. This is not hypothetical: it's the exact file this review session loaded when invoking the skill for this task, before the drift was caught by cross-referencing git log against the loaded skill body. The README's own install instructions (`cp skills/review-with-mark-it/SKILL.md ~/.claude/skills/review-with-mark-it/`) create exactly this failure mode — manual copy, no version marker, no staleness check — for every user who updates the repo copy after their first install.

*Source: this review's own cross-cutting check, not a subagent.*

---

## Architecture assessment

### Root-cause theme: parallel hand-maintained implementations have already drifted

This is the single biggest structural pattern in the codebase, and it's the direct cause of F1 and contributes to F3:

- `daemon/index.ts` and `server.ts` are two hand-synchronized plugin-wiring lists (compare `daemon/index.ts:160-184` against `server.ts:151-164`) — one has auth and no session, the other has session and no auth.
- `commands/open.ts` and `commands/review.ts` independently duplicate `resolveSource()`, `openBrowser()`, and the org/project/user resolution block near-line-for-line — `review.ts`'s copy correctly threads the resolved user into `session`; `open.ts`'s copy computes the identical value and discards it (F1's proximate cause).
- Four independent hand-rolled SSE wire-framing implementations (`agent-stream.ts:13-15`, `server.ts:183-192`, `daemon/index.ts:123-132,237-246`, plus inline literals in `events.ts`).
- Four independent `readJson` body-buffering implementations (`agent.ts`, `registry.ts`, `session.ts`, `sidecar.ts`), each with its own unbounded-body-size exposure.
- `packages/core/src/sidemark.ts`'s drift classification and `packages/react/src/CommentSidebar.tsx`'s `driftInfo()` independently reimplement the same scoring logic (F3).
- `packages/core/src/agent/clipboard-transport.ts` is fully built, exported, and unit-tested — but has **zero** production consumers. `packages/react/src/CommentSidebar.tsx:140-152` and `Toolbar.tsx:48-60` each independently reimplement the same format-then-copy sequence inline instead of using it.

None of these individually look serious; together they're the load-bearing pattern behind this review's critical findings. Worth a deliberate consolidation pass (shared plugin-wiring config, one `readJson`/`json` helper module, one drift-classification function core exports and the UI simply calls) rather than fixing each drifted pair in isolation.

### Package boundaries — mostly clean, worth stating as a positive

- `packages/core` is genuinely framework-agnostic: no React/DOM/Node leakage found; it deliberately imports `@mrsf/cli/browser` to avoid `node:path`/`node:url` (`sidemark.ts:1-3`).
- `packages/react` has no direct `fetch`/`window.location`/hardcoded-endpoint coupling — all CLI-specific plumbing is correctly confined to `apps/cli/web/main.tsx`, with `commentApi`/`transports` injected as props.
- No circular workspace dependencies (`core` has no dependency on `react` or the CLI; `react` depends only on `core`; the CLI depends on both) — verified directly.
- One caveat on reusability: `packages/react` coordinates through a page-global `window.mrsfDisableBuiltinUi` flag and un-scoped `document`-level custom events (`mrsf:add`, `markit:reply-focus`, `markit:edit-focus`) — fine for one active document per page (mark-it's actual usage) but would cross-talk if two provider instances were ever mounted simultaneously. Worth documenting as a known constraint if wider reuse is a goal.

### Ecosystem-recreation: mark-it reimplements weaker versions of its own installed dependency

`@mrsf/cli@0.4.2` is already a dependency, and its public surface includes several functions mark-it needs but doesn't use, hand-rolling thinner versions instead:

- `parseSidecarLenient`/`parseSidecarContentLenient` — a salvage parser built specifically for corrupted YAML, returning partial comments plus an error rather than throwing. `sidecar/store.ts:20`'s `DiskSidecarStore.load()` uses the strict `parseSidecar` instead, so any corruption 500s the whole document with no salvage path — exactly the case the dependency already solved.
- `validate`/`validateFile` — schema + cross-field validation (duplicate ids, `end_line < line`, oversized `text`/`selected_text`, hash consistency) — never called; `sidecar.ts`'s `applyAction` does only minimal ad-hoc presence checks.
- `populateSelectedText(comment, documentLines)` — exported by the library for exactly this purpose — isn't imported; `sidecar.ts:144-151` hand-derives the same thing from scratch, with less capability (no column-range support).

Separately, `db/migrate.ts` hand-rolls a ~25-line migration runner (filename-sorted, table-tracked) rather than using a maintained migration library — functionally adequate for the one migration that exists today, but reinvents ordering guarantees and reapply-detection that established packages already provide.

### Process gap: no CI

No `.github/workflows/` directory exists. `CONTRIBUTING.md` documents a `typecheck && test && test:e2e` gate contributors are expected to pass, but nothing runs it automatically on a PR — the gate is honor-system only.

---

## Test coverage assessment

**By the numbers:** `packages/react` has zero unit or component test files (`vitest run --passWithNoTests` is the literal test script) for 2,629 lines of source — the largest single package by LOC in the repo. `packages/core/src/agent/http-transport.ts` — the one file this review's brief flagged by name for error-handling scrutiny — has no test at all. Several CLI files (`daemon/client.ts`, `commands/tail.ts`) are only exercised transitively by full-process specs that re-implement their own helpers rather than calling the real functions, leaving specific branches (spawn-lock contention, `waitForDaemonFile` timeout, non-200 register/unregister responses) with no direct coverage.

**The highest-risk logic in the entire system has zero coverage at any level.** Every Playwright spec's `dispatchAdd()` helper fires the internal `mrsf:add` CustomEvent directly via `page.evaluate` — bypassing real text selection and real gutter/tooltip clicks entirely. `MrsfBridge`'s click-capture/routing logic (`MarkItProvider.tsx:198-307`, including a confirmed `querySelector`-ambiguity bug on nested blocks sharing a line number) has no coverage, and the only two test fixtures (`plan.md`, `doc-b.md`) contain zero blockquotes and zero tables, so the corpus can't structurally reach that code path regardless of what's asserted.

**Specific shipped, README-documented features with test IDs defined but zero test references anywhere in the suite:** the entire comment-edit feature (`edit-form`/`edit-input`/`edit-submit`/`edit-cancel`), the per-thread "…" menu including the `cascade: true` delete path, reply edit/delete, and both split-view resize handles (mouse-drag or keyboard, either divider). This was confirmed by grepping every `data-testid` in the 15 React/web files against every Playwright spec.

**Concurrency bugs are entirely untested**, unsurprising since nothing in the suite attempts concurrent operations — `unit/db.test.ts`'s sidecar round-trip test is strictly sequential, and no test opens two browser contexts against one server.

**What's genuinely well-tested, worth crediting:**
- `db/queries.ts` — thorough happy-path coverage with real value assertions (UNIQUE constraints, FK cascades, upsert idempotency).
- `daemon/discovery.ts` — missing-file, round-trip + mode 0600, dead-PID handling, lock exclusivity all covered.
- `agent-sse.spec.ts`'s replay test — a genuine behavioral test (drop connection, push an event with zero subscribers, reconnect with `Last-Event-ID`, assert the specific missed event replays), not a rubber-stamp.
- `cli-org.spec.ts` / `identity-enforcement.spec.ts` (for the one path it covers) / `unit/sessions.test.ts`'s atomic-rename watcher test — all exercise real behavior with real assertions.
- The Playwright suite overall covers real breadth (draft submission, view toggle, replies, drift badges, tree-pane switching, DB persistence) — the gaps above are specific and named, not a general indictment of the suite's approach.

---

## Documentation assessment

**Headline gap:** F6 above — the globally-installed skill copy describing a removed architecture.

**README accuracy:** the identity-enforcement claim ("the server enforces that authors can only edit or reply as themselves") is not currently true in either mode per F1. Everything else checked in the README — the daemon model, idle-exit semantics, SSE transport description, project layout, listed scripts — matches the implementation.

**Good examples, worth crediting as the bar the rest falls short of:**
- `apps/cli/src/daemon/sessions.ts:101-105` — clearly explains the chokidar-on-parent-directory-vs-single-file gotcha (atomic-rename writes losing the watched inode).
- `apps/cli/src/daemon/index.ts:95-100,111-115` — bye/grace-window semantics for tab-close unregistration.
- `apps/cli/src/plugins/sidecar.ts:74-77` — explains why `ensureFreshAnchors` re-checks on every GET rather than trusting the watcher alone.
- `packages/react/src/MarkItProvider.tsx:192-197` — capture-phase click rationale for `MrsfBridge`.
- `packages/core/src/sidemark.ts`'s block comments on `commentsForRender` — verified against the actual installed `@mrsf/cli` source and found accurate, not just plausible-sounding.

**Gaps, concentrated exactly where bugs then occurred:**
- `daemon/sessions.ts:51-59`'s `makeStore` gate (`ext?.db && ext.session && ...`) has no comment explaining that daemon mode never supplies a session — the exact condition behind F1.
- `daemon/discovery.ts:65-69` — no comment flags the lock's lack of staleness recovery (F5).
- `daemon/auth.ts:6-10` — no comment explains why the token is accepted via both header and query param (the real reason — `EventSource` can't set custom headers — lives only in the reader's head).
- `apps/cli/web/main.tsx:23-26` — documents the doc/token URL-param scheme for daemon vs. legacy mode, but not that `selectDoc()` never updates the URL in DB/tree mode — the single most load-bearing fact for reasoning about the cross-tab hijack in F2.
- `packages/core/src/agent/transport.ts:5` — `document.content` has a doc comment but nothing notes it's populated everywhere and read nowhere.
- `packages/react/src/MarkItProvider.tsx:54-63`'s `CommentApi` interface — 1 of 7 methods has a doc comment.
- `packages/react/src/TreePane.tsx:3-25` — zero doc comments on the props/payload types, including non-obvious contract details like `onSelectDocument`'s return value being awaited to drive a busy-state.
- `db/migrate.ts` — no comment states the load-bearing invariant that applied migration files must never be edited afterward.

---

## Detailed findings ledger

Full per-layer detail, all file:line cited. Severity tags: 🔴 critical, 🟠 moderate, 🟡 minor.

### apps/cli — daemon & commands

🔴 **F1a** (see F1) — `open.ts:41-57` + `daemon/index.ts:161-183` — daemon-mode identity never wired through.
🔴 **F5** — `discovery.ts:65-69` — stale spawn-lock has no recovery path.
🟠 `discovery.ts:26-33,38-47` — liveness check is PID-existence only, never confirms the port actually accepts a connection; a wedged-but-alive daemon or recycled PID silently poisons clients.
🟠 `tail.ts:29,37` — reconnect loop never re-resolves `DaemonInfo`; if the daemon restarts (new port/token), `tail` fails forever despite a comment claiming it handles "daemon restart."
🟠 `index.ts:28` — `preprocessArgv`'s `first.startsWith("-")` guard runs before subcommand detection, so a leading flag (e.g. `mark-it --no-open`) isn't routed to `open` as documented.
🟠 `daemon/index.ts:104-121` — `scheduleUnregister`'s bye-grace timer isn't reliably cancelled on re-register within the grace window (~3s race).
🟠 No `.on("error", ...)` on the browser-opener child process (`open.ts:101-107`, `server.ts:194-200`) — a missing opener binary can crash the process after the CLI has already done its job.
🟠 `client.ts:39-58` hardcodes `spawn("bun", ...)` with no error handler; combined with `apps/cli/package.json`'s CLI package being excluded from the root `build` filter (`@mark-it/*` doesn't match unscoped `mark-it-cli`), the README's "Node 20+ without Bun" path looks unverified today.
🟠 Inconsistent error handling — `open.ts`/`tail.ts` call daemon-spawn functions with no try/catch, unlike the clean exit-1 pattern used a few lines earlier in the same functions.
🟡 `ids.ts:4-7` hashes the lexically-resolved path, not a realpath — a symlink or case-differing spelling produces a different docId.
🟡 `auth.ts:11` — token comparison isn't constant-time (low impact given a 256-bit random token over loopback).
🟡 `daemon/index.ts:199-213` — `onSignal` has no re-entrancy guard against a second SIGTERM/SIGINT mid-teardown.
🟡 `sessions.ts:106-111` — one chokidar watcher per doc, no cap on concurrently-registered docs.
🟡 `client.ts:98-110` — `unregisterDoc` is exported but has zero callers anywhere.

**Test coverage:** `tail.ts` and `daemon/client.ts` are the biggest gaps — no test calls their functions directly; full-process specs re-implement their own SSE-parsing/spawn helpers instead. `open.ts`'s `--org/--project/--user` branch (the exact branch behind F1a) has no test anywhere. `sessions.ts`'s active-doc-reassignment-on-unregister branch and `dispose()`'s SSE teardown are untested. `auth.ts` is only tested for "no token" → 401, never "wrong token." Well covered: `org.ts`/`project.ts`/`user.ts` (real DB-state assertions), `review.ts` (the best-covered command in scope), `discovery.ts`'s happy paths, `ids.ts`.

### apps/cli — plugins, agent buffer, sidecar store, db

🔴 **F2a** (see F2) — `sidecar.ts:88-110`, `agent.ts:55-60`, `queries.ts:93-98` — no locking around sidecar load-mutate-save; confirmed blind `UPDATE`.
🔴 **F1b** (see F1) — `server.ts:151-164` has no auth plugin; `session.ts:52-63`'s `/api/session` leaks identity unauthenticated.
🟠 `events.ts:49-70` — `/api/events` doesn't check `req.method` and doesn't handle `resolveSession`'s error case, unlike every sibling plugin; an unknown doc id gets a hung-open 200 SSE stream instead of 404.
🟠 `tree.ts:22-44` — `loadTreeForOrg` has no try/catch, unlike every other plugin; a non-null-assertion (`findOrgById(...)!`) can throw uncaught into Vite's middleware stack.
🟠 `document.ts:18-22` vs `session.ts:66` — `/api/document` and `/api/document/select` share a path prefix; only works today because `document.ts` happens to call `next()` for non-GET — a `GET /api/document/select` is silently swallowed and returns the wrong document.
🟠 `db/index.ts:5-10` — WAL mode set, but no `busy_timeout` pragma; concurrent DB-touching processes risk spurious "database is locked" instead of graceful queuing.
🟠 `sidecar.ts:19-33` — `enforceIdentity`'s `writeActions` set omits `resolve`/`unresolve`/`delete`/`resolveAll` — any session holder can delete or resolve another user's comment with no author check.
🟡 `sidecar.ts:140-151` — trusts client-supplied `selected_text` verbatim with no verification it occurs at the stated line.
🟡 `agent.ts:58` — `resolveComment`'s boolean return is discarded; a bogus id in `resolveIds` silently no-ops.
🟡 `registry.ts:60-71` — accepts a full client-supplied spec (including `documentId`/`projectId`) with no ownership check.
🟡 `registry.ts:80` — auth token embedded in the returned URL (browser-history exposure); reasonable given the initial navigation can't set headers.
🟡 Four independent unbounded body-read implementations (`agent.ts`, `registry.ts`, `session.ts`, `sidecar.ts`).
✅ Checked and clean: no SQL injection anywhere in `queries.ts` (parameterized throughout); `0001-init.sql` is fully idempotent (`IF NOT EXISTS` everywhere).

**Architecture:** `DiskSidecarStore` and `DbSidecarStore` are not behaviorally equivalent behind their shared interface — the disk path gets write-serialization and hash-syncing "for free" from `@mrsf/cli`'s `writeSidecar`; the DB path (hand-rolled `yaml.parse`/`stringify` + blind `UPDATE`) gets neither. See Ecosystem-recreation above for the unused `parseSidecarLenient`/`validate`/`populateSelectedText` findings.

**Test coverage:** `registry.ts` and `events.ts` have no direct assertions on their own contracts (only incidental use as test setup). `sidecar.ts`'s `edit`/`delete`/`unresolve`/unknown-action branches are untested — only `add`/`reply`/`resolve`/`resolveAll` are exercised. Buffer overflow past capacity 100 is only unit-tested at capacity 2/10, never through the real SSE endpoint. Malformed sidecar YAML on read is untested for both stores. Migration failure/rollback is untested (happy-path only). Well covered: `unit/db.test.ts` (thorough, real assertions), `unit/buffer.test.ts`, `agent-sse.spec.ts`'s replay test.

### packages/core

🔴 **F4** (see F4) — `formatter.ts:29,35` — `.text.split("\n")` with no guard, crashes the whole batch on one malformed comment.
🟠 **F3** (see F3) — `sidemark.ts` vs `CommentSidebar.tsx` — drift-threshold split-brain.
🟠 `formatter.ts:14-22,32` — a reply whose parent isn't in the same comments array is silently dropped from the formatted text output (though it still ships in the raw JSON payload) — reachable via "resolved root, unresolved reply" through `Toolbar.tsx`'s send-all-unresolved filter.
🟠 `transport.ts:5`, `formatter.ts:9`, `http-transport.ts:37-41` — `document.content` is populated by every caller at real cost (full document text) and read by nothing downstream, client or server.
🟠 `http-transport.ts:42` — the `fetch` call has no try/catch; non-2xx is handled cleanly, a raw network failure propagates as a bare contextless rejection.
🟡 `sidemark.ts:147-152` — `isOrphanedAnchor` returns true for any comment lacking anchor info, which is every reply; the one caller guards correctly but the precondition isn't documented on the function itself.
🟡 `sidemark.ts:19` — `stripLinePrefix` doesn't recognize the `1)` ordered-list form and only strips one layer of a compound prefix.
🟡 `frontmatter.ts:12` — the closing-fence regex would truncate early if a frontmatter value itself contained a literal `---` line (narrow, likely shared with the actual parsing pipeline's own behavior — unverified either way).

**Architecture:** `clipboard-transport.ts` is fully built and tested with zero production consumers (see Root-cause theme above). `transport.ts:9`'s `intent` field is populated everywhere, read nowhere — dead data threaded through the whole type system. `package.json` declares a `js-yaml` runtime dependency that nothing in `src/` imports — frontmatter handling is 100% regex-based text splitting, never real YAML parsing.

**Test coverage:** `http-transport.ts` has no test at all. `store.ts`'s `openEdit`/`closeEdit` are untested. `commentsForRender` is never tested against a reply-shaped comment. `formatter.ts` has no empty-array test, no multi-line-text test (despite the code being written to handle it), no dangling-reply test. `frontmatter.test.ts` never asserts `lineCount`'s actual value on either of its two real-frontmatter cases, despite it directly driving line-anchoring math elsewhere.

**Documentation:** genuinely strong in places — the `commentsForRender` comments were verified against the installed `@mrsf/cli` source and found accurate, not just plausible. `store.ts`'s `subscribe` (load-bearing for its `useSyncExternalStore` usage in `MarkItProvider`) has no doc comment on its "fires only on subsequent calls, never immediately" contract.

### packages/react + apps/cli/web

🔴 **F2b/F2c** (see F2) — `MarkItProvider.tsx:111,330-389` + `main.tsx:88-140` — stale-document-switch race; `session.ts:106,109` — cross-tab broadcast hijack.
🟠 `MarkItProvider.tsx:235-238` — `MrsfBridge`'s `querySelector('[data-mrsf-line="..."]')` returns the first DOM match, which can be an outer ancestor (e.g. a table/blockquote) rather than the specific clicked block, over-broadening the anchor. Not reachable by current test fixtures (no blockquotes/tables in either fixture file).
🟡 `RenderedView.tsx:12-20` — a `useMemo` omits `doc` from its dependency array, correct today only because of an unenforced invariant elsewhere.
🟡 `CommentSidebar.tsx:390-393` vs `:260` — two different "extract name from `Author (id)`" implementations in the same file that disagree on inputs without a space before the parenthesis.
🟡 `CommentSidebar.tsx:161-184` — a focus-listener effect depends on a freshly-allocated array every render, causing harmless but unnecessary listener churn.
✅ Checked and clean: line-number attribution (frontmatter-inclusive, 1-based) is correct and consistent across `RawView.tsx`/`rehype-block-lines.ts`, hand-verified against `frontmatter.ts`. XSS: no `dangerouslySetInnerHTML` anywhere, `allowDangerousHtml: false` in the pipeline, the vendored MRSF controller escapes all comment fields before any `innerHTML` write. Listener/SSE cleanup is consistently correct across all six major files checked.

**Architecture:** the package/CLI boundary is genuinely clean — no direct `fetch`/`window.location` coupling in `packages/react`; all CLI-specific plumbing lives in `main.tsx`. Coordination relies on a page-global flag and unscoped document-level custom events — fine for one active document per page, worth documenting as a constraint. `main.tsx:196`'s `isDbMode` check probes a `legacy` field the shared `TreePayload` type doesn't declare (confirmed the endpoint really does omit it outside DB mode) — an unchecked cast papering over an incomplete shared type.

**Test coverage:** zero unit/component tests confirmed (`vitest run --passWithNoTests`). The Playwright suite has real breadth but every `dispatchAdd()` helper bypasses real selection/click entirely via direct CustomEvent dispatch — the entire `MrsfBridge` click-routing path, and real text-selection-to-anchor mapping, has no coverage at any level. Confirmed-untested-but-shipped: the entire comment-edit feature, per-thread menu actions (including cascade delete), reply edit/delete, both split-view resize handles. No test opens two concurrent browser contexts, so the cross-tab hijack (F2c) is unverified as intentional-or-not in either direction.

**Documentation:** bimodal — `SplitViewProps`, `MrsfBridge`'s capture-phase rationale, `rehypeBlockLines`'s purpose comment, and `driftInfo`'s reasoning are all clear and accurate; `CommentApi` (1 of 7 methods documented), `TreePane`'s prop/payload types (zero doc comments), and the doc/token URL scheme's incompleteness for tree mode (undocumented, and the single most load-bearing fact for reasoning about F2c) are not.

---

## Suggested fix priority

1. **F1** — wire a real session through daemon mode (`open.ts` → `daemon/index.ts`), and add the missing auth plugin to `server.ts` (or make `/api/session` require it). These are two small, independent, well-scoped fixes.
2. **F2a** — add a per-doc write lock (even a simple in-process mutex/queue keyed by docId) around the sidecar load-mutate-save cycle; add a version/`updated_at` check to `saveSidecarBlob`'s `UPDATE`.
3. **F4** — guard `formatter.ts`'s `.text` access; consider adopting `@mrsf/cli`'s `validate`/`parseSidecarLenient` at the same time (kills two birds — see Ecosystem-recreation).
4. **F5** — add a staleness check to the spawn-lock (mtime + liveness of a recorded PID) so a crashed process can't wedge the CLI permanently.
5. **F3** — pick one threshold and one classification function in `packages/core`, have `CommentSidebar.tsx` call it instead of reimplementing it.
6. **F6** — re-sync the global skill copy now; consider a version marker in the skill frontmatter so future drift is detectable rather than silent.
7. Add a CI workflow running `typecheck`/`test`/`test:e2e` on PRs — cheap, and would have caught several of the untested branches above as soon as anyone tried to cover them.
8. Longer-term: consolidate the parallel-implementation pairs under Root-cause theme (shared plugin-wiring, shared SSE-framing helper, shared `readJson`/`json` module) so this class of bug stops recurring.

---

## Verification notes

Four subagents each reviewed one layer independently (CLI daemon/commands, CLI plugins/db, packages/core, packages/react+web), citing file:line for every finding. After collecting all four reports, the highest-severity cross-cutting claims (F1's daemon/server plugin wiring, F3's threshold values, F2a's absence of any locking primitive) were independently re-read directly from source by the coordinating pass and confirmed exact — down to the specific line numbers — before being written into this report. Lower-severity findings (moderate/minor tiers, and all test-coverage/documentation observations) are reported as each subagent found them, with file:line citations left in place so they're independently checkable, but were not separately re-verified line-by-line given the volume involved. Where a subagent's own report noted it had itself cross-checked a claim against an external source (e.g. the installed `@mrsf/cli` package's actual behavior), that's noted inline in the relevant finding.
