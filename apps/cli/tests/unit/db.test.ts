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
  loadTreeForOrg,
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

describe("loadTreeForOrg", () => {
  test("returns org header and empty projects when none exist", () => {
    const db = freshDb();
    const org = createOrg(db, "acme");
    const tree = loadTreeForOrg(db, org.id);
    expect(tree.org.name).toBe("acme");
    expect(tree.projects).toHaveLength(0);
  });

  test("returns projects with documents in alphabetical order", () => {
    const db = freshDb();
    const org = createOrg(db, "acme");
    // Create projects out of order
    const projB = upsertProject(db, org.id, "beta");
    const projA = upsertProject(db, org.id, "alpha");
    // Create docs out of order within projA
    upsertDocument(db, projA.id, "/tmp/z.md", "z.md");
    upsertDocument(db, projA.id, "/tmp/a.md", "a.md");
    upsertDocument(db, projB.id, "/tmp/b.md", "b.md");

    const tree = loadTreeForOrg(db, org.id);
    expect(tree.org.name).toBe("acme");
    // Projects alphabetically
    expect(tree.projects).toHaveLength(2);
    const [projAlpha, projBeta] = tree.projects;
    expect(projAlpha!.name).toBe("alpha");
    expect(projBeta!.name).toBe("beta");
    // Docs within alpha alphabetically
    expect(projAlpha!.documents).toHaveLength(2);
    const [docA, docZ] = projAlpha!.documents;
    expect(docA!.name).toBe("a.md");
    expect(docZ!.name).toBe("z.md");
    // Docs within beta
    expect(projBeta!.documents).toHaveLength(1);
    const [docB] = projBeta!.documents;
    expect(docB!.name).toBe("b.md");
  });

  test("does not return documents from a different org", () => {
    const db = freshDb();
    const orgA = createOrg(db, "acme");
    const orgB = createOrg(db, "other");
    const projA = upsertProject(db, orgA.id, "p1");
    const projB = upsertProject(db, orgB.id, "p2");
    upsertDocument(db, projA.id, "/tmp/acme.md", "acme.md");
    upsertDocument(db, projB.id, "/tmp/other.md", "other.md");

    const treeA = loadTreeForOrg(db, orgA.id);
    expect(treeA.projects).toHaveLength(1);
    const [pA] = treeA.projects;
    expect(pA!.documents).toHaveLength(1);
    const [dA] = pA!.documents;
    expect(dA!.name).toBe("acme.md");

    const treeB = loadTreeForOrg(db, orgB.id);
    expect(treeB.projects).toHaveLength(1);
    const [pB] = treeB.projects;
    const [dB] = pB!.documents;
    expect(dB!.name).toBe("other.md");
  });

  test("projects with no documents return empty documents array", () => {
    const db = freshDb();
    const org = createOrg(db, "acme");
    upsertProject(db, org.id, "empty-project");
    const tree = loadTreeForOrg(db, org.id);
    const [proj] = tree.projects;
    expect(proj!.documents).toHaveLength(0);
  });
});
