import { describe, expect, test } from "vitest";
import { mkdtemp, rm, stat, mkdir, writeFile, utimes } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDiscovery } from "../../src/daemon/discovery.js";

/** Bind an ephemeral loopback port so discovery's TCP liveness probe passes. */
async function listen(): Promise<{ port: number; close: () => Promise<void> }> {
  const srv = createServer();
  srv.unref();
  await new Promise<void>((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = srv.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    port,
    close: () =>
      new Promise((resolve, reject) => srv.close((err) => (err ? reject(err) : resolve()))),
  };
}

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
    const listener = await listen();
    try {
      const d = createDiscovery({ home: dir });
      await d.write({ port: listener.port, token: "abc", pid: process.pid });
      const got = await d.read();
      expect(got).toEqual({ port: listener.port, token: "abc", pid: process.pid });
      const file = await stat(join(dir, ".mark-it", "daemon.json"));
      expect(file.mode & 0o777).toBe(0o600);
    } finally {
      await listener.close();
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

  test("read returns null when pid is alive but port rejects connections", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mid-"));
    try {
      const d = createDiscovery({ home: dir });
      // Port 1 is privileged and almost never accepts plain TCP from us.
      await d.write({ port: 1, token: "abc", pid: process.pid });
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

  test("acquireSpawnLock reclaims a lock left behind by a dead process", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mid-"));
    try {
      const d = createDiscovery({ home: dir });
      // Simulate a crashed holder: the lock dir exists with a pid file
      // recording a process that no longer exists.
      const lockDir = join(dir, ".mark-it", ".daemon.lock");
      await mkdir(lockDir, { recursive: true });
      await writeFile(join(lockDir, "pid"), "999999999", "utf8");

      const release = await d.acquireSpawnLock();
      release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("acquireSpawnLock reclaims a lock old enough to be stale even with no pid recorded", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mid-"));
    try {
      const d = createDiscovery({ home: dir });
      // No pid file at all (e.g. crashed before writing it) — must fall
      // back to age. Backdate the lock dir past the staleness threshold.
      const lockDir = join(dir, ".mark-it", ".daemon.lock");
      await mkdir(lockDir, { recursive: true });
      const old = new Date(Date.now() - 31_000);
      await utimes(lockDir, old, old);

      const release = await d.acquireSpawnLock();
      release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("acquireSpawnLock still rejects a fresh lock held by a live process", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mid-"));
    try {
      const d = createDiscovery({ home: dir });
      const release = await d.acquireSpawnLock();
      await expect(d.acquireSpawnLock()).rejects.toThrow();
      release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("clear removes the daemon file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mid-"));
    const listener = await listen();
    try {
      const d = createDiscovery({ home: dir });
      await d.write({ port: listener.port, token: "abc", pid: process.pid });
      await d.clear();
      expect(await d.read()).toBeNull();
    } finally {
      await listener.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
