import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

export function resolveDbPath(opts: { db?: string }): string {
  const raw =
    opts.db ??
    process.env.MARK_IT_DB_PATH ??
    resolve(homedir(), ".mark-it", "mark-it.db");
  const abs = resolve(raw);
  mkdirSync(dirname(abs), { recursive: true });
  return abs;
}

export function migrationsDir(): string {
  return new URL("../../db/migrations/", import.meta.url).pathname;
}
