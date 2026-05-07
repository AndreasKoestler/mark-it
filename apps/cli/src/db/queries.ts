import { randomUUID } from "node:crypto";
import type { Db } from "./index.js";

export interface OrgRow { id: string; name: string; created_at: string; }
export interface UserRow { id: string; org_id: string; handle: string; email: string | null; created_at: string; }
export interface ProjectRow { id: string; org_id: string; name: string; created_at: string; }
export interface DocumentRow {
  id: string; project_id: string; name: string; file_path: string;
  sidecar_yaml: string | null; created_at: string; updated_at: string;
}

export function createOrg(db: Db, name: string): OrgRow {
  const id = randomUUID();
  db.run("INSERT INTO orgs (id, name) VALUES (?, ?)", [id, name]);
  return findOrgById(db, id)!;
}

export function findOrgByName(db: Db, name: string): OrgRow | null {
  return db.query<OrgRow, [string]>("SELECT * FROM orgs WHERE name = ?").get(name) ?? null;
}

export function findOrgById(db: Db, id: string): OrgRow | null {
  return db.query<OrgRow, [string]>("SELECT * FROM orgs WHERE id = ?").get(id) ?? null;
}

export function listOrgs(db: Db): OrgRow[] {
  return db.query<OrgRow, []>("SELECT * FROM orgs ORDER BY name").all();
}

export function createUser(db: Db, orgId: string, handle: string, email: string | null): UserRow {
  const id = randomUUID();
  db.run("INSERT INTO users (id, org_id, handle, email) VALUES (?, ?, ?, ?)", [id, orgId, handle, email]);
  return findUserById(db, id)!;
}

function findUserById(db: Db, id: string): UserRow | null {
  return db.query<UserRow, [string]>("SELECT * FROM users WHERE id = ?").get(id) ?? null;
}

export function findUserByHandle(db: Db, orgId: string, handle: string): UserRow | null {
  return db.query<UserRow, [string, string]>("SELECT * FROM users WHERE org_id = ? AND handle = ?").get(orgId, handle) ?? null;
}

export function listUsers(db: Db, orgId: string): UserRow[] {
  return db.query<UserRow, [string]>("SELECT * FROM users WHERE org_id = ? ORDER BY handle").all(orgId);
}

export function findProjectByName(db: Db, orgId: string, name: string): ProjectRow | null {
  return db.query<ProjectRow, [string, string]>("SELECT * FROM projects WHERE org_id = ? AND name = ?").get(orgId, name) ?? null;
}

export function upsertProject(db: Db, orgId: string, name: string): ProjectRow {
  const existing = findProjectByName(db, orgId, name);
  if (existing) return existing;
  const id = randomUUID();
  db.run("INSERT INTO projects (id, org_id, name) VALUES (?, ?, ?)", [id, orgId, name]);
  return db.query<ProjectRow, [string]>("SELECT * FROM projects WHERE id = ?").get(id)!;
}

export function listProjects(db: Db, orgId: string): ProjectRow[] {
  return db.query<ProjectRow, [string]>("SELECT * FROM projects WHERE org_id = ? ORDER BY name").all(orgId);
}

export function upsertDocument(
  db: Db,
  projectId: string,
  filePath: string,
  name: string,
): DocumentRow {
  const existing = db.query<DocumentRow, [string, string]>(
    "SELECT * FROM documents WHERE project_id = ? AND file_path = ?",
  ).get(projectId, filePath);
  if (existing) return existing;
  const id = randomUUID();
  db.run(
    "INSERT INTO documents (id, project_id, file_path, name) VALUES (?, ?, ?, ?)",
    [id, projectId, filePath, name],
  );
  return db.query<DocumentRow, [string]>("SELECT * FROM documents WHERE id = ?").get(id)!;
}

export function findDocumentById(db: Db, id: string): DocumentRow | null {
  return db.query<DocumentRow, [string]>("SELECT * FROM documents WHERE id = ?").get(id) ?? null;
}

export function loadSidecarBlob(db: Db, documentId: string): string | null {
  const row = db.query<{ sidecar_yaml: string | null }, [string]>(
    "SELECT sidecar_yaml FROM documents WHERE id = ?",
  ).get(documentId);
  return row?.sidecar_yaml ?? null;
}

export function saveSidecarBlob(db: Db, documentId: string, yaml: string): void {
  db.run(
    "UPDATE documents SET sidecar_yaml = ?, updated_at = datetime('now') WHERE id = ?",
    [yaml, documentId],
  );
}

export interface TreeNode {
  org: { id: string; name: string };
  projects: Array<{
    id: string;
    name: string;
    documents: Array<{ id: string; name: string; file_path: string }>;
  }>;
}

export function loadTreeForOrg(db: Db, orgId: string): TreeNode {
  const org = findOrgById(db, orgId)!;
  const projects = db.query<{ id: string; name: string }, [string]>(
    "SELECT id, name FROM projects WHERE org_id = ? ORDER BY name"
  ).all(orgId);
  const docs = db.query<
    { id: string; project_id: string; name: string; file_path: string },
    [string]
  >(
    `SELECT d.id, d.project_id, d.name, d.file_path
     FROM documents d
     JOIN projects p ON p.id = d.project_id
     WHERE p.org_id = ?
     ORDER BY d.name`
  ).all(orgId);

  const docsByProject = new Map<string, typeof docs>();
  for (const d of docs) {
    const arr = docsByProject.get(d.project_id) ?? [];
    arr.push(d);
    docsByProject.set(d.project_id, arr);
  }
  return {
    org: { id: org.id, name: org.name },
    projects: projects.map((p) => ({
      id: p.id,
      name: p.name,
      documents: (docsByProject.get(p.id) ?? []).map((d) => ({
        id: d.id, name: d.name, file_path: d.file_path,
      })),
    })),
  };
}
