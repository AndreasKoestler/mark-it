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

export interface CommentApi {
  /** Persist a new top-level comment. Returns the updated MrsfDocument. */
  add(input: CommentAddInput): Promise<MrsfDocument>;
  reply(input: CommentReplyInput): Promise<MrsfDocument>;
  resolve(commentId: string): Promise<MrsfDocument>;
  unresolve(commentId: string): Promise<MrsfDocument>;
  delete(commentId: string): Promise<MrsfDocument>;
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

  // Suppress rehype-mrsf's built-in dialog — our sidebar is the dialog.
  useEffect(() => {
    (window as unknown as { mrsfDisableBuiltinUi?: boolean }).mrsfDisableBuiltinUi = true;
  }, []);

  // Sync external doc updates (e.g. SSE-driven re-anchoring) into the store.
  useEffect(() => {
    if (store.getState().doc !== doc) {
      store.setState((s) => setDoc(s, doc));
    }
  }, [doc, store]);

  // When the active document changes, drop transient UI state (draft) so
  // the new doc doesn't inherit a stale draft anchor.
  useEffect(() => {
    store.setState((s) => closeDraft(s));
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
      transports,
    }),
    [source, documentPath, documentName, author, userId, viewMode, store, commentApi, transports],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
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
      async deleteComment(commentId: string) {
        const doc = await commentApi.delete(commentId);
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
