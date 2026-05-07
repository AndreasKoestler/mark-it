---
name: review-with-mark-it
description: Use whenever you produce a substantial Markdown artifact (plan, spec, design doc, PRD, summary, refactor outline, code-review writeup, generated docs) that the user might want to comment on. Offers to open it in `mark-it` — a browser-based reviewer that streams structured, line-anchored comments as JSONL — then applies the user's feedback as targeted revisions in a long-running review loop. Triggers when the agent is about to hand back a long Markdown deliverable for the user's review.
---

# Reviewing Markdown artifacts with mark-it

`mark-it` is a global CLI installed on this machine. Two subcommands matter for this skill:

- `mark-it <path>` — registers the file with the long-lived **mark-it daemon** (auto-spawned on first use), focuses the open tab if any, and **exits in <1s**. Auto-opens the browser unless the doc is already open.
- `mark-it tail <path>` — connects to the daemon's per-doc Server-Sent Events stream and **prints one JSON object per Send round** to stdout, then exits when the user closes the tab.

When the user clicks **Send to agent** in the toolbar (or per-thread in the sidebar), `mark-it`:

- Persists the full comment state to `<path>.review.yaml` (Sidemark v1.0 sidecar).
- Broadcasts a structured `send` event on the per-doc SSE channel. `mark-it tail` surfaces it as a single JSONL line:

  ```json
  {"docId":"legacy-…","text":"Document: <relative path>\n\nComment 1 (line L) — \"<anchored text>\":\n  <author> — <ISO timestamp>\n  > <comment body>\n","comments":[{"id":"…","line":17,"text":"…","author":"…",…}],"resolveIds":[…]}
  ```

  The `comments` array is the structured payload (each comment object includes `id`, `line`, `selected_text`, `text`, `author`, replies, etc.). `text` is the same human-readable rendering, kept for cheap display. `resolveIds` lists the comment IDs the user resolved as part of this Send.

- The daemon **stays running**; tab close → daemon idle-exits after a grace window. `mark-it tail` exits 0 when the daemon signals `done`.

So the loop for this skill is: `mark-it <path>` → `mark-it tail <path>` (background) → read one JSONL line per Send → apply edits → repeat → tail exits when tab closes.

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
- **After the user picks (c)** and `ExitPlanMode` resolves with approval: **don't write any implementation code yet**. Run the workflow below; loop until `mark-it tail` exits; only then continue with implementation.
- **If the user has declined** mark-it review for this conversation already, skip the option in `AskUserQuestion`.

## Workflow

### 1. Save the artifact to a Markdown file

If you've been writing the artifact to chat, write it to a real file first. Choose a path the user can keep:

- For project-scoped artifacts: `<workspace>/<sensible-name>.md` (or `notes/`, `docs/`, `plans/` if those exist).
- For ad-hoc artifacts: `/tmp/markit-<short-name>-<timestamp>.md` is fine.

State the path back to the user explicitly.

### 2. Offer the review

Ask exactly once, plainly:

> "Want to review `<path>` interactively in mark-it? I'll watch for your comments, apply them as edits, and keep going until you close the tab."

If the user says no (or has previously declined for this conversation), skip and continue with the regular flow.

### 3. Register the doc, then start the tail subscriber

`mark-it <path>` registers and exits, printing the docId on stdout. `mark-it tail` is the long-running consumer; pass the docId so the lookup is exact in both legacy and DB modes:

```bash
# Foreground — completes in <1s. Spawns the daemon if needed, opens the
# browser, and prints the docId on stdout.
DOC_ID=$(mark-it <absolute-path-to-md>)

# Background — streams JSONL on stdout for the lifetime of the doc.
mark-it tail --doc-id "$DOC_ID"
```

Use `Bash` with `run_in_background: true` for the second call. If the user prefers no auto-open, pass `--no-open` to the first call. (For legacy-mode-only flows, `mark-it tail <path>` derives the docId from the path; the explicit `--doc-id` form is the recommended default.)

Tell the user the loop is now active and instruct them to keep adding comments and clicking Send; you'll apply each round's edits as they come in. The terminal session is yours, not theirs — no need to "return to the terminal".

