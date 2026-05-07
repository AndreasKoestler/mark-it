---
name: review-with-mark-it
description: Use whenever you produce a substantial Markdown artifact (plan, spec, design doc, PRD, summary, refactor outline, code-review writeup, generated docs) that the user might want to comment on. Offers to open it in `mark-it` — a browser-based reviewer that streams structured, line-anchored comments to stdout — then applies the user's feedback as targeted revisions in a long-running review loop. Triggers when the agent is about to hand back a long Markdown deliverable for the user's review.
---

# Reviewing Markdown artifacts with mark-it

`mark-it` is a global CLI installed on this machine (`mark-it <path>`) that opens a Markdown file in a browser-based commenting UI. The user attaches line-anchored comments and clicks **Send to agent** in the toolbar (or per-thread in the sidebar). When they do, `mark-it`:

- Persists the full comment state to `<path>.review.yaml` (Sidemark v1.0 sidecar).
- Writes a structured plain-text chunk to **stdout**, wrapped in fixed delimiter lines so multiple rounds in one session can be framed:

  ```
  ===MARK-IT-SEND-BEGIN===
  Document: <relative path>
  Comment N (line L) — "<anchored text>":
    <author> — <ISO timestamp>
    > <comment body>
  ===MARK-IT-SEND-END===
  ```

- **Stays running.** The CLI does **not** exit on Send; it exits when the user closes the browser tab (5s grace window).

So `mark-it <path>` is a long-running review loop: send → agent applies edits → comments re-anchor → send more → ... → user closes tab → mark-it exits.

## When to invoke this skill

Invoke whenever you're about to hand the user a Markdown artifact substantial enough to benefit from inline review. Strong triggers:

- Implementation plans, design docs, RFCs, PRDs.
- Generated specs / architecture writeups.
- Long code-review feedback documents.
- Multi-section summaries / reports.
- Drafts longer than ~30 lines or with ≥3 distinct sections.

**Don't invoke for:**

- One-paragraph chat replies.
- Code (only Markdown is supported).
- Tiny edits or quick answers.
- Anything the user already declined for ("no review, just send it").

## Plan-mode plans (special case)

When the agent is in Claude Code plan mode and writes a plan file (e.g. `~/.claude/plans/<slug>.md`):

- **Inside plan mode**, the harness forbids running non-read-only tools, so you cannot launch `mark-it` from there. Plan-mode workflow still ends with `ExitPlanMode` (or `AskUserQuestion`) — don't try to call this skill in place of `ExitPlanMode`.
- **Before calling `ExitPlanMode`**, use `AskUserQuestion` to offer the user three options: (a) approve as-is, (b) approve with extra permissions, (c) review the plan in mark-it before exiting. Mention that picking (c) means: "I'll exit plan mode, then immediately open the plan in mark-it for line-anchored review before starting implementation."
- **After the user picks (c)** and `ExitPlanMode` resolves with approval: **don't write any implementation code yet**. Run `mark-it <plan-file-absolute-path>` per the workflow below; loop until the user closes the tab; only then continue with implementation.
- **If the user has declined** mark-it review for this conversation already, skip the option in `AskUserQuestion`.

## Workflow

### 1. Save the artifact to a Markdown file

If you've been writing the artifact to chat, write it to a real file first. Choose a path the user can keep:

- For project-scoped artifacts: `<workspace>/<sensible-name>.md` (or `notes/`, `docs/`, `plans/` if those exist).
- For ad-hoc artifacts: `/tmp/markit-<short-name>-<timestamp>.md` is fine.

State the path back to the user explicitly.

### 2. Offer the review

Ask exactly once, plainly:

> "Want to review `<path>` interactively in mark-it? I'll watch for your comments, apply them as edits, and re-run mark-it until you close the tab."

If the user says no (or has previously declined for this conversation), skip and continue with the regular flow.

### 3. Spawn mark-it in the background and stream stdout

