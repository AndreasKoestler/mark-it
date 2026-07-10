import { Database } from "bun:sqlite";

export type Db = Database;

export function openDatabase(dbPath: string): Db {
  const db = new Database(dbPath, { create: true });
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  // Queue concurrent writers briefly instead of failing with "database is locked".
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}
