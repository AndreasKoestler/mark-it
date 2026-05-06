import type { MrsfDocument } from "@mrsf/cli";

export function emptyDocument(documentPath: string): MrsfDocument {
  return {
    mrsf_version: "1.0",
    document: documentPath,
    comments: [],
  };
}

export type { MrsfDocument } from "@mrsf/cli";
export type { Comment } from "@mrsf/cli";
