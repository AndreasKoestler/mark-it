import { describe, expect, test } from "vitest";
import { mkdtemp, writeFile, readFile, rename, rm } from "node:fs/promises";
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

  test("withWriteLock serializes overlapping load-mutate-save cycles so neither write is lost", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mark-it-sess-"));
    try {
      const file = join(dir, "doc.md");
      await writeFile(file, "# hi\n", "utf8");
      const reg = createSessionRegistry({ broadcast: () => {} });
      const sess = reg.register({ filePath: file });
      try {
        async function addComment(id: string) {
          return sess.withWriteLock(async () => {
            const doc = await sess.sidecar.load();
            if (!Array.isArray(doc.comments)) doc.comments = [];
            // Force the two calls to overlap mid-cycle — exactly the
            // window that loses an update if the two aren't serialized.
            await new Promise((r) => setTimeout(r, 20));
            doc.comments.push({
              id,
              author: "tester",
              timestamp: "2026-01-01T00:00:00Z",
              text: id,
              resolved: false,
            });
            await sess.sidecar.save(doc);
          });
        }

        await Promise.all([addComment("c1"), addComment("c2")]);

        const final = await sess.sidecar.load();
        expect(final.comments.map((c) => c.id).sort()).toEqual(["c1", "c2"]);
      } finally {
        await reg.unregister(sess.docId);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("watcher fires on atomic rename writes (vim/Edit-tool save pattern)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mark-it-watcher-"));
    try {
      const file = join(dir, "doc.md");
      await writeFile(file, "v0\n", "utf8");

      const events: string[] = [];
      const reg = createSessionRegistry({
        broadcast: (_docId, event) => events.push(event),
      });
      const sess = reg.register({ filePath: file });
      try {
        // chokidar attaches its inotify/fsevents backend asynchronously
        // after .watch() returns, so the first write can land before the
        // watcher is live. Warm up with rename writes until we observe an
        // event — this proves the watcher is attached before we assert, and
        // keeps the test from racing setup on a loaded CI runner.
        await waitForEvent(events, async () => {
          const tmp = `${file}.warmup`;
          await writeFile(tmp, "warmup\n", "utf8");
          await rename(tmp, file);
        });
        events.length = 0;

        // Several atomic-rename writes in a row — modern editors (and our
        // own Edit tool) save by writing to a tempfile and then renaming
        // it over the target. Single-file chokidar watches lose the inode
        // and stop firing after the first such write; watching the parent
        // dir survives any number.
        for (const v of ["v1", "v2", "v3", "v4"]) {
          const tmp = `${file}.tmp`;
          await writeFile(tmp, `${v}\n`, "utf8");
          await rename(tmp, file);
          await waitFor(() => events.length > 0, 5_000);
          events.length = 0;
        }
      } finally {
        await reg.unregister(sess.docId);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`waitFor: predicate not satisfied within ${timeoutMs}ms`);
}

// Repeatedly trigger `poke` until at least one event is observed. Used to
// bridge the async gap between chokidar.watch() returning and its filesystem
// backend actually being attached, which otherwise makes the first write race
// watcher setup on slow/loaded CI runners.
async function waitForEvent(
  events: readonly unknown[],
  poke: () => Promise<void>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await poke();
    for (let i = 0; i < 8 && events.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    if (events.length > 0) return;
  }
  throw new Error(`waitForEvent: no event within ${timeoutMs}ms`);
}
