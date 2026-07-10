import { basename } from "node:path";
import { openDatabase, type Db } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";
import { resolveDbPath, migrationsDir } from "../db/paths.js";
import {
  findOrgByName,
  findUserByHandle,
  upsertProject,
  upsertDocument,
  type OrgRow,
} from "../db/queries.js";
import type { Session } from "../server.js";

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

export interface DbBackedDoc {
  session: Session;
  documentId: string;
  documentName: string;
  projectId: string;
  projectName: string;
}

/**
 * Shared by `open` and `review` for `--org/--project/--user` invocations:
 * validates org membership, upserts the project/document rows, and returns
 * the resolved Session alongside the document identity. Building the
 * session here (rather than duplicating this block per-command) is what
 * guarantees a caller can't resolve a user but forget to carry the session
 * through to wherever identity needs to be enforced.
 */
export function resolveDbBackedDoc(
  db: Db,
  args: { org: string; project: string; user: string; "doc-name"?: string },
  filePath: string,
): DbBackedDoc {
  const org = requireOrg(db, args.org);
  const handle = normaliseHandle(args.user);
  const user = findUserByHandle(db, org.id, handle);
  if (!user) {
    console.error(`mark-it: user ${handle} is not a member of org ${org.name}`);
    process.exit(1);
  }
  const project = upsertProject(db, org.id, args.project);
  const docName = args["doc-name"] ?? basename(filePath);
  const document = upsertDocument(db, project.id, filePath, docName);
  return {
    session: {
      orgId: org.id,
      orgName: org.name,
      userId: user.id,
      userHandle: user.handle,
    },
    documentId: document.id,
    documentName: document.name,
    projectId: project.id,
    projectName: project.name,
  };
}
