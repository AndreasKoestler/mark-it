import { describe, it, expect } from "vitest";
import { commentsForRender, isOrphanedAnchor } from "../src/sidemark.js";
import type { MrsfDocument, Comment } from "@mrsf/cli";

function doc(comments: Comment[]): MrsfDocument {
  return { mrsf_version: "1.0", document: "doc.md", comments };
}

function comment(overrides: Partial<Comment>): Comment {
  return {
    id: "c1",
    author: "Tester",
    timestamp: "2026-01-01T00:00:00.000Z",
    text: "comment body",
    line: 1,
    end_line: 1,
    selected_text: "hello world",
    ...overrides,
  } as Comment;
}

describe("commentsForRender", () => {
  it("swaps selected_text to anchored_text for a real (sub-perfect) drift", () => {
    const c = comment({
      selected_text: "old text",
      // Extension fields the type doesn't know about — cast through.
      ...({ anchored_text: "new text", x_reanchor_score: 0.85 } as object),
    });
    const out = commentsForRender(doc([c]));
    expect(out.comments[0].selected_text).toBe("new text");
  });

  it("keeps selected_text when the score indicates a content-perfect fuzzy match", () => {
    // Reproduces the formatting-only case: rendered selection vs. source-
    // format anchored_text, MRSF scored 1.0 — not real drift. The source IS
    // passed: we have to make sure the orphan-fallback doesn't fire just
    // because selected_text isn't byte-identical to the source line.
    const source =
      "- **Send to agent** — flushes outstanding comments to the calling process.\n";
    const c = comment({
      line: 1,
      end_line: 1,
      selected_text:
        "Send to agent — flushes outstanding comments to the calling process.",
      ...({
        anchored_text:
          "- **Send to agent** — flushes outstanding comments to the calling process.",
        x_reanchor_status: "fuzzy",
        x_reanchor_score: 1.0,
      } as object),
    });
    const out = commentsForRender(doc([c]), source);
    expect(out.comments[0].selected_text).toBe(
      "Send to agent — flushes outstanding comments to the calling process.",
    );
  });

  it("leaves comments untouched when source is omitted", () => {
    const c = comment({ selected_text: "missing from doc" });
    const out = commentsForRender(doc([c]));
    expect(out.comments[0].selected_text).toBe("missing from doc");
  });

  it("falls through to orphan substitution when anchored_text is stale (no longer in source)", () => {
    // Reproduces the post-edit case: MRSF's "line/column fallback" returns
    // status="anchored" with isChanged=false, so it never overwrites the
    // sidecar's previous anchored_text/score. The data is now stale —
    // anchored_text doesn't match the live source. Fall through to the
    // line-content substitution rather than projecting the lie.
    const source = "line 1\n- **New content** that replaced the old.\nline 3\n";
    const c = comment({
      line: 2,
      end_line: 2,
      selected_text: "Old rendered text from before",
      ...({
        anchored_text: "- **Old rendered text from before**",
        x_reanchor_score: 1.0,
        x_reanchor_status: "fuzzy",
      } as object),
    });
    const out = commentsForRender(doc([c]), source);
    // Leading "- " is stripped so the projection matches the rendered DOM
    // (which has no list-bullet prefix). `**` is preserved — MrsfController
    // strips inline markdown itself when searching.
    expect(out.comments[0].selected_text).toBe(
      "**New content** that replaced the old.",
    );
  });

  it("substitutes selected_text with the line content when the anchor is orphaned", () => {
    const source = "line 1\nline 2 — different now\nline 3\n";
    const c = comment({ line: 2, end_line: 2, selected_text: "completely gone" });
    const out = commentsForRender(doc([c]), source);
    expect(out.comments[0].selected_text).toBe("line 2 — different now");
  });

  it("keeps original selected_text when it still appears in the source", () => {
    const source = "line 1\nhello world\nline 3\n";
    const c = comment({ line: 2, end_line: 2, selected_text: "hello world" });
    const out = commentsForRender(doc([c]), source);
    expect(out.comments[0].selected_text).toBe("hello world");
  });

  it("joins multi-line ranges with newlines and trims surrounding whitespace", () => {
    const source = "  block start\n  block end\nfooter\n";
    const c = comment({
      line: 1,
      end_line: 2,
      selected_text: "no longer present",
    });
    const out = commentsForRender(doc([c]), source);
    expect(out.comments[0].selected_text).toBe("block start\n  block end");
  });

  it("leaves a comment alone when its line is out of bounds", () => {
    const source = "only one line\n";
    const c = comment({ line: 99, end_line: 99, selected_text: "never present" });
    const out = commentsForRender(doc([c]), source);
    expect(out.comments[0].selected_text).toBe("never present");
  });
});

describe("isOrphanedAnchor", () => {
  it("returns false when selected_text is in source", () => {
    expect(isOrphanedAnchor(comment({ selected_text: "hello" }), "say hello world")).toBe(false);
  });

  it("returns false when anchored_text is in source even if selected_text is gone", () => {
    const c = comment({
      selected_text: "stale",
      ...({ anchored_text: "fresh" } as object),
    });
    expect(isOrphanedAnchor(c, "look — fresh content here")).toBe(false);
  });

  it("returns true when neither selected_text nor anchored_text is in source", () => {
    const c = comment({ selected_text: "ghost text" });
    expect(isOrphanedAnchor(c, "completely different doc")).toBe(true);
  });
});
