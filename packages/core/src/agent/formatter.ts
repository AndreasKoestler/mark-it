import type { AgentPayload } from "./transport.js";
import type { Comment } from "../sidemark.js";

/**
 * Render an AgentPayload as a structured plain-text prompt suitable for any
 * agent (clipboard, webhook, CLI). Format is the contract for all transports.
 */
export function formatForAgent(payload: AgentPayload): string {
  const { document, comments } = payload;
  const lines: string[] = [];
  lines.push(`Document: ${document.path}`);
  lines.push("");

  const byParent = new Map<string, Comment[]>();
  for (const c of comments) {
    if (c.reply_to) {
      const list = byParent.get(c.reply_to) ?? [];
      list.push(c);
      byParent.set(c.reply_to, list);
    }
  }
  const roots = comments.filter((c) => !c.reply_to);

  roots.forEach((c, idx) => {
    const lineRef = c.line ? ` (line ${c.line})` : "";
    const anchor = c.selected_text ? ` — "${c.selected_text}"` : "";
    lines.push(`Comment ${idx + 1}${lineRef}${anchor}:`);
    lines.push(`  ${c.author} — ${c.timestamp}`);
    for (const tline of c.text.split("\n")) {
      lines.push(`  > ${tline}`);
    }
    const replies = byParent.get(c.id) ?? [];
    for (const r of replies) {
      lines.push(`  ↳ ${r.author} — ${r.timestamp}`);
      for (const tline of r.text.split("\n")) {
        lines.push(`    > ${tline}`);
      }
    }
    lines.push("");
  });

  return lines.join("\n").trimEnd() + "\n";
}
