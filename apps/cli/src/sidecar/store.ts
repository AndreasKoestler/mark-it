import { existsSync } from "node:fs";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import type { MrsfDocument } from "@mrsf/cli";
import { parseSidecar, writeSidecar } from "@mrsf/cli";
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
    const parsed = await parseSidecar(this.sidecarPath);
    if (!Array.isArray(parsed.comments)) parsed.comments = [];
    return parsed;
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
    const parsed = yamlParse(blob) as MrsfDocument;
    if (!Array.isArray(parsed.comments)) parsed.comments = [];
    return parsed;
  }

  async save(doc: MrsfDocument): Promise<void> {
    saveSidecarBlob(this.db, this.documentId, yamlStringify(doc));
  }
}
