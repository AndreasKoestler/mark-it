import { mkdirSync, rmSync } from "node:fs";
import { rename, writeFile, readFile, chmod, mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

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

  return {
    paths: { dir, file, lock },

    async read() {
      try {
        const raw = await readFile(file, "utf8");
        const info = JSON.parse(raw) as DaemonInfo;
        if (!alive(info.pid)) return null;
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
      mkdirSync(lock); // throws EEXIST if held
      return () => rmSync(lock, { recursive: true, force: true });
    },
  };
}
