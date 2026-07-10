import { useEffect, useMemo, useRef, useState } from "react";
import {
  formatForAgent,
  isOrphanedAnchor,
  anchoredTextIsLive,
  MRSF_HIGH_THRESHOLD,
  PERFECT_SCORE,
  type AgentPayload,
  type Comment,
} from "@mark-it/core";
import { useMarkIt, useMarkItState, useStoreActions } from "./MarkItProvider.js";

interface AddEventDetail {
  line: number | null;
  end_line?: number | null;
  selectionText?: string | null;
}

interface ThreadGroup {
  root: Comment;
  replies: Comment[];
}

function groupThreads(comments: Comment[]): ThreadGroup[] {
  const repliesByParent = new Map<string, Comment[]>();
  for (const c of comments) {
    if (c.reply_to) {
      const list = repliesByParent.get(c.reply_to) ?? [];
      list.push(c);
      repliesByParent.set(c.reply_to, list);
    }
  }
  return comments
    .filter((c) => !c.reply_to)
    .map((root) => ({
      root,
      replies: (repliesByParent.get(root.id) ?? []).sort((a, b) =>
        a.timestamp.localeCompare(b.timestamp),
      ),
    }));
}

export function CommentSidebar() {
  const { author } = useMarkIt();
  const { doc, draft, editingId } = useMarkItState();
  const actions = useStoreActions();

  useEffect(() => {
    function onAdd(e: Event) {
      const detail = (e as CustomEvent<AddEventDetail>).detail ?? null;
      if (!detail || detail.line == null) return;
      actions.openDraft({
        line: detail.line,
        end_line: detail.end_line ?? undefined,
        selected_text: detail.selectionText ?? undefined,
      });
    }
    document.addEventListener("mrsf:add", onAdd);
    return () => document.removeEventListener("mrsf:add", onAdd);
  }, [actions]);

  const threads = useMemo(() => {
    const all = doc.comments ?? [];
    const open = all.filter((c) => !c.resolved || c.reply_to);
    return groupThreads(open).filter((t) => !t.root.resolved);
  }, [doc.comments]);

  return (
    <aside className="mi-sidebar" data-testid="comment-sidebar">
      {draft && (
        <DraftCard
          line={draft.line}
          author={author}
          onSubmit={(text) => actions.submitDraft(text)}
          onCancel={() => actions.closeDraft()}
        />
      )}

      <ul className="mi-thread-list">
        {threads.map((thread) => (
          <ThreadCard
            key={thread.root.id}
            thread={thread}
            author={author}
            editingId={editingId}
            onResolve={() => actions.resolve(thread.root.id)}
            onReply={(text) => actions.reply(thread.root.id, text)}
            onEditSubmit={(id, text) => actions.editComment(id, text)}
            onEditCancel={() => actions.cancelEdit()}
          />
        ))}
      </ul>
    </aside>
  );
}

interface ThreadCardProps {
  thread: ThreadGroup;
  author: string;
  editingId: string | null;
  onResolve(): void;
  onReply(text: string): void;
  onEditSubmit(id: string, text: string): void;
  onEditCancel(): void;
}

