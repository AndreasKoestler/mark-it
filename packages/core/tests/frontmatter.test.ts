import { describe, it, expect } from "vitest";
import { splitFrontmatter, countYamlKeys } from "../src/frontmatter.js";

describe("splitFrontmatter", () => {
  it("returns null yaml + full body when no frontmatter is present", () => {
    const out = splitFrontmatter("# Heading\n\nBody.\n");
    expect(out.yaml).toBeNull();
    expect(out.keyCount).toBe(0);
    expect(out.lineCount).toBe(0);
    expect(out.body).toBe("# Heading\n\nBody.\n");
  });

  it("extracts yaml between leading fences and counts top-level keys", () => {
    const src = "---\ntask: foo\ntype: plan\nrepo: bar\nbranch: main\nsha: abc\n---\n\n# Heading\n";
    const out = splitFrontmatter(src);
    expect(out.yaml).toBe("task: foo\ntype: plan\nrepo: bar\nbranch: main\nsha: abc");
    expect(out.keyCount).toBe(5);
    expect(out.body).toBe("\n# Heading\n");
  });

  it("does not match a non-leading triple-dash block", () => {
    const src = "# Heading\n\n---\nfoo: bar\n---\n";
    const out = splitFrontmatter(src);
    expect(out.yaml).toBeNull();
    expect(out.body).toBe(src);
  });

  it("handles CRLF line endings", () => {
    const src = "---\r\na: 1\r\nb: 2\r\n---\r\nbody\r\n";
    const out = splitFrontmatter(src);
    expect(out.keyCount).toBe(2);
    expect(out.body).toBe("body\r\n");
  });
});

describe("countYamlKeys", () => {
  it("counts only top-level keys, ignoring indented children", () => {
    const yaml = "outer: 1\nnested:\n  child: 2\n  other: 3\nfinal: 4";
    expect(countYamlKeys(yaml)).toBe(3);
  });
});
