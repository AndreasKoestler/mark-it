import { describe, expect, test } from "vitest";
import { docIdForLegacyPath, docIdForSpec } from "../../src/daemon/ids.js";

describe("docIdForLegacyPath", () => {
  test("is deterministic for the same absolute path", () => {
    const a = docIdForLegacyPath("/tmp/foo.md");
    const b = docIdForLegacyPath("/tmp/foo.md");
    expect(a).toBe(b);
    expect(a).toMatch(/^legacy-[0-9a-f]{16}$/);
  });

  test("differs for different paths", () => {
    expect(docIdForLegacyPath("/tmp/a.md")).not.toBe(docIdForLegacyPath("/tmp/b.md"));
  });

  test("symlink spellings of the same real path share a docId", async () => {
    const { mkdtemp, writeFile, symlink, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "mid-ids-"));
    try {
      const real = join(dir, "doc.md");
      await writeFile(real, "# hi\n", "utf8");
      const link = join(dir, "alias.md");
      await symlink(real, link);
      expect(docIdForLegacyPath(link)).toBe(docIdForLegacyPath(real));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("docIdForSpec", () => {
  test("returns spec.documentId in DB mode", () => {
    expect(docIdForSpec({ filePath: "/x.md", documentId: "uuid-1" })).toBe("uuid-1");
  });

  test("falls back to legacy hash when no documentId", () => {
    expect(docIdForSpec({ filePath: "/x.md" })).toMatch(/^legacy-/);
  });
});
