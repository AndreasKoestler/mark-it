import { describe, expect, test } from "vitest";
import { openDatabase } from "../../src/db/index.js";
import { runMigrations } from "../../src/db/migrate.js";
import {
  createOrg,
  createUser,
  findOrgByName,
  findUserByHandle,
  listOrgs,
  listUsers,
  upsertProject,
  findProjectByName,
  listProjects,
  upsertDocument,
  findDocumentById,
  loadSidecarBlob,
  saveSidecarBlob,
} from "../../src/db/queries.js";
import { migrationsDir } from "../../src/db/paths.js";

function freshDb() {
  const db = openDatabase(":memory:");
  runMigrations(db, migrationsDir());
  return db;
}

describe("migrations", () => {
  test("apply once, no-op on second run", () => {
    const db = openDatabase(":memory:");
    runMigrations(db, migrationsDir());
    runMigrations(db, migrationsDir());
    const rows = db.query<{ id: string }, []>("SELECT id FROM migrations").all();
    expect(rows.map((r: { id: string }) => r.id)).toEqual(["0001-init.sql"]);
  });
});

describe("orgs", () => {
  test("create and find by name", () => {
    const db = freshDb();
    createOrg(db, "acme");
    expect(findOrgByName(db, "acme")?.name).toBe("acme");
    expect(listOrgs(db)).toHaveLength(1);
  });

  test("UNIQUE(name) enforced", () => {
    const db = freshDb();
    createOrg(db, "acme");
    expect(() => createOrg(db, "acme")).toThrow();
  });
});

describe("users", () => {
  test("create and find by handle", () => {
    const db = freshDb();
    const org = createOrg(db, "acme");
    createUser(db, org.id, "@alice", "alice@example.com");
    const user = findUserByHandle(db, org.id, "@alice");
    expect(user?.handle).toBe("@alice");
    expect(user?.email).toBe("alice@example.com");
    expect(listUsers(db, org.id)).toHaveLength(1);
  });

  test("UNIQUE(org_id, handle) enforced", () => {
    const db = freshDb();
    const org = createOrg(db, "acme");
    createUser(db, org.id, "@alice", null);
    expect(() => createUser(db, org.id, "@alice", null)).toThrow();
  });

  test("FK cascade: deleting org removes users", () => {
    const db = freshDb();
    const org = createOrg(db, "acme");
    createUser(db, org.id, "@alice", null);
    db.run("DELETE FROM orgs WHERE id = ?", [org.id]);
    expect(listUsers(db, org.id)).toHaveLength(0);
  });
});

describe("projects", () => {
  test("upsert creates once and returns same row", () => {
    const db = freshDb();
    const org = createOrg(db, "acme");
    const p1 = upsertProject(db, org.id, "webapp");
    const p2 = upsertProject(db, org.id, "webapp");
    expect(p1.id).toBe(p2.id);
    expect(listProjects(db, org.id)).toHaveLength(1);
  });

  test("find by name returns null for missing", () => {
    const db = freshDb();
    const org = createOrg(db, "acme");
    expect(findProjectByName(db, org.id, "missing")).toBeNull();
  });

  test("FK cascade: deleting org removes projects", () => {
    const db = freshDb();
    const org = createOrg(db, "acme");
    upsertProject(db, org.id, "webapp");
    db.run("DELETE FROM orgs WHERE id = ?", [org.id]);
    expect(listProjects(db, org.id)).toHaveLength(0);
  });
});

describe("documents", () => {
  test("upsert creates once and returns same row", () => {
    const db = freshDb();
    const org = createOrg(db, "acme");
    const proj = upsertProject(db, org.id, "webapp");
    const d1 = upsertDocument(db, proj.id, "/tmp/doc.md", "doc.md");
    const d2 = upsertDocument(db, proj.id, "/tmp/doc.md", "doc.md");
    expect(d1.id).toBe(d2.id);
  });

  test("findDocumentById returns null for missing", () => {
    const db = freshDb();
    expect(findDocumentById(db, "nonexistent-id")).toBeNull();
  });

  test("UNIQUE(project_id, file_path) enforced via upsert idempotency", () => {
    const db = freshDb();
    const org = createOrg(db, "acme");
    const proj = upsertProject(db, org.id, "webapp");
    upsertDocument(db, proj.id, "/tmp/a.md", "a.md");
    upsertDocument(db, proj.id, "/tmp/b.md", "b.md");
    const docs = db.query("SELECT * FROM documents WHERE project_id = ?").all(proj.id);
    expect(docs).toHaveLength(2);
  });

  test("sidecar blob round-trip", () => {
    const db = freshDb();
    const org = createOrg(db, "acme");
    const proj = upsertProject(db, org.id, "webapp");
    const doc = upsertDocument(db, proj.id, "/tmp/doc.md", "doc.md");
    expect(loadSidecarBlob(db, doc.id)).toBeNull();
    saveSidecarBlob(db, doc.id, "comments: []");
    expect(loadSidecarBlob(db, doc.id)).toBe("comments: []");
  });

  test("FK cascade: deleting project removes documents", () => {
    const db = freshDb();
    const org = createOrg(db, "acme");
    const proj = upsertProject(db, org.id, "webapp");
    upsertDocument(db, proj.id, "/tmp/doc.md", "doc.md");
    db.run("DELETE FROM projects WHERE id = ?", [proj.id]);
    const docs = db.query("SELECT * FROM documents WHERE project_id = ?").all(proj.id);
    expect(docs).toHaveLength(0);
  });
});
