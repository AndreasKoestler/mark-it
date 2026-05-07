import { openDatabase, type Db } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";
import { resolveDbPath, migrationsDir } from "../db/paths.js";
import { findOrgByName, type OrgRow } from "../db/queries.js";

export function openDbForCommand(args: { db?: string }): { db: Db; dbPath: string } {
  const dbPath = resolveDbPath({ db: args.db });
  const db = openDatabase(dbPath);
  runMigrations(db, migrationsDir());
  return { db, dbPath };
}

export function requireOrg(db: Db, name: string): OrgRow {
  const row = findOrgByName(db, name);
  if (!row) {
    console.error(`mark-it: org "${name}" does not exist`);
    process.exit(1);
  }
  return row;
}

export function normaliseHandle(raw: string): string {
  return raw.startsWith("@") ? raw : `@${raw}`;
}
