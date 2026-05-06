import { useEffect, useMemo, useRef, useState } from "react";
import {
  formatForAgent,
  type AgentPayload,
  type Comment,
} from "@mark-it/core";
import { useMarkIt, useMarkItState, useStoreActions } from "./MarkItProvider.js";
import { ViewToggle } from "./ViewToggle.js";

export function Toolbar() {
  const { source, documentName, transports } = useMarkIt();
  const { doc } = useMarkItState();
  const actions = useStoreActions();

  const unresolved = useMemo(
    () => doc.comments.filter((c) => !c.resolved),
    [doc.comments],
  );
  const unresolvedRoots = useMemo(
    () => unresolved.filter((c) => !c.reply_to),
    [unresolved],
  );

  const sendTransport = transports[0];
  const [busy, setBusy] = useState(false);

  const send = async (subset: Comment[], opts: { resolveAfter?: boolean; intent: AgentPayload["intent"] }) => {
    if (!sendTransport || subset.length === 0) return;
    setBusy(true);
    try {
      await sendTransport.send({
        document: { path: documentName, content: source },
        comments: subset,
        intent: opts.intent,
      });
      if (opts.resolveAfter) {
        await actions.resolveAll();
      }
    } finally {
      setBusy(false);
    }
  };

  const copyContents = async () => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      await navigator.clipboard.writeText(source);
    }
  };

  return (
    <header className="mi-toolbar" data-testid="toolbar">
      <strong className="mi-toolbar-title" data-testid="doc-name">
        {documentName}
      </strong>
      <ViewToggle />
      <div className="mi-toolbar-spacer" />
      <button
        type="button"
        className="mi-toolbar-btn"
        data-testid="toolbar-copy-contents"
        onClick={copyContents}
        title="Copy contents"
      >
        ⧉
      </button>
      <AgentMenu
        disabled={busy || !sendTransport}
        unresolvedCount={unresolvedRoots.length}
        onCopyOne={() => send(firstThread(unresolved), { intent: "single" })}
        onSendAll={() => send(unresolved, { intent: "all" })}
        onSendAllAndResolve={() => send(unresolved, { intent: "all", resolveAfter: true })}
        onResolveAll={() => actions.resolveAll()}
      />
    </header>
  );
}

function firstThread(unresolved: Comment[]): Comment[] {
  const root = unresolved.find((c) => !c.reply_to);
  if (!root) return [];
  const replies = unresolved.filter((c) => c.reply_to === root.id);
  return [root, ...replies];
}

interface AgentMenuProps {
  disabled: boolean;
  unresolvedCount: number;
  onCopyOne(): void;
  onSendAll(): void;
  onSendAllAndResolve(): void;
  onResolveAll(): void;
}

function AgentMenu({
  disabled,
  unresolvedCount,
  onCopyOne,
  onSendAll,
  onSendAllAndResolve,
  onResolveAll,
}: AgentMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, [open]);

  const close = () => setOpen(false);

  return (
    <div className="mi-agent-menu" data-testid="agent-menu" ref={ref}>
      <button
        type="button"
        className="mi-toolbar-btn"
        data-testid="agent-menu-toggle"
        title="Agent actions"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        ⋯
      </button>
      {open && (
        <div className="mi-agent-menu-popover" role="menu" data-testid="agent-menu-items">
          <button
            type="button"
            role="menuitem"
            className="mi-agent-menu-item"
            data-testid="agent-copy-one"
            disabled={disabled || unresolvedCount === 0}
            onClick={() => {
              onCopyOne();
              close();
            }}
          >
            Copy 1 comment for Agent
          </button>
          <button
            type="button"
            role="menuitem"
            className="mi-agent-menu-item"
            data-testid="agent-send-all"
            disabled={disabled || unresolvedCount === 0}
            onClick={() => {
              onSendAll();
              close();
            }}
          >
            Send all comments to agent
          </button>
          <button
            type="button"
            role="menuitem"
            className="mi-agent-menu-item"
            data-testid="agent-send-all-resolve"
            disabled={disabled || unresolvedCount === 0}
            onClick={() => {
              onSendAllAndResolve();
              close();
            }}
          >
            Send all comments to agent and resolve
          </button>
          <button
            type="button"
            role="menuitem"
            className="mi-agent-menu-item"
            data-testid="agent-resolve-all"
            disabled={disabled || unresolvedCount === 0}
            onClick={() => {
              onResolveAll();
              close();
            }}
          >
            Resolve all comments
          </button>
        </div>
      )}
    </div>
  );
}

// Re-export so consumers can format payloads themselves if they want.
export { formatForAgent };
