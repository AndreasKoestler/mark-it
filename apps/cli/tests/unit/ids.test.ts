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
});

describe("docIdForSpec", () => {
  test("returns spec.documentId in DB mode", () => {
    expect(docIdForSpec({ filePath: "/x.md", documentId: "uuid-1" })).toBe("uuid-1");
  });

  test("falls back to legacy hash when no documentId", () => {
    expect(docIdForSpec({ filePath: "/x.md" })).toMatch(/^legacy-/);
  });
});