`mark-it` is long-running. Use `Bash` with `run_in_background: true`:

```bash
mark-it <absolute-path-to-md>
```

Mark-it auto-opens the user's default browser. If the user prefers no auto-open, pass `--no-open`.

Tell the user the loop is now active and instruct them to keep adding comments and clicking Send; you'll apply each round's edits as they come in. The terminal session is yours, not theirs — no need to "return to the terminal".

### 4. Stream and frame chunks

Use `Monitor` (or `Read` against the background shell as a fallback) to watch the background process's stdout. Each Send produces a complete envelope:

```
===MARK-IT-SEND-BEGIN===
Document: <relative path>

Comment N (line L) — "<anchored text>":
  <author> — <ISO timestamp>
  > <comment body, possibly multi-line>
    ↳ <reply author> — <ISO timestamp>
      > <reply body>

===MARK-IT-SEND-END===
```

Match the delimiters as **whole lines** (start of line + literal text + newline) to avoid false positives if a comment body happens to contain `===`. Replies appear under their parent indented with `↳`. Multiple roots are separated by a blank line.

Ignore everything outside the BEGIN/END pair — Vite logs and the "mark-it: serving …" line live there too.

### 5. Apply the comments and loop

For each envelope:

- **Suggestion / issue / clarification request** → edit the artifact at the referenced `line`, then move on.
- **Question** → answer in the artifact body, OR add a reply via the `/api/sidecar` endpoint (rare; usually editing is the right answer).
- **Style / wording** → edit the affected block.
- **Out-of-scope** → mention briefly that you've left this comment unaddressed and why.

Each comment carries `selected_text` of the original block — the **immutable anchor**. Treat it as a pointer to the right block; don't preserve that exact wording in the rewrite. After you edit the file, mark-it's chokidar watcher re-anchors the comment automatically — the user sees a "drifted" badge in the sidebar.

Briefly summarize what you applied in chat (so the user sees progress without checking the file) — then keep watching. Multiple rounds happen in the same session.

### 6. End of session

Detect end via process exit (Monitor signals "done" or the background Bash returns). That's the user closing the tab. Summarize across all rounds: "Applied N comments across M Send rounds. Ready for next steps." Then continue with whatever the original task was (e.g., implementation after a plan review).

## Important behaviors

- **mark-it is long-running.** Send does NOT exit. Closing the tab does (5s grace window).
- **The sidecar `<path>.review.yaml`** keeps the comment history — don't delete it. The user may reopen mark-it on the same file later and expect resolved threads to be remembered.
- **Sidemark is content-anchored.** Edits you make trigger an automatic re-anchor; comments track the new text via `anchored_text`. Never hand-edit `selected_text` or `selected_text_hash` in the sidecar.
- **`Send and resolve`** flips comments to `resolved: true` atomically with the send. **`Send`** alone leaves them open (so the user can keep them visible while iterating).
- **Auto-decline budget.** If the user declined a mark-it review earlier in the same conversation, skip the offer for the rest of the conversation unless they explicitly ask for it.
- **Process killed before tab close.** If the agent process is killed before the user closes the tab, the tab will silently retry the SSE connection forever. Acceptable for v1.

## Decline pattern

Some users always prefer chat-based feedback. After a single "no" in a conversation, save it as a feedback memory only if it seems durable ("I never want this", "stop offering this"). Don't save it for one-off declines.

## Anti-patterns

- **Don't** invoke for chat replies, code outputs, or tiny notes.
- **Don't** run mark-it on a file that doesn't exist on disk.
- **Don't** invoke `mark-it` in the foreground (it would block the agent for the whole session).
- **Don't** treat the first envelope as "the answer" — more rounds may come.
- **Don't** match the BEGIN/END delimiters as substrings; require whole-line match.
- **Don't** apply changes from comments inside the blockquote section's `selected_text` — that's just the anchor, not the user's instruction. Read the body (`> ...`) for the actual ask.
