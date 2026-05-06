import { describe, it, expect } from "vitest";
import {
  createStore,
  createMarkItStore,
  setDoc,
  openDraft,
  closeDraft,
} from "../src/store.js";
import { emptyDocument } from "../src/sidemark.js";

describe("createStore", () => {
  it("notifies subscribers on setState", () => {
    const store = createStore({ count: 0 });
    const seen: number[] = [];
    const off = store.subscribe((s) => seen.push(s.count));
    store.setState((s) => ({ count: s.count + 1 }));
    store.setState((s) => ({ count: s.count + 1 }));
    off();
    store.setState((s) => ({ count: s.count + 100 }));
    expect(seen).toEqual([1, 2]);
    expect(store.getState().count).toBe(102);
  });
});

describe("MarkItState reducers", () => {
  it("setDoc bumps revision and replaces doc", () => {
    const initial = emptyDocument("docs/a.md");
    const next = emptyDocument("docs/b.md");
    const store = createMarkItStore(initial);
    expect(store.getState().revision).toBe(0);
    store.setState((s) => setDoc(s, next));
    expect(store.getState().doc).toBe(next);
    expect(store.getState().revision).toBe(1);
  });

  it("openDraft and closeDraft toggle draft state", () => {
    const store = createMarkItStore(emptyDocument("x.md"));
    store.setState((s) => openDraft(s, { line: 5, selected_text: "hi" }));
    expect(store.getState().draft).toEqual({ line: 5, selected_text: "hi" });
    store.setState((s) => closeDraft(s));
    expect(store.getState().draft).toBeNull();
  });
});