function ThreadCard({
  thread,
  author,
  editingId,
  onResolve,
  onReply,
  onEditSubmit,
  onEditCancel,
}: ThreadCardProps) {
  const { transports, documentName, source } = useMarkIt();
  const actions = useStoreActions();
  const [replyText, setReplyText] = useState("");
  const trimmed = replyText.trim();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const cardRef = useRef<HTMLLIElement | null>(null);

  const submitReply = () => {
    if (!trimmed) return;
    onReply(trimmed);
    setReplyText("");
  };

  const sendTransport = transports[0];

  const threadComments = [thread.root, ...thread.replies];
  const threadIds = threadComments.map((c) => c.id);

  const buildPayload = (resolveAfter: boolean): AgentPayload => ({
    document: { path: documentName, content: source },
    comments: threadComments,
    intent: "single",
    resolveIds: resolveAfter ? threadIds : [],
  });

  const copyPlain = async () => {
    const all = threadComments.map((c) => c.text).join("\n\n");
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      await navigator.clipboard.writeText(all);
    }
  };

  const copyForAgent = async () => {
    const text = formatForAgent(buildPayload(false));
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
    }
  };

  const sendToAgent = async (resolveAfter: boolean) => {
    if (!sendTransport) return;
    await sendTransport.send(buildPayload(resolveAfter));
  };

  const onDeleteThread = () => actions.deleteComment(thread.root.id, { cascade: true });

  useEffect(() => {
    const ids = new Set<string>([
      thread.root.id,
      ...thread.replies.map((r) => r.id),
    ]);
    function onReplyFocus(e: Event) {
      const detail = (e as CustomEvent<{ commentId: string }>).detail;
      if (!detail?.commentId) return;
      if (detail.commentId !== thread.root.id) return;
      cardRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      requestAnimationFrame(() => inputRef.current?.focus());
    }
    function onEditFocus(e: Event) {
      const detail = (e as CustomEvent<{ commentId: string }>).detail;
      if (!detail?.commentId || !ids.has(detail.commentId)) return;
      cardRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    document.addEventListener("markit:reply-focus", onReplyFocus);
    document.addEventListener("markit:edit-focus", onEditFocus);
    return () => {
      document.removeEventListener("markit:reply-focus", onReplyFocus);
      document.removeEventListener("markit:edit-focus", onEditFocus);
    };
  }, [thread.root.id, thread.replies]);

  return (
    <li
      ref={cardRef}
      className="mi-thread"
      data-testid="thread"
      data-comment-id={thread.root.id}
      data-line={thread.root.line ?? ""}
    >
      {editingId === thread.root.id ? (
        <EditForm
          comment={thread.root}
          onSubmit={(text) => onEditSubmit(thread.root.id, text)}
          onCancel={onEditCancel}
        />
      ) : (
        <CommentBody comment={thread.root}>
          <button
            type="button"
            className="mi-thread-resolve"
            aria-label="Resolve"
            title="Resolve"
            data-testid="thread-resolve"
            onClick={onResolve}
          >
            ✓
          </button>
          <ThreadMenu
            disabled={!sendTransport}
            onCopy={copyPlain}
            onCopyForAgent={copyForAgent}
            onSendToAgent={() => sendToAgent(false)}
            onSendToAgentAndResolve={() => sendToAgent(true)}
            onDelete={onDeleteThread}
          />
        </CommentBody>
      )}

      {thread.replies.map((r) => (
        <div
          key={r.id}
          className="mi-thread-reply"
          data-testid="thread-reply"
          data-comment-id={r.id}
        >
          {editingId === r.id ? (
            <EditForm
              comment={r}
              onSubmit={(text) => onEditSubmit(r.id, text)}
              onCancel={onEditCancel}
            />
          ) : (
            <CommentBody comment={r}>
              <ReplyMenu
                onEdit={() => actions.startEdit(r.id)}
                onDelete={() => actions.deleteComment(r.id)}
              />
            </CommentBody>
          )}
        </div>
      ))}

      <form
        className="mi-reply-form"
        data-testid="thread-reply-form"
        onSubmit={(e) => {
          e.preventDefault();
          submitReply();
        }}
      >
        <input
          ref={inputRef}
          type="text"
          className="mi-reply-input"
          data-testid="thread-reply-input"
          placeholder={`Reply as ${author.split(" (")[0]}…`}
          value={replyText}
          onChange={(e) => setReplyText(e.target.value)}
        />
        <button
          type="submit"
          className="mi-reply-submit"
          data-testid="thread-reply-submit"
          disabled={!trimmed}
        >
          ↵
        </button>
      </form>
    </li>
  );
}

interface CommentBodyProps {
  comment: Comment;
  children?: React.ReactNode;
}

function CommentBody({ comment, children }: CommentBodyProps) {
  const { source } = useMarkIt();
  const drift = driftInfo(comment, source);
  return (
    <>
      <header className="mi-thread-header">
        <Avatar author={comment.author} />
        <span className="mi-thread-author">{authorName(comment.author)}</span>
        <span className="mi-thread-time" title={comment.timestamp}>
          {relativeTime(comment.timestamp)}
        </span>
        {comment.line ? (
          <span className="mi-thread-line">line {comment.line}</span>
        ) : null}
        {drift.badge && (
          <span
            className={`mi-thread-drift mi-thread-drift-${drift.kind}`}
            data-testid="thread-drift-badge"
            title={drift.title}
          >
            {drift.badge}
          </span>
        )}
        <span className="mi-thread-actions">{children}</span>
      </header>
      <p className="mi-thread-text">{comment.text}</p>
      {comment.selected_text && !comment.reply_to && (
        <blockquote className="mi-thread-anchor">
          {comment.selected_text}
        </blockquote>
      )}
      {drift.anchoredText && !comment.reply_to && (
        <blockquote
          className="mi-thread-anchor mi-thread-anchor-now"
          data-testid="thread-anchor-now"
        >
          <span className="mi-thread-anchor-label">now anchors to:</span>{" "}
          {drift.anchoredText}
        </blockquote>
      )}
    </>
  );
}

