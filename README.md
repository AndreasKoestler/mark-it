# mark-it

A reviewer for Markdown files. Open a Markdown file in a side-by-side rendered/source view, add line-anchored comments, then either save them to a `.review.yaml` sidecar or stream them back to a calling agent on stdout.

Designed for two workflows:

- **Human review** — read a doc, leave comments, reply, resolve, persist them next to the file.
- **Agent-in-the-loop** — an AI assistant produces a Markdown artifact (plan, spec, PRD, design doc), opens it in mark-it for the user to comment on, then receives the comments back as structured text and revises the doc.

Comments are stored in [Sidemark / MRSF](https://www.npmjs.com/package/@mrsf/cli) sidecar files (`<file>.review.yaml`) and re-anchor automatically when the underlying Markdown changes.

## Requirements

- [Bun](https://bun.sh) ≥ 1.1
- Node 20+ (only needed if you want to run the built CLI without Bun)

## Install

```sh
bun install
```

## Run

From the workspace root:

```sh
# Open a file in the review UI (auto-opens browser)
bun mark-it path/to/doc.md

# Pipe Markdown via stdin
echo "# Hello" | bun mark-it

# Custom port, no auto-open
bun mark-it doc.md --port 4000 --no-open
```

The CLI starts a local server, serves the document and its sidecar over a small HTTP API, and watches the file for changes (re-anchoring comments when it edits).

## Use

In the browser:

- **Select text** in the rendered or source view to start a new comment.
- **Reply / edit / resolve / delete** from the comment sidebar.
- **Toggle rendered / raw** view from the toolbar.
- **Send to agent** — flushes outstanding comments to the calling process's stdout as structured text. The session stays open so the agent can apply edits and you can keep commenting; close the tab when you're done.

Comments persist in `<your-file>.md.review.yaml` next to the document.

## Agent skill (Claude Code)

The repo bundles a [Claude Code skill](https://docs.claude.com/en/docs/claude-code/skills) at [`skills/review-with-mark-it/SKILL.md`](skills/review-with-mark-it/SKILL.md). When installed, Claude Code will offer to open substantial Markdown artifacts (plans, specs, PRDs, design docs) in `mark-it`, watch for **Send to agent** events on stdout, and apply each round of comments as targeted edits — looping until you close the browser tab.

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
apps/cli                       # `mark-it` binary — Vite dev server + HTTP API + file watcher
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
