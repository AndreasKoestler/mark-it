export interface FrontmatterSplit {
  /** Raw YAML body between the fences (no fences), or null if no frontmatter found. */
  yaml: string | null;
  /** Source text after the closing fence (or the full source if none). */
  body: string;
  /** Number of top-level YAML keys (best-effort regex; sufficient for flat frontmatter). */
  keyCount: number;
  /** Number of source lines consumed by the frontmatter block (including fences). 0 if absent. */
  lineCount: number;
}

const TOP_LEVEL_KEY_RE = /^[A-Za-z_][\w-]*\s*:/gm;

/**
 * Split leading YAML frontmatter from a Markdown source.
 *
 * Closing fence is the first line that is exactly `---` (no leading
 * whitespace). Mid-line `---` inside a value does not close the block; a
 * value that is itself a lone `---` line still will (ambiguous with the
 * fence — quote such values).
 */
export function splitFrontmatter(source: string): FrontmatterSplit {
  if (!source.startsWith("---\n") && !source.startsWith("---\r\n")) {
    return { yaml: null, body: source, keyCount: 0, lineCount: 0 };
  }

  const lines = source.split(/\r?\n/);
  // lines[0] is "---"
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) {
    return { yaml: null, body: source, keyCount: 0, lineCount: 0 };
  }

  const yaml = lines.slice(1, closeIdx).join("\n");
  const keyCount = (yaml.match(TOP_LEVEL_KEY_RE) ?? []).length;
  const lineCount = closeIdx + 1; // opening + yaml lines + closing

  // Reconstruct body from original source so CRLF/LF is preserved.
  // Find the byte offset of the end of the closing fence line.
  let offset = 0;
  let lineNo = 0;
  while (lineNo <= closeIdx && offset < source.length) {
    const nextNl = source.indexOf("\n", offset);
    if (nextNl === -1) {
      offset = source.length;
      break;
    }
    offset = nextNl + 1;
    lineNo += 1;
  }
  const body = source.slice(offset);

  return { yaml, body, keyCount, lineCount };
}

export function countYamlKeys(yaml: string): number {
  return (yaml.match(TOP_LEVEL_KEY_RE) ?? []).length;
}
