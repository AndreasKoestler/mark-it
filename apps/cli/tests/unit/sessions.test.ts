import { describe, expect, test } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionRegistry } from "../../src/daemon/sessions.js";

describe("SessionRegistry", () => {
  test("register returns the same docId for the same path; unregister removes it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mark-it-sess-"));
    try {
      const file = join(dir, "doc.md");
      await writeFile(file, "# hi\n", "utf8");
      const reg = createSessionRegistry({ broadcast: () => {} });
      const a = reg.register({ filePath: file });
      const b = reg.register({ filePath: file });
      expect(a.docId).toBe(b.docId);
      expect(reg.size()).toBe(1);
      await reg.unregister(a.docId);
      expect(reg.size()).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("ensureFreshAnchors re-anchors when the file changed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mark-it-sess-"));
    try {
      const file = join(dir, "doc.md");
      const sidecarPath = `${file}.review.yaml`;
      const original = "# Title\n\nEmpty repository ready for scaffolding.\n";
      await writeFile(file, original, "utf8");
      await writeFile(
        sidecarPath,
        `mrsf_version: "1.0"
document: ${file}
comments:
  - id: c1
    author: tester
    timestamp: "2026-01-01T00:00:00Z"
    text: "Anchor probe"
    line: 3
    end_line: 3
    selected_text: "Empty repository ready for scaffolding."
`,
        "utf8",
      );
      const reg = createSessionRegistry({ broadcast: () => {} });
      const sess = reg.register({ filePath: file });
      try {
        await sess.ensureFreshAnchors();
        await writeFile(file, "\n\n" + original, "utf8");
        await sess.ensureFreshAnchors();
        const updated = await readFile(sidecarPath, "utf8");
        expect(updated).toMatch(/line: 5/);
      } finally {
        await reg.unregister(sess.docId);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
