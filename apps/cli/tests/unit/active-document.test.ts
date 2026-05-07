import { describe, expect, test } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createActiveDocument } from "../../src/active-document.js";

const ORIGINAL = `# Title

Empty repository ready for scaffolding.
`;

function seedSidecar(filePath: string): string {
  return `mrsf_version: "1.0"
document: ${filePath}
comments:
  - id: c1
    author: tester
    timestamp: "2026-01-01T00:00:00Z"
    text: "Anchor probe"
    line: 3
    end_line: 3
    selected_text: "Empty repository ready for scaffolding."
`;
}

describe("ensureFreshAnchors", () => {
  test("re-anchors comments when the file changed since the last pass", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mark-it-active-"));
    try {
      const filePath = join(dir, "doc.md");
      const sidecarPath = `${filePath}.review.yaml`;
      await writeFile(filePath, ORIGINAL, "utf8");
      await writeFile(sidecarPath, seedSidecar(filePath), "utf8");

      const active = createActiveDocument({
        initial: { filePath },
        clients: new Set(),
        broadcastSse: () => {},
      });

      try {
        // Prime: first call hashes the current file and re-anchors at line 3.
        await active.ensureFreshAnchors();
        const primed = await readFile(sidecarPath, "utf8");
        expect(primed).toMatch(/line: 3/);

        // Edit on disk *without* relying on the watcher: prepend two lines so
        // the anchored prose moves from line 3 to line 5.
        await writeFile(filePath, "\n\n" + ORIGINAL, "utf8");

        // The fix: GET /api/sidecar calls ensureFreshAnchors, which detects
        // the new content hash and re-anchors before responding.
        await active.ensureFreshAnchors();

        const updated = await readFile(sidecarPath, "utf8");
        expect(updated).toMatch(/line: 5/);
        expect(updated).not.toMatch(/^\s+line: 3$/m);
      } finally {
        await active.dispose();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("is a no-op when content has not changed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mark-it-active-"));
    try {
      const filePath = join(dir, "doc.md");
      const sidecarPath = `${filePath}.review.yaml`;
      await writeFile(filePath, ORIGINAL, "utf8");
      await writeFile(sidecarPath, seedSidecar(filePath), "utf8");

      const active = createActiveDocument({
        initial: { filePath },
        clients: new Set(),
        broadcastSse: () => {},
      });

      try {
        await active.ensureFreshAnchors();
        const firstMtime = (await readFile(sidecarPath, "utf8")).length;
        // Second call should not rewrite the sidecar (content hash unchanged).
        await active.ensureFreshAnchors();
        const secondMtime = (await readFile(sidecarPath, "utf8")).length;
        expect(secondMtime).toBe(firstMtime);
      } finally {
        await active.dispose();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
