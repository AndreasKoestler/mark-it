import { describe, it, expect } from "vitest";
import { formatForAgent } from "../src/agent/formatter.js";
import { ClipboardTransport } from "../src/agent/clipboard-transport.js";
import type { Comment } from "../src/sidemark.js";

const baseComment = (over: Partial<Comment>): Comment => ({
  id: "c1",
  author: "Ada Lovelace (ada@example.com)",
  timestamp: "2026-05-06T12:00:00Z",
  text: "Looks good.",
  resolved: false,
  ...over,
});

describe("formatForAgent", () => {
  it("renders a single comment with line + selected_text", () => {
    const out = formatForAgent({
      document: { path: "docs/plan.md" },
      comments: [
        baseComment({
          line: 12,
          selected_text: "Empty repository ready for scaffolding",
          text: "Confirm scaffolding includes Vitest config.",
        }),
      ],
      intent: "single",
    });
    expect(out).toMatchInlineSnapshot(`
      "Document: docs/plan.md

      Comment 1 (line 12) — \"Empty repository ready for scaffolding\":
        Ada Lovelace (ada@example.com) — 2026-05-06T12:00:00Z
        > Confirm scaffolding includes Vitest config.
      "
    `);
  });

  it("renders threaded replies under their parent in timestamp order", () => {
    const out = formatForAgent({
      document: { path: "docs/plan.md" },
      comments: [
        baseComment({ id: "p1", line: 10, text: "Parent text", timestamp: "2026-05-06T12:00:00Z" }),
        baseComment({ id: "r1", reply_to: "p1", text: "Reply A", timestamp: "2026-05-06T12:05:00Z" }),
        baseComment({ id: "p2", line: 20, text: "Second root", timestamp: "2026-05-06T12:10:00Z" }),
      ],
      intent: "all",
    });
    expect(out).toContain("Comment 1 (line 10)");
    expect(out).toContain("↳ Ada Lovelace");
    expect(out).toContain("Reply A");
    expect(out).toContain("Comment 2 (line 20)");
    expect(out.indexOf("Reply A")).toBeLessThan(out.indexOf("Comment 2"));
  });

  it("omits anchor when no selected_text is set", () => {
    const out = formatForAgent({
      document: { path: "x.md" },
      comments: [baseComment({ line: 1 })],
      intent: "single",
    });
    // Header line ends after `(line 1):` — no anchor `— "..."` segment.
    expect(out).toMatch(/^Comment 1 \(line 1\):$/m);
  });

  it("promotes a reply whose parent is absent from the batch to a root (does not drop it)", () => {
    const out = formatForAgent({
      document: { path: "doc.md" },
      comments: [
        baseComment({
          id: "orphan-reply",
          reply_to: "missing-parent",
          text: "Still need this in the agent prompt.",
        }),
      ],
      intent: "all",
    });
    expect(out).toContain("Still need this in the agent prompt.");
    expect(out).toContain("Comment 1");
  });

  it("degrades a comment with missing text to an empty line instead of throwing, and still renders the rest of the batch", () => {
    // The sidecar YAML this data comes from is openly user-editable — a
    // hand-edited file can omit `text` despite Comment's type saying it's
    // required. One malformed comment must not abort the whole batch.
    const malformed = baseComment({ line: 3 });
    delete (malformed as { text?: string }).text;
    const good = baseComment({ id: "c2", line: 7, text: "Still readable." });

    expect(() =>
      formatForAgent({ document: { path: "doc.md" }, comments: [malformed, good], intent: "all" }),
    ).not.toThrow();

    const out = formatForAgent({
      document: { path: "doc.md" },
      comments: [malformed, good],
      intent: "all",
    });
    expect(out).toContain("Comment 1 (line 3)");
    expect(out).toContain("Comment 2 (line 7)");
    expect(out).toContain("Still readable.");
  });
});

describe("ClipboardTransport", () => {
  it("formats and writes via the configured writeText", async () => {
    const writes: string[] = [];
    const t = new ClipboardTransport({
      writeText: async (s) => {
        writes.push(s);
      },
    });
    await t.send({
      document: { path: "doc.md" },
      comments: [baseComment({ line: 5 })],
      intent: "single",
    });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("Document: doc.md");
    expect(writes[0]).toContain("Comment 1 (line 5)");
  });

  it("respects a custom format override", async () => {
    let captured = "";
    const t = new ClipboardTransport({
      format: (p) => `count=${p.comments.length}`,
      writeText: async (s) => {
        captured = s;
      },
    });
    await t.send({
      document: { path: "doc.md" },
      comments: [baseComment({}), baseComment({ id: "c2" })],
      intent: "all",
    });
    expect(captured).toBe("count=2");
  });
});
