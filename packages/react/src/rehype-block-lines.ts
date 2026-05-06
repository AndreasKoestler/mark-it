import type { Root, Element } from "hast";
import { visit } from "unist-util-visit";

const BLOCK_TAGS = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "blockquote",
  "pre",
  "table",
  "tr",
]);

/**
 * Annotates every block-level element with `data-mrsf-line` (1-based start line).
 * This lets MrsfController render add/comment affordances on every block,
 * even when no comments exist for that line yet.
 */
export function rehypeBlockLines() {
  return (tree: Root) => {
    visit(tree, "element", (node: Element) => {
      if (!BLOCK_TAGS.has(node.tagName)) return;
      const start = node.position?.start.line;
      if (typeof start !== "number") return;
      node.properties ??= {};
      // Don't overwrite if rehype-mrsf already set it (it does not, but be safe).
      if (node.properties["data-mrsf-line"] == null) {
        node.properties["data-mrsf-line"] = String(start);
      }
    });
  };
}
