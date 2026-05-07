import { describe, expect, test } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDiscovery } from "../../src/daemon/discovery.js";

describe("discovery", () => {
  test("read returns null when file missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mid-"));
    try {
      const d = createDiscovery({ home: dir });
      expect(await d.read()).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("write + read round-trips with mode 0600", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mid-"));
    try {
      const d = createDiscovery({ home: dir });
      await d.write({ port: 5173, token: "abc", pid: process.pid });
      const got = await d.read();
      expect(got).toEqual({ port: 5173, token: "abc", pid: process.pid });
      const file = await stat(join(dir, ".mark-it", "daemon.json"));
      expect(file.mode & 0o777).toBe(0o600);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("read returns null when pid is dead", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mid-"));
    try {
      const d = createDiscovery({ home: dir });
      await d.write({ port: 5173, token: "abc", pid: 999_999_999 });
      expect(await d.read()).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("acquireSpawnLock is exclusive", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mid-"));
    try {
      const d = createDiscovery({ home: dir });
      const release = await d.acquireSpawnLock();
      await expect(d.acquireSpawnLock()).rejects.toThrow();
      release();
      const release2 = await d.acquireSpawnLock();
      release2();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("clear removes the daemon file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mid-"));
    try {
      const d = createDiscovery({ home: dir });
      await d.write({ port: 5173, token: "abc", pid: process.pid });
      await d.clear();
      expect(await d.read()).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
