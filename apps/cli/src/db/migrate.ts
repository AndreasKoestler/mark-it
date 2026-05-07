import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "./index.js";

export function runMigrations(db: Db, migrationsDir: string): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const applied = new Set(
    db.query<{ id: string }, []>("SELECT id FROM migrations").all().map((r: { id: string }) => r.id),
  );

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    const tx = db.transaction(() => {
      db.exec(sql);
      db.run("INSERT INTO migrations (id) VALUES (?)", [file]);
    });
    tx();
  }
}
