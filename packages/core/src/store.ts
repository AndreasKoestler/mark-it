import type { MrsfDocument } from "@mrsf/cli";

export interface DraftAnchor {
  line: number;
  end_line?: number;
  selected_text?: string;
}

export interface MarkItState {
  doc: MrsfDocument;
  draft: DraftAnchor | null;
  /** Monotonic counter bumped on every doc update — useful for memo keys. */
  revision: number;
}

export interface Subscriber<T> {
  (state: T): void;
}

export interface Store<T> {
  getState(): T;
  setState(updater: (prev: T) => T): void;
  subscribe(fn: Subscriber<T>): () => void;
}

export function createStore<T>(initial: T): Store<T> {
  let state = initial;
  const subs = new Set<Subscriber<T>>();
  return {
    getState: () => state,
    setState(updater) {
      state = updater(state);
      for (const fn of subs) fn(state);
    },
    subscribe(fn) {
      subs.add(fn);
      return () => {
        subs.delete(fn);
      };
    },
  };
}

export function createMarkItStore(doc: MrsfDocument): Store<MarkItState> {
  return createStore<MarkItState>({ doc, draft: null, revision: 0 });
}

export function setDoc(state: MarkItState, doc: MrsfDocument): MarkItState {
  return { ...state, doc, revision: state.revision + 1 };
}

export function openDraft(state: MarkItState, anchor: DraftAnchor): MarkItState {
  return { ...state, draft: anchor };
}

export function closeDraft(state: MarkItState): MarkItState {
  return { ...state, draft: null };
}
