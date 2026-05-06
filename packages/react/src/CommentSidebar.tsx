import { useEffect, useMemo, useState } from "react";
import type { Comment } from "@mark-it/core";
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
  const { doc, draft } = useMarkItState();
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
    const open = doc.comments.filter((c) => !c.resolved || c.reply_to);
    return groupThreads(open).filter((t) => !t.root.resolved);
  }, [doc.comments]);

  return (
    <aside className="mi-sidebar" data-testid="comment-sidebar">
      <header className="mi-sidebar-header">
        <span>Comments</span>
        <span className="mi-sidebar-count" data-testid="comments-count">
          {threads.length}
        </span>
      </header>

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
            onResolve={() => actions.resolve(thread.root.id)}
            onReply={(text) => actions.reply(thread.root.id, text)}
          />
        ))}
      </ul>
    </aside>
  );
}

interface ThreadCardProps {
  thread: ThreadGroup;
  author: string;
  onResolve(): void;
  onReply(text: string): void;
}

function ThreadCard({ thread, author, onResolve, onReply }: ThreadCardProps) {
  const [replyText, setReplyText] = useState("");
  const trimmed = replyText.trim();
  const submitReply = () => {
    if (!trimmed) return;
    onReply(trimmed);
    setReplyText("");
  };

  return (
    <li
      className="mi-thread"
      data-testid="thread"
      data-comment-id={thread.root.id}
      data-line={thread.root.line ?? ""}
    >
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
      </CommentBody>

      {thread.replies.map((r) => (
        <div
          key={r.id}
          className="mi-thread-reply"
          data-testid="thread-reply"
          data-comment-id={r.id}
        >
          <CommentBody comment={r} />
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
  return (
    <>
      <header className="mi-thread-header">
        <strong>{comment.author}</strong>
        <span className="mi-thread-line">
          {comment.line ? `line ${comment.line}` : ""}
        </span>
        {children}
      </header>
      <p className="mi-thread-text">{comment.text}</p>
      {comment.selected_text && !comment.reply_to && (
        <blockquote className="mi-thread-anchor">
          {comment.selected_text}
        </blockquote>
      )}
    </>
  );
}

interface DraftCardProps {
  line: number;
  author: string;
  onSubmit(text: string): void;
  onCancel(): void;
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
