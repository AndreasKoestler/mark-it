import { describe, it, expect } from "vitest";
import { commentsForRender, isOrphanedAnchor, anchoredTextIsLive } from "../src/sidemark.js";
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

  it("strips line-prefix and inline markers when projecting anchored_text on drift", () => {
    // Exactly the production case: user edited a bold list item; MRSF wrote
    // the new line-with-markers as anchored_text. The renderer's MrsfController
    // searches the rendered DOM (markers stripped), so the projection has to
    // match what the DOM actually contains — not the raw source line.
    const source =
      "- **Human review** — read a doc, leave comments, reply, resolve, persist them next to the file.\n";
    const c = comment({
      line: 1,
      end_line: 1,
      selected_text: "Solo human review — read a doc, leave comments, reply, resolve, persist them next to the file.",
      ...({
        anchored_text:
          "- **Human review** — read a doc, leave comments, reply, resolve, persist them next to the file.",
        x_reanchor_status: "fuzzy",
        x_reanchor_score: 0.96,
      } as object),
    });
    const out = commentsForRender(doc([c]), source);
    expect(out.comments[0].selected_text).toBe(
      "Human review — read a doc, leave comments, reply, resolve, persist them next to the file.",
    );
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

  it("keeps DOM-captured selected_text when source differs only by inline markdown markers", () => {
    // The user selected text inside a list item like `- **Human review** — …`.
    // The DOM-captured selected_text has `**` and the leading `- ` stripped;
    // without the markdown-aware presence check we'd fall through to the
    // line-content fallback and project lines [line..end_line] (joined),
    // over-highlighting adjacent bullets in the rendered view.
    const source =
      "- **Human review** — read a doc.\n- **Agent-in-the-loop** — different text.\n";
    const c = comment({
      line: 1,
      end_line: 2,
      selected_text: "Human review — read a doc.",
    });
    const out = commentsForRender(doc([c]), source);
    expect(out.comments[0].selected_text).toBe("Human review — read a doc.");
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

  it("returns false when selected_text matches source modulo inline markdown markers", () => {
    // Captured from the rendered DOM (no `**` markers), source has them.
    // A fresh comment with no edits to the document must not be flagged as
    // orphaned just because the source carries formatting markers the DOM
    // doesn't.
    const source =
      "- **Human review** — read a doc, leave comments, reply, resolve, persist them next to the file.\n";
    const c = comment({
      selected_text:
        "Human review — read a doc, leave comments, reply, resolve, persist them next to the file.",
    });
    expect(isOrphanedAnchor(c, source)).toBe(false);
  });

  it("returns false when selected_text matches source modulo a leading list bullet", () => {
    const source = "- bullet item content\n";
    const c = comment({ selected_text: "bullet item content" });
    expect(isOrphanedAnchor(c, source)).toBe(false);
  });
});

describe("anchoredTextIsLive", () => {
  // This is the single source of truth both commentsForRender (render
  // projection) and CommentSidebar's drift badge consult — they must agree
  // on what counts as a live anchor, or one can show a confident highlight
  // while the other reports the anchor as lost.

  it("is true when anchored_text differs from selected_text and is found in source", () => {
    const c = comment({
      selected_text: "old text",
      ...({ anchored_text: "new text" } as object),
    });
    expect(anchoredTextIsLive(c, "the doc now says new text here")).toBe(true);
  });

  it("is false when anchored_text is not present in source (stale metadata)", () => {
    const c = comment({
      selected_text: "old text",
      ...({ anchored_text: "new text" } as object),
    });
    expect(anchoredTextIsLive(c, "neither string appears here")).toBe(false);
  });

  it("is false when anchored_text equals selected_text (no real re-anchor candidate)", () => {
    const c = comment({
      selected_text: "same text",
      ...({ anchored_text: "same text" } as object),
    });
    expect(anchoredTextIsLive(c, "the doc contains same text")).toBe(false);
  });

  it("is false when anchored_text is absent", () => {
    const c = comment({ selected_text: "hello" });
    expect(anchoredTextIsLive(c, "hello world")).toBe(false);
  });

  it("is true even at a low re-anchor score, as long as the anchor is actually findable — this is what keeps the sidebar's badge from contradicting the rendered highlight", () => {
    const c = comment({
      selected_text: "old phrasing",
      ...({ anchored_text: "new phrasing", x_reanchor_score: 0.2 } as object),
    });
    expect(anchoredTextIsLive(c, "document now reads: new phrasing")).toBe(true);
  });
});
