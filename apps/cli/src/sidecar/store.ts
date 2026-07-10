import { existsSync } from "node:fs";
import type { MrsfDocument } from "@mrsf/cli";
import { parseSidecarContentLenient, parseSidecarLenient, toYaml, writeSidecar } from "@mrsf/cli";
import { saveSidecarBlob, loadSidecarBlob } from "../db/queries.js";
import type { Db } from "../db/index.js";

export interface SidecarStore {
  load(): Promise<MrsfDocument>;
  save(doc: MrsfDocument): Promise<void>;
}

export class DiskSidecarStore implements SidecarStore {
  constructor(private readonly filePath: string, private readonly sidecarPath: string) {}

  async load(): Promise<MrsfDocument> {
    if (!existsSync(this.sidecarPath)) {
      return { mrsf_version: "1.0", document: this.filePath, comments: [] };
    }
    const result = await parseSidecarLenient(this.sidecarPath);
    if (result.doc) {
      if (!Array.isArray(result.doc.comments)) result.doc.comments = [];
      return result.doc;
    }
    // Corrupt/unparseable YAML — salvage whatever comments we can rather
    // than failing the whole document; the user can still see and fix the
    // underlying file, but at least the review session stays usable.
    console.error(`mark-it: sidecar at ${this.sidecarPath} failed to parse: ${result.error}`);
    return {
      mrsf_version: "1.0",
      document: this.filePath,
      comments: result.partialComments ?? [],
    };
  }

  async save(doc: MrsfDocument): Promise<void> {
    await writeSidecar(this.sidecarPath, doc);
  }
}

export class DbSidecarStore implements SidecarStore {
  constructor(
    private readonly db: Db,
    private readonly documentId: string,
    private readonly filePath: string,
  ) {}

  async load(): Promise<MrsfDocument> {
    const blob = loadSidecarBlob(this.db, this.documentId);
    if (!blob) return { mrsf_version: "1.0", document: this.filePath, comments: [] };
    const result = parseSidecarContentLenient(blob, this.filePath);
    if (result.doc) {
      if (!Array.isArray(result.doc.comments)) result.doc.comments = [];
      return result.doc;
    }
    console.error(`mark-it: sidecar blob for ${this.documentId} failed to parse: ${result.error}`);
    return {
      mrsf_version: "1.0",
      document: this.filePath,
      comments: result.partialComments ?? [],
    };
  }

  async save(doc: MrsfDocument): Promise<void> {
    saveSidecarBlob(this.db, this.documentId, toYaml(doc));
  }
}