interface DriftInfo {
  kind: "drifted" | "orphaned" | null;
  badge: string | null;
  title: string;
  anchoredText: string | null;
}

function driftInfo(comment: Comment, source: string): DriftInfo {
  // Trust MRSF's score over its status. `status` describes the *strategy*
  // used (exact / shifted / fuzzy / orphaned), `score` describes the *quality*
  // of the match. A "fuzzy" status with score 1.0 is a perfect match — not
  // drift — even though it didn't go through the exact-match path.
  const ext = comment as Comment & {
    x_reanchor_status?: string;
    x_reanchor_score?: number;
    anchored_text?: string;
  };
  const status = ext.x_reanchor_status;
  const score = ext.x_reanchor_score;
  const anchoredText =
    ext.anchored_text && ext.anchored_text !== comment.selected_text
      ? ext.anchored_text
      : null;

  // MRSF's "line/column fallback" returns status="anchored" even when the
  // selected_text is gone (so x_reanchor_status never gets written). Detect
  // that ourselves. Replies have no selected_text and don't anchor.
  const looksOrphaned =
    !comment.reply_to &&
    !!comment.selected_text &&
    isOrphanedAnchor(comment, source);

  // A low score only means "anchor lost" if there's no live anchor to show —
  // otherwise the render path (commentsForRender) projects a confident
  // highlight at anchored_text, and this badge would contradict it.
  const lowScore =
    score != null && score < MRSF_HIGH_THRESHOLD && !anchoredTextIsLive(comment, source);
  if (status === "orphaned" || looksOrphaned || lowScore) {
    // If MRSF still gave us a best-effort anchor, surface it. The badge says
    // "anchor lost" (low confidence), the "now anchors to" block shows MRSF's
    // closest match — those are orthogonal pieces of information.
    return {
      kind: "orphaned",
      badge: "anchor lost",
      title:
        "The comment's original text is no longer in the document; the highlight points at the recorded line.",
      anchoredText,
    };
  }

  // Perfect-content matches (score ≥ PERFECT_SCORE) are not drift even when
  // anchored_text differs from selected_text — that just means MRSF's source-
  // text view picked up formatting markers (`**`, list bullets) the rendered
  // DOM doesn't carry.
  const meaningfulDrift =
    score != null && score < PERFECT_SCORE && anchoredText != null;
  if (meaningfulDrift) {
    return {
      kind: "drifted",
      badge: "drifted",
      title: `Anchor moved (${status ?? "drifted"}, score ${score!.toFixed(2)}). The original text was edited; the comment now points at the closest match.`,
      anchoredText,
    };
  }

  return { kind: null, badge: null, title: "", anchoredText: null };
}

function authorName(raw: string): string {
  const m = /^(.*?)\s*\(/.exec(raw);
  return (m?.[1] ?? raw).trim();
}

function Avatar({ author }: { author: string }) {
  const initials = useMemo(() => {
    const name = authorName(author);
    return (
      name
        .split(/\s+/)
        .map((p) => p[0])
        .filter(Boolean)
        .slice(0, 2)
        .join("")
        .toUpperCase() || "?"
    );
  }, [author]);
  return <span className="mi-avatar" aria-hidden="true">{initials}</span>;
}

function relativeTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const diff = Date.now() - t;
  const sec = Math.round(diff / 1000);
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(t).toLocaleDateString();
}

interface ThreadMenuProps {
  disabled: boolean;
  onCopy(): void;
  onCopyForAgent(): void;
  onSendToAgent(): void;
  onSendToAgentAndResolve(): void;
  onDelete(): void;
}

