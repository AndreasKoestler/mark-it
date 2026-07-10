import { mkdirSync, rmSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { rename, writeFile, readFile, chmod, mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { connect as netConnect } from "node:net";

// A spawn that's taken this long either crashed mid-spawn (leaving the lock
// dir behind with nothing left to release it) or is stuck; either way it's
// safe to reclaim rather than wedge every future `mark-it` invocation.
const STALE_LOCK_MS = 30_000;
const PORT_PROBE_MS = 500;

export interface DaemonInfo {
  port: number;
  token: string;
  pid: number;
}

export interface Discovery {
  read(): Promise<DaemonInfo | null>;
  write(info: DaemonInfo): Promise<void>;
  clear(): Promise<void>;
  acquireSpawnLock(): Promise<() => void>;
  paths: { dir: string; file: string; lock: string };
}

/** True when something accepts TCP connections on 127.0.0.1:port. */
export function portAcceptsConnections(
  port: number,
  timeoutMs = PORT_PROBE_MS,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = netConnect({ host: "127.0.0.1", port });
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

export function createDiscovery(opts: { home?: string } = {}): Discovery {
  const home = opts.home ?? process.env.MARK_IT_HOME ?? homedir();
  const dir = join(home, ".mark-it");
  const file = join(dir, "daemon.json");
  const lock = join(dir, ".daemon.lock");

  function alive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  const lockPidFile = join(lock, "pid");

  function lockIsStale(): boolean {
    let ageMs: number;
    try {
      ageMs = Date.now() - statSync(lock).mtimeMs;
    } catch {
      // Lock vanished between mkdirSync failing and now (released
      // concurrently) — not stale, just gone; the retry below will succeed.
      return true;
    }
    if (ageMs > STALE_LOCK_MS) return true;
    try {
      const pid = Number(readFileSync(lockPidFile, "utf8"));
      return Number.isFinite(pid) && !alive(pid);
    } catch {
      // No pid recorded yet — the holder crashed between mkdirSync and
      // writing it, or this lock predates pid-recording. Fall back to age.
      return false;
    }
  }

  return {
    paths: { dir, file, lock },

    async read() {
      try {
        const raw = await readFile(file, "utf8");
        const info = JSON.parse(raw) as DaemonInfo;
        if (!alive(info.pid)) return null;
        // PID-alive alone is insufficient: a wedged process or recycled PID
        // would poison every client. Confirm the recorded port accepts TCP.
        if (!(await portAcceptsConnections(info.port))) return null;
        return info;
      } catch {
        return null;
      }
    },

    async write(info) {
      await mkdir(dir, { recursive: true });
      const tmp = `${file}.tmp`;
      await writeFile(tmp, JSON.stringify(info), { mode: 0o600 });
      await chmod(tmp, 0o600);
      await rename(tmp, file);
    },

    async clear() {
      try {
        await unlink(file);
      } catch {
        /* already gone */
      }
    },

    async acquireSpawnLock() {
      await mkdir(dir, { recursive: true });
      try {
        mkdirSync(lock); // throws EEXIST if held
      } catch (err) {
        if (!lockIsStale()) throw err;
        // Reclaim: the previous holder is dead or this has been held far
        // longer than any real daemon spawn takes. If another process reclaims
        // it first, the retry below throws and that process just waits instead.
        rmSync(lock, { recursive: true, force: true });
        mkdirSync(lock);
      }
      writeFileSync(lockPidFile, String(process.pid), "utf8");
      return () => rmSync(lock, { recursive: true, force: true });
    },
  };
}
