import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  createMarkItStore,
  setDoc,
  openDraft,
  closeDraft,
  openEdit,
  closeEdit,
  type AgentTransport,
  type DraftAnchor,
  type MarkItState,
  type MrsfDocument,
  type Store,
} from "@mark-it/core";

export type ViewMode = "rendered" | "raw";

export interface CommentAddInput {
  text: string;
  author: string;
  line: number;
  end_line?: number;
  selected_text?: string;
  x_user_id?: string;
}

export interface CommentReplyInput {
  parentId: string;
  text: string;
  author: string;
  x_user_id?: string;
}

export interface CommentEditInput {
  commentId: string;
  text: string;
  actor?: string;
  x_user_id?: string;
}

export interface DeleteOptions {
  /** When true, also remove direct replies. Default: false (replies are promoted per Sidemark spec). */
  cascade?: boolean;
}

export interface CommentApi {
  /** Persist a new top-level comment. Returns the updated MrsfDocument. */
  add(input: CommentAddInput): Promise<MrsfDocument>;
  reply(input: CommentReplyInput): Promise<MrsfDocument>;
  edit(input: CommentEditInput): Promise<MrsfDocument>;
  resolve(commentId: string): Promise<MrsfDocument>;
  unresolve(commentId: string): Promise<MrsfDocument>;
  delete(commentId: string, opts?: DeleteOptions): Promise<MrsfDocument>;
  resolveAll(): Promise<MrsfDocument>;
}

export interface MarkItContextValue {
  source: string;
  documentPath: string;
  documentName: string;
  author: string;
  userId: string | null;
  viewMode: ViewMode;
  setViewMode: (mode: ViewMode) => void;
  store: Store<MarkItState>;
  commentApi: CommentApi;
  transports: ReadonlyArray<AgentTransport>;
}

const Ctx = createContext<MarkItContextValue | null>(null);

export interface MarkItProviderProps {
  source: string;
  documentPath: string;
  documentName?: string;
  author: string;
  userId?: string | null;
  /** Controlled MrsfDocument: external updates (e.g. SSE) flow into the store. */
  doc: MrsfDocument;
  initialViewMode?: ViewMode;
  /**
   * Called when the comment store wants to persist a mutation.
   * Implementations submit to the host (e.g. CLI server) and return the new doc.
   */
  commentApi: CommentApi;
  /** Transports available for the agent menu. The first one is the default "send" target. */
  transports?: ReadonlyArray<AgentTransport>;
  children: ReactNode;
}

export function MarkItProvider({
  source,
  documentPath,
  documentName,
  author,
  userId = null,
  doc,
  initialViewMode = "rendered",
  commentApi,
  transports = [],
  children,
}: MarkItProviderProps) {
  const [store] = useState(() => createMarkItStore(doc));
  const [viewMode, setViewMode] = useState<ViewMode>(initialViewMode);
  const [sent, setSent] = useState(false);

  useEffect(() => {
    (window as unknown as { mrsfDisableBuiltinUi?: boolean }).mrsfDisableBuiltinUi = true;
  }, []);

  // Sync external doc updates (e.g. SSE-driven re-anchoring) into the store.
  useEffect(() => {
    if (store.getState().doc !== doc) {
      store.setState((s) => setDoc(s, doc));
    }
  }, [doc, store]);

  // Wrap each transport so a successful .send() raises the post-send overlay.
  // The HttpAgentTransport against /api/agent will exit the server moments
  // after this resolves, so the overlay is the user's only confirmation.
  const wrappedTransports = useMemo(
    () =>
      transports.map<AgentTransport>((t) => ({
        name: t.name,
        async send(payload) {
          await t.send(payload);
          setSent(true);
        },
      })),
    [transports],
  );

  // When the active document changes, drop transient UI state (draft / edit) so
  // the new doc doesn't inherit a stale draft anchor or editing target.
  useEffect(() => {
    store.setState((s) => closeEdit(closeDraft(s)));
  }, [documentPath, store]);

  const value = useMemo<MarkItContextValue>(
    () => ({
      source,
      documentPath,
      documentName: documentName ?? documentPath,
      author,
      userId,
      viewMode,
      setViewMode,
      store,
      commentApi,
      transports: wrappedTransports,
    }),
    [source, documentPath, documentName, author, userId, viewMode, store, commentApi, wrappedTransports],
  );
  return (
    <Ctx.Provider value={value}>
      <MrsfBridge />
      {children}
      {sent && <SentToast onDismiss={() => setSent(false)} />}
    </Ctx.Provider>
  );
}

const SENT_TOAST_DURATION_MS = 4000;

function SentToast({ onDismiss }: { onDismiss: () => void }) {
  useEffect(() => {
    const id = setTimeout(onDismiss, SENT_TOAST_DURATION_MS);
    return () => clearTimeout(id);
  }, [onDismiss]);

  return (
    <div
      className="mi-sent-toast"
      role="status"
      aria-live="polite"
      data-testid="sent-toast"
    >
      <strong className="mi-sent-toast-title">Comments sent</strong>
      <span className="mi-sent-toast-body">Agent is processing.</span>
    </div>
  );
}

/**
 * Routes rehype-mrsf controller clicks (data-mrsf-action) to our store. The
 * controller's bubble-phase handler short-circuits to its built-in dialogs
 * (suppressed via mrsfDisableBuiltinUi), so we capture the click first and
 * dispatch the appropriate side-effect.
 */