### 4. Read JSONL and apply

Use `Monitor` against the background `mark-it tail` shell. Each line is one Send round, a complete JSON envelope:

```json
{
  "docId": "legacy-…",
  "text": "Document: <relative path>\n\nComment 1 (line L) — \"<anchored text>\":\n  <author> — <ISO timestamp>\n  > <comment body>\n",
  "comments": [
    {
      "id": "…",
      "line": 17,
      "end_line": 17,
      "selected_text": "<anchor>",
      "text": "<comment body>",
      "author": "…",
      "timestamp": "…",
      "replies": [{ "author": "…", "text": "…", "timestamp": "…" }]
    }
  ],
  "resolveIds": ["…"]
}
```

Parse one line at a time (`JSON.parse(line)`). Prefer `comments[i].line` and `comments[i].text` over the rendered `text` blob — the structured fields are exact. The `text` blob is fine for showing the user a human-friendly summary in chat.

### 5. Apply the comments and loop

For each comment in the envelope:

- **Suggestion / issue / clarification request** → edit the artifact at the referenced `line`, then move on.
- **Question** → answer in the artifact body, OR add a reply via the `/api/sidecar` endpoint (rare; usually editing is the right answer).
- **Style / wording** → edit the affected block.
- **Out-of-scope** → mention briefly that you've left this comment unaddressed and why.

Each comment carries `selected_text` of the original block — the **immutable anchor**. Treat it as a pointer to the right block; don't preserve that exact wording in the rewrite. After you edit the file, mark-it re-anchors the comment automatically — the user sees a "drifted" badge in the sidebar.

Briefly summarize what you applied in chat (so the user sees progress without checking the file) — then keep watching. Multiple rounds happen in the same session.

### 6. End of session

Detect end via `mark-it tail` exit (Monitor signals "done" or the background Bash returns 0). That's the user closing the tab. Summarize across all rounds: "Applied N comments across M Send rounds. Ready for next steps." Then continue with whatever the original task was (e.g., implementation after a plan review).

## Important behaviors

- **`mark-it <path>` exits immediately.** It's a thin client of the long-lived daemon. The daemon idle-exits when no docs are registered and no tabs are open for ~10 min.
- **`mark-it tail <path>` is the long-running half.** It exits when the user closes the tab.
- **The sidecar `<path>.review.yaml`** keeps the comment history — don't delete it. The user may reopen mark-it on the same file later and expect resolved threads to be remembered.
- **Sidemark is content-anchored.** Edits you make trigger an automatic re-anchor; comments track the new text via `anchored_text`. Never hand-edit `selected_text` or `selected_text_hash` in the sidecar.
- **`Send and resolve`** flips comments to `resolved: true` atomically with the send. **`Send`** alone leaves them open (so the user can keep them visible while iterating).
- **Replay on reconnect.** `mark-it tail` reconnects automatically with `Last-Event-ID`; brief network/agent restarts don't lose events (best-effort, last 100 events per doc).
- **Auto-decline budget.** If the user declined a mark-it review earlier in the same conversation, skip the offer for the rest of the conversation unless they explicitly ask for it.

## Decline pattern

Some users always prefer chat-based feedback. After a single "no" in a conversation, save it as a feedback memory only if it seems durable ("I never want this", "stop offering this"). Don't save it for one-off declines.

## Anti-patterns

- **Don't** invoke for chat replies, code outputs, or tiny notes.
- **Don't** run mark-it on a file that doesn't exist on disk.
- **Don't** invoke `mark-it tail` in the foreground (it would block the agent for the whole session). The first `mark-it <path>` call is foreground and exits in <1s — that one is fine.
- **Don't** treat the first JSONL line as "the answer" — more Sends usually come.
- **Don't** parse the rendered `text` blob with regex when the structured `comments[]` array is right there. Reach for `text` only for human-friendly chat summaries.
- **Don't** apply changes from `comments[i].selected_text` — that's just the anchor, not the user's instruction. Read `comments[i].text` (the body) for the actual ask, and any nested `replies[]`.
