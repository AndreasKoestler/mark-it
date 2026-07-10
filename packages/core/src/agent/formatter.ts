import type { AgentPayload } from "./transport.js";
import type { Comment } from "../sidemark.js";

// The sidecar YAML this data ultimately comes from is an openly user-editable
// file — `text` can be missing or non-string despite Comment's type saying
// otherwise. Coerce defensively so one malformed comment degrades to an
// empty line instead of throwing and aborting the whole batch.
function textLines(text: unknown): string[] {
  return (typeof text === "string" ? text : "").split("\n");
}

/**
 * Render an AgentPayload as a structured plain-text prompt suitable for any
 * agent (clipboard, webhook, CLI). Format is the contract for all transports.
 */
export function formatForAgent(payload: AgentPayload): string {
  const { document, comments } = payload;
  const lines: string[] = [];
  lines.push(`Document: ${document.path}`);
  lines.push("");

  const ids = new Set(comments.map((c) => c.id));
  const byParent = new Map<string, Comment[]>();
  for (const c of comments) {
    // Only nest under a parent that is also in this batch — otherwise the
    // reply would vanish (resolved root + open reply is a common case).
    if (c.reply_to && ids.has(c.reply_to)) {
      const list = byParent.get(c.reply_to) ?? [];
      list.push(c);
      byParent.set(c.reply_to, list);
    }
  }
  // Promote dangling replies (parent filtered out of this array) to roots.
  const roots = comments.filter((c) => !c.reply_to || !ids.has(c.reply_to));

  roots.forEach((c, idx) => {
    const lineRef = c.line ? ` (line ${c.line})` : "";
    const anchor = c.selected_text ? ` — "${c.selected_text}"` : "";
    lines.push(`Comment ${idx + 1}${lineRef}${anchor}:`);
    lines.push(`  ${c.author} — ${c.timestamp}`);
    for (const tline of textLines(c.text)) {
      lines.push(`  > ${tline}`);
    }
    const replies = byParent.get(c.id) ?? [];
    for (const r of replies) {
      lines.push(`  ↳ ${r.author} — ${r.timestamp}`);
      for (const tline of textLines(r.text)) {
        lines.push(`    > ${tline}`);
      }
    }
    lines.push("");
  });

  return lines.join("\n").trimEnd() + "\n";
}
