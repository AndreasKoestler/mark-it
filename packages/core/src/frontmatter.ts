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

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const TOP_LEVEL_KEY_RE = /^[A-Za-z_][\w-]*\s*:/gm;

export function splitFrontmatter(source: string): FrontmatterSplit {
  const match = source.match(FRONTMATTER_RE);
  if (!match) {
    return { yaml: null, body: source, keyCount: 0, lineCount: 0 };
  }
  const [whole, yaml] = match;
  const keyCount = (yaml!.match(TOP_LEVEL_KEY_RE) ?? []).length;
  const lineCount = whole.split(/\r?\n/).length - (whole.endsWith("\n") ? 1 : 0);
  return {
    yaml: yaml!,
    body: source.slice(whole.length),
    keyCount,
    lineCount,
  };
}

export function countYamlKeys(yaml: string): number {
  return (yaml.match(TOP_LEVEL_KEY_RE) ?? []).length;
}
