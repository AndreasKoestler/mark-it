// Use the browser-safe entry — `@mark-it/core` runs in the renderer too, and
// the default `@mrsf/cli` entry pulls in node:path / node:url at module load.
import { HIGH_THRESHOLD as MRSF_HIGH_THRESHOLD, type Comment, type MrsfDocument } from "@mrsf/cli/browser";

/**
 * Above this score we treat the match as content-perfect — `anchored_text` is
 * just a formatting variant of `selected_text` (e.g. source `**foo**` vs.
 * rendered `foo`), not a real drift. Slack against floating point.
 */
export const PERFECT_SCORE = 0.99;

/**
 * Strip leading line-prefix markdown (list bullets, blockquote, ordered-list
 * markers, heading hashes) from a single line of source. Inline markers like
 * `**bold**` are left alone — MrsfController's own substring search already
 * handles those.
 */
function stripLinePrefix(s: string): string {
  return s.replace(/^\s*(?:[-*+]|\d+\.|>|#{1,6})\s+/, "");
}

/**
 * Strip inline markdown delimiters (`**`, `__`, `*`, `_`, `~~`, backticks)
 * from a string. Mirrors `MrsfController.stripInlineMarkdown` so that anchor
 * checks comparing rendered selected_text against raw source can succeed —
 * the renderer sees the text without the markers, so naive `source.includes`
 * would otherwise miss any anchor on a line with inline formatting.
 */
function stripInlineMarkdown(s: string): string {
  return s
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/_(.+?)_/g, "$1")
    .replace(/~~(.+?)~~/g, "$1");
}

function anchorPresentInSource(text: string | undefined, source: string): boolean {
  if (!text) return false;
  if (source.includes(text)) return true;
  // selected_text captured from the rendered DOM has its markdown markers
  // stripped; check against a stripped view of source so a freshly-added
  // comment on a line like `- **bold** stuff` isn't flagged as orphaned.
  return stripInlineMarkdown(source).includes(text);
}

/**
 * Re-anchor-aware projection for renderers. The Sidemark spec keeps
 * `selected_text` immutable, but renderers (e.g. `@mrsf/rehype-mrsf`'s
 * `MrsfController`) search the live document for that exact string — they
 * return silently if they can't find a match.
 *
 * Trust MRSF's own confidence score:
 *   - `score >= PERFECT_SCORE`: keep `selected_text`. The match is content-
 *     perfect; the only reason `anchored_text` differs is formatting
 *     (e.g. source bullets/bold markers the rendered DOM doesn't carry).
 *     Projecting `anchored_text` here actually *breaks* the renderer
 *     because its `stripInlineMarkdown` doesn't handle every source-side
 *     prefix (list bullets, blockquote markers, etc.).
 *   - `score < PERFECT_SCORE` with `anchored_text` set: real drift; project
 *     `anchored_text` so the renderer finds the new location.
 *   - No anchor info AND `selected_text` not in source (MRSF's "line/column
 *     fallback" returns status="anchored" without writing anything for this
 *     case): substitute the recorded line's current content so the renderer
 *     has a fallback highlight instead of drawing nothing.
 *
 * The on-disk sidecar is untouched. The sidebar reads raw `doc.comments`, so
 * the original selected_text still appears in the comment's blockquote.
 */
export function commentsForRender(doc: MrsfDocument, source?: string): MrsfDocument {
  const lines = source != null ? source.split(/\r?\n/) : null;

  const projected: Comment[] = (doc.comments ?? []).map((c) => {
    const ext = c as Comment & { anchored_text?: string; x_reanchor_score?: number };
    const anchored = ext.anchored_text;
    const score = ext.x_reanchor_score;

    // Re-anchor produced a candidate distinct from the original.
    if (anchored && anchored !== c.selected_text) {
      // Validate anchored_text is actually in the live source. MRSF's
      // applyReanchorResults skips writing fields when its line/column
      // fallback returns status="anchored" with isChanged=false — which
      // means stale anchored_text and stale score can persist long after
      // the line they pointed at has been edited. Don't trust the metadata
      // unless it agrees with the current document.
      const anchoredIsLive = source == null || source.includes(anchored);
      if (anchoredIsLive) {
        const isContentPerfect = score != null && score >= PERFECT_SCORE;
        // Perfect-score match: anchored differs only in formatting (source
        // markdown markers vs. rendered text). The original selected_text
        // matches the rendered DOM 1:1 — keep it.
        if (isContentPerfect) return c;
        // Real drift: project anchored so the renderer searches for the
        // closest live match. Strip line-prefix and inline markdown so the
        // projection matches the rendered DOM — MrsfController locates
        // highlights in the rendered text, not the raw source. Without
        // stripping, an anchored_text like "- **Human review** — …" never
        // matches the DOM "Human review — …" and the controller falls back
        // to inserting both texts inline.
        const cleaned = stripInlineMarkdown(stripLinePrefix(anchored));
        return { ...c, selected_text: cleaned };
      }
      // Stale anchored_text — fall through to the orphan substitution
      // below using the recorded line's current content.
    }

    // No (or stale) anchored_text and the original selected_text is gone.
    // Substitute the recorded line's current content so the renderer has
    // something to highlight at the comment's location. Strip line-prefix
    // markdown (list bullet, blockquote, heading marker) so the result
    // matches the rendered DOM — MrsfController's own stripInlineMarkdown
    // handles inline markers (`**`, `_`, …) but not these line-leading
    // prefixes.
    //
    // `anchorPresentInSource` lets selected_text captured from the rendered
    // DOM (markers stripped) match raw source with markers — without that
    // fallback we'd needlessly substitute a multi-line projection over
    // `[line, end_line]` and the renderer would highlight more than the
    // user originally selected.
    if (
      lines != null &&
      source != null &&
      c.selected_text &&
      c.line != null &&
      !anchorPresentInSource(c.selected_text, source)
    ) {
      const startIdx = c.line - 1;
      const endIdx = (c.end_line ?? c.line) - 1;
      if (startIdx >= 0 && startIdx < lines.length) {
        const lineText = lines.slice(startIdx, endIdx + 1).join("\n").trim();
        const stripped = stripLinePrefix(lineText);
        if (stripped) return { ...c, selected_text: stripped };
      }
    }
    return c;
  });
  return { ...doc, comments: projected };
}

/**
 * True when the comment's anchor is effectively lost in `source`. Used to
 * detect MRSF's "line/column fallback" case — it returns status="anchored"
 * even when the selected_text is gone, so neither `x_reanchor_status` nor
 * `anchored_text` get written. We have to spot it ourselves.
 */
export function isOrphanedAnchor(comment: Comment, source: string): boolean {
  const ext = comment as Comment & { anchored_text?: string };
  if (anchorPresentInSource(ext.anchored_text, source)) return false;
  if (anchorPresentInSource(comment.selected_text, source)) return false;
  return true;
}

export { MRSF_HIGH_THRESHOLD };

export function emptyDocument(documentPath: string): MrsfDocument {
  return {
    mrsf_version: "1.0",
    document: documentPath,
    comments: [],
  };
}

export type { MrsfDocument } from "@mrsf/cli/browser";
export type { Comment } from "@mrsf/cli/browser";
