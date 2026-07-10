# mark-it

A reviewer for Markdown files. Open a Markdown file in a side-by-side rendered/source view, add line-anchored comments, then either save them to a `.review.yaml` sidecar or stream them back to a calling agent over a per-doc SSE channel.

Designed for these workflows:

- **Human review** — read a doc, leave comments, reply, resolve, persist them next to the file.
- **Agent-in-the-loop** — an AI assistant produces a Markdown artifact (plan, spec, PRD, design doc), opens it in mark-it for the user to comment on, then receives the comments back as structured JSON and revises the doc.
- **Multi-user review** — share an org/project workspace where multiple authenticated users can comment on a tree of documents, with comments persisted to a shared SQLite store and identity enforced server-side.

Comments are stored either as YAML sidecars (`<file>.review.yaml`) next to the document or, in multi-user mode, in a local SQLite database keyed by org/project/document. Both backends use the [Sidemark / MRSF](https://www.npmjs.com/package/@mrsf/cli) format and re-anchor automatically when the underlying Markdown changes.

## Requirements

- [Bun](https://bun.sh) ≥ 1.1 — runs the CLI and the bundled Vite dev server. Bun also ships the `bun:sqlite` driver used by multi-user mode.
- A modern browser (any current Chromium-, Firefox- or WebKit-based one) — the review UI runs there.
- Node 20+ — only if you want to run the built CLI without Bun.
- [Claude Code](https://docs.claude.com/en/docs/claude-code) — only if you want the bundled agent-in-the-loop skill (see "Agent skill" below).
- macOS, Linux, or Windows — no platform-specific dependencies; the daemon binds to `127.0.0.1` and discovery uses a JSON file under your home directory.

## Install

```sh
bun install
```

## Run

`mark-it` runs as a long-lived per-machine **daemon** that hosts many documents at once. Every `mark-it <path>` invocation is a thin client that registers the doc with the daemon (auto-spawning it the first time), focuses an existing tab if one is open, and exits in well under a second.

```sh
# Open a file. Spawns the daemon on first use; second invocation focuses the tab.
bun mark-it path/to/doc.md

# Pipe Markdown via stdin — captured to a temp file, then registered.
echo "# Hello" | bun mark-it

# No auto-open (the daemon still registers the doc; you can open it yourself).
bun mark-it path/to/doc.md --no-open
```

The daemon advertises itself via `~/.mark-it/daemon.json` (mode 0600) with a randomly-bound localhost port and an HMAC token. It idle-exits when no docs are registered for ~10 minutes — set `MARK_IT_DAEMON_IDLE_SECS=0` to disable, or run `mark-it daemon --idle-secs <N>` directly to control the threshold.

For pipelines that want a long-running server (e.g. the existing test suite), `mark-it review <path> --port <N>` keeps the legacy single-server-per-invocation behavior.

### Multi-user mode

For shared review across users (or across multiple documents in a project), use the DB-backed `review` subcommand:

```sh
# One-time setup
mark-it org create acme
mark-it user add @andreas --org acme --email andreas@example.com

# Open a document under an org/project as a specific user
mark-it review path/to/doc.md --org acme --project planning --user @andreas
```

In this mode the sidecar is persisted in `~/.mark-it/mark-it.db` (override with `--db <path>` or `MARK_IT_DB_PATH`), and the browser shows a left tree pane (org → projects → documents) for switching between documents in-place. Projects and document records are auto-created on first `review`. Every comment is tagged with the session user, and the server enforces that authors can only edit or reply as themselves.

## Use

In the browser:

- **Select text** in the rendered or source view to start a new comment.
- **Reply / edit / resolve / delete** from the comment sidebar.
- **Toggle rendered / raw** view from the toolbar.
- **Send to agent** — broadcasts outstanding comments on the per-doc Server-Sent Events channel (`/api/agent/events?doc=<id>`). Subscribers receive a structured `send` event with the comment payload and a monotonic event id; reconnects with `Last-Event-ID` replay missed events from a per-doc ring buffer (last 100). The session stays open so the agent can apply edits and you can keep commenting; close the tab when you're done.

The bundled `mark-it tail <path>` subcommand subscribes to the SSE stream for that path's docId and prints one JSON envelope per Send to stdout — the canonical entry point for shell pipelines and the Claude Code skill.

Comments persist in `<your-file>.md.review.yaml` next to the document, or in `~/.mark-it/mark-it.db` when running under `mark-it review --org/--project/--user`.

## Agent skill (Claude Code)

The repo bundles a [Claude Code skill](https://docs.claude.com/en/docs/claude-code/skills) at [`skills/review-with-mark-it/SKILL.md`](skills/review-with-mark-it/SKILL.md). When installed, Claude Code will offer to open substantial Markdown artifacts (plans, specs, PRDs, design docs) in `mark-it`, watch each Send round as JSONL on `mark-it tail`'s stdout, and apply each round of comments as targeted edits — looping until you close the browser tab.

### Install

Copy the skill into your Claude Code skills directory:

```sh
mkdir -p ~/.claude/skills/review-with-mark-it
cp skills/review-with-mark-it/SKILL.md ~/.claude/skills/review-with-mark-it/
```

The skill auto-discovers on Claude Code startup. The CLI also needs to be on `PATH` as `mark-it` — either install the built binary globally, or symlink `bun apps/cli/src/index.ts` to `/usr/local/bin/mark-it`.

### Use

- **Automatic** — Claude Code triggers the skill whenever it produces a long Markdown artifact and offers to open it in `mark-it`. Accept the offer to enter the review loop.
- **On demand** — invoke `/mark-it <path>` (or ask Claude Code to "review this in mark-it") to start a session against an existing file.
- **Plan mode** — when Claude is in plan mode, the skill offers a "review the plan in mark-it" option alongside the usual approve / approve-with-extra-permissions choices, and starts the loop right after `ExitPlanMode`.

Once a session is active, keep adding comments and clicking **Send to agent**; Claude reads each round and edits the document in place. Close the tab when you're done.

## Project layout

```
apps/cli                       # `mark-it` binary — citty CLI + Vite dev server + HTTP API
apps/cli/src/daemon            # Daemon entry, discovery, auth, session registry
apps/cli/src/plugins           # Vite plugins (one per /api/* namespace: document, sidecar, agent, …)
apps/cli/src/commands          # citty subcommands: review, open, tail, daemon, org, user, project
packages/core                  # Framework-agnostic store, sidecar IO, agent transports
packages/react                 # React components: Document, Toolbar, CommentSidebar, SplitView, MarkItProvider
skills/review-with-mark-it     # Bundled Claude Code skill that drives agent-in-the-loop review
```

## Scripts

```sh
bun run typecheck   # tsc -b across the workspace
bun run build       # build all @mark-it/* packages
bun run test        # unit tests (vitest)
bun run test:e2e    # Playwright acceptance tests against the CLI
```




