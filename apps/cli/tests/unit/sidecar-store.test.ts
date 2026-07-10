import { describe, expect, test } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiskSidecarStore } from "../../src/sidecar/store.js";

describe("DiskSidecarStore", () => {
  test("load() salvages an empty document instead of throwing when the sidecar YAML is corrupted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mark-it-sidecar-"));
    try {
      const file = join(dir, "doc.md");
      const sidecarPath = `${file}.review.yaml`;
      // Deliberately invalid YAML — an unterminated flow sequence, the kind
      // of mistake a hand-edit of this openly user-editable file can produce.
      await writeFile(
        sidecarPath,
        'mrsf_version: "1.0"\ndocument: doc.md\ncomments: [\n  - id: c1\n    text: "unterminated\n',
        "utf8",
      );
      const store = new DiskSidecarStore(file, sidecarPath);
      const doc = await store.load();
      expect(doc.mrsf_version).toBe("1.0");
      expect(Array.isArray(doc.comments)).toBe(true);
      expect(doc.comments).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("load() returns real comments untouched for well-formed YAML", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mark-it-sidecar-"));
    try {
      const file = join(dir, "doc.md");
      const sidecarPath = `${file}.review.yaml`;
      await writeFile(
        sidecarPath,
        `mrsf_version: "1.0"\ndocument: doc.md\ncomments:\n  - id: c1\n    author: tester\n    timestamp: "2026-01-01T00:00:00Z"\n    text: "hello"\n    resolved: false\n`,
        "utf8",
      );
      const store = new DiskSidecarStore(file, sidecarPath);
      const doc = await store.load();
      expect(doc.comments).toHaveLength(1);
      expect(doc.comments[0]?.text).toBe("hello");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("load() returns an empty document when no sidecar file exists yet", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mark-it-sidecar-"));
    try {
      const file = join(dir, "doc.md");
      const store = new DiskSidecarStore(file, `${file}.review.yaml`);
      const doc = await store.load();
      expect(doc.comments).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