function MrsfBridge(): null {
  const actions = useStoreActions();

  useEffect(() => {
    function hideTooltip() {
      const tips = document.querySelectorAll(
        ".mrsf-inline-tooltip, .mrsf-tooltip",
      );
      for (const el of tips) {
        el.classList.remove("mrsf-tooltip-visible");
        if (el instanceof HTMLElement) el.style.display = "none";
      }
    }

    function onCapture(e: MouseEvent) {
      const target = (e.target as HTMLElement | null)?.closest<HTMLElement>(
        "[data-mrsf-action]",
      );
      if (!target) return;
      const ds = target.dataset;
      const action = ds.mrsfAction;
      const commentId = ds.mrsfCommentId ?? null;
      const line = Number(ds.mrsfLine ?? ds.mrsfStartLine ?? "");
      const stop = () => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
      };

      switch (action) {
        case "add": {
          if (!Number.isFinite(line) || line <= 0) return;
          stop();
          const endLine = Number(ds.mrsfEndLine ?? line);
          // Prefer the user's text selection if any; otherwise the rendered
          // text of the target block (matches what the rehype-mrsf inline
          // highlighter searches for).
          const block = document.querySelector<HTMLElement>(
            `[data-mrsf-line="${line}"]`,
          );
          const renderedText = block?.textContent?.trim() ?? null;
          document.dispatchEvent(
            new CustomEvent("mrsf:add", {
              detail: {
                commentId: null,
                line,
                end_line: Number.isFinite(endLine) ? endLine : line,
                selectionText: ds.mrsfSelection ?? renderedText,
                action: "add",
              },
              bubbles: true,
            }),
          );
          return;
        }
        case "resolve": {
          if (!commentId) return;
          stop();
          hideTooltip();
          void actions.resolve(commentId);
          return;
        }
        case "unresolve": {
          if (!commentId) return;
          stop();
          hideTooltip();
          void actions.unresolve(commentId);
          return;
        }
        case "delete": {
          if (!commentId) return;
          stop();
          hideTooltip();
          void actions.deleteComment(commentId);
          return;
        }
        case "reply": {
          if (!commentId) return;
          stop();
          hideTooltip();
          document.dispatchEvent(
            new CustomEvent("markit:reply-focus", {
              detail: { commentId },
              bubbles: true,
            }),
          );
          return;
        }
        case "edit": {
          if (!commentId) return;
          stop();
          hideTooltip();
          actions.startEdit(commentId);
          document.dispatchEvent(
            new CustomEvent("markit:edit-focus", {
              detail: { commentId },
              bubbles: true,
            }),
          );
          return;
        }
      }
    }

    document.addEventListener("click", onCapture, true);
    return () => document.removeEventListener("click", onCapture, true);
  }, [actions]);

  return null;
}

export function useMarkIt(): MarkItContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useMarkIt must be used inside <MarkItProvider>");
  return v;
}

export function useMarkItState(): MarkItState {
  const { store } = useMarkIt();
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}

export function useStoreActions() {
  const { store, commentApi, author, userId } = useMarkIt();
  return useMemo(
    () => ({
      openDraft(anchor: DraftAnchor) {
        store.setState((s) => openDraft(s, anchor));
      },
      closeDraft() {
        store.setState((s) => closeDraft(s));
      },
      async submitDraft(text: string) {
        const draft = store.getState().draft;
        if (!draft) throw new Error("submitDraft called with no active draft");
        const doc = await commentApi.add({
          text,
          author,
          x_user_id: userId ?? undefined,
          line: draft.line,
          end_line: draft.end_line,
          selected_text: draft.selected_text,
        });
        store.setState((s) => setDoc(closeDraft(s), doc));
        return doc;
      },
      async reply(parentId: string, text: string) {
        const doc = await commentApi.reply({
          parentId,
          text,
          author,
          x_user_id: userId ?? undefined,
        });
        store.setState((s) => setDoc(s, doc));
        return doc;
      },
      async editComment(commentId: string, text: string) {
        const doc = await commentApi.edit({
          commentId,
          text,
          actor: author,
          x_user_id: userId ?? undefined,
        });
        store.setState((s) => setDoc(closeEdit(s), doc));
        return doc;
      },
      startEdit(commentId: string) {
        store.setState((s) => openEdit(s, commentId));
      },
      cancelEdit() {
        store.setState((s) => closeEdit(s));
      },
      async resolve(commentId: string) {
        const doc = await commentApi.resolve(commentId);
        store.setState((s) => setDoc(s, doc));
        return doc;
      },
      async unresolve(commentId: string) {
        const doc = await commentApi.unresolve(commentId);
        store.setState((s) => setDoc(s, doc));
        return doc;
      },
      async deleteComment(commentId: string, opts?: { cascade?: boolean }) {
        const doc = await commentApi.delete(commentId, opts);
        store.setState((s) => setDoc(s, doc));
        return doc;
      },
      async resolveAll() {
        const doc = await commentApi.resolveAll();
        store.setState((s) => setDoc(s, doc));
        return doc;
      },
      setDoc(doc: MrsfDocument) {
        store.setState((s) => setDoc(s, doc));
      },
    }),
    [store, commentApi, author, userId],
  );
}