function ThreadMenu({
  disabled,
  onCopy,
  onCopyForAgent,
  onSendToAgent,
  onSendToAgentAndResolve,
  onDelete,
}: ThreadMenuProps) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!wrapperRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, [open]);

  const close = () => setOpen(false);

  return (
    <div className="mi-agent-menu" ref={wrapperRef}>
      <button
        type="button"
        className="mi-thread-menu-toggle"
        aria-label="Comment actions"
        data-testid="thread-menu-toggle"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        ⋯
      </button>
      {open && (
        <div className="mi-agent-menu-popover" role="menu" data-testid="thread-menu-items">
          <button
            type="button"
            role="menuitem"
            className="mi-agent-menu-item"
            data-testid="thread-copy"
            onClick={() => { onCopy(); close(); }}
          >
            Copy
          </button>
          <button
            type="button"
            role="menuitem"
            className="mi-agent-menu-item"
            data-testid="thread-copy-for-agent"
            onClick={() => { onCopyForAgent(); close(); }}
          >
            Copy for Agent
          </button>
          <div className="mi-agent-menu-sep" role="separator" />
          <button
            type="button"
            role="menuitem"
            className="mi-agent-menu-item"
            data-testid="thread-send"
            disabled={disabled}
            onClick={() => { onSendToAgent(); close(); }}
          >
            Send comment to agent
          </button>
          <button
            type="button"
            role="menuitem"
            className="mi-agent-menu-item"
            data-testid="thread-send-resolve"
            disabled={disabled}
            onClick={() => { onSendToAgentAndResolve(); close(); }}
          >
            Send comment to agent and resolve
          </button>
          <div className="mi-agent-menu-sep" role="separator" />
          <button
            type="button"
            role="menuitem"
            className="mi-agent-menu-item mi-agent-menu-danger"
            data-testid="thread-delete"
            onClick={() => { onDelete(); close(); }}
          >
            Delete
          </button>
        </div>
      )}
    </div>
  );
}

interface DraftCardProps {
  line: number;
  author: string;
  onSubmit(text: string): void;
  onCancel(): void;
}

interface ReplyMenuProps {
  onEdit(): void;
  onDelete(): void;
}

function ReplyMenu({ onEdit, onDelete }: ReplyMenuProps) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!wrapperRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, [open]);

  const close = () => setOpen(false);

  return (
    <div className="mi-agent-menu" ref={wrapperRef}>
      <button
        type="button"
        className="mi-thread-menu-toggle"
        aria-label="Reply actions"
        data-testid="reply-menu-toggle"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        ⋯
      </button>
      {open && (
        <div className="mi-agent-menu-popover" role="menu" data-testid="reply-menu-items">
          <button
            type="button"
            role="menuitem"
            className="mi-agent-menu-item"
            data-testid="reply-edit"
            onClick={() => { onEdit(); close(); }}
          >
            Edit
          </button>
          <div className="mi-agent-menu-sep" role="separator" />
          <button
            type="button"
            role="menuitem"
            className="mi-agent-menu-item mi-agent-menu-danger"
            data-testid="reply-delete"
            onClick={() => { onDelete(); close(); }}
          >
            Delete
          </button>
        </div>
      )}
    </div>
  );
}

interface EditFormProps {
  comment: Comment;
  onSubmit(text: string): void;
  onCancel(): void;
}

function EditForm({ comment, onSubmit, onCancel }: EditFormProps) {
  const [text, setText] = useState(comment.text);
  const trimmed = text.trim();
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    requestAnimationFrame(() => {
      taRef.current?.focus();
      taRef.current?.select();
    });
  }, []);

  return (
    <form
      className="mi-edit"
      data-testid="edit-form"
      data-comment-id={comment.id}
      onSubmit={(e) => {
        e.preventDefault();
        if (!trimmed || trimmed === comment.text) {
          onCancel();
          return;
        }
        onSubmit(trimmed);
      }}
    >
      <header className="mi-thread-header">
        <strong>{comment.author}</strong>
        {comment.line ? (
          <span className="mi-thread-line">line {comment.line}</span>
        ) : null}
      </header>
      <textarea
        ref={taRef}
        className="mi-edit-input mi-draft-input"
        data-testid="edit-input"
        rows={3}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
      />
      <div className="mi-edit-actions">
        <button
          type="button"
          className="mi-edit-cancel"
          data-testid="edit-cancel"
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          type="submit"
          className="mi-draft-submit"
          data-testid="edit-submit"
          disabled={!trimmed || trimmed === comment.text}
        >
          Save
        </button>
      </div>
    </form>
  );
}

function DraftCard({ line, author, onSubmit, onCancel }: DraftCardProps) {
  const [text, setText] = useState("");
  const trimmed = text.trim();
  return (
    <form
      className="mi-draft"
      data-testid="comment-draft"
      data-draft-line={line}
      onSubmit={(e) => {
        e.preventDefault();
        if (!trimmed) return;
        onSubmit(trimmed);
      }}
    >
      <header className="mi-thread-header">
        <strong>{author}</strong>
        <button
          type="button"
          className="mi-draft-close"
          aria-label="Cancel"
          onClick={onCancel}
          data-testid="comment-draft-cancel"
        >
          ×
        </button>
      </header>
      <textarea
        className="mi-draft-input"
        data-testid="comment-draft-input"
        placeholder="Add comment…"
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
      />
      <button
        type="submit"
        className="mi-draft-submit"
        data-testid="comment-draft-submit"
        disabled={!trimmed}
      >
        Send
      </button>
    </form>
  );
}
