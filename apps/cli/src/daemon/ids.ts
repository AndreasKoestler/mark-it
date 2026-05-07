import { createHash } from "node:crypto";
import type { ActiveDocumentSpec } from "../server.js";

export function docIdForLegacyPath(absPath: string): string {
  const hash = createHash("sha256").update(absPath).digest("hex").slice(0, 16);
  return `legacy-${hash}`;
}

export function docIdForSpec(spec: ActiveDocumentSpec): string {
  return spec.documentId ?? docIdForLegacyPath(spec.filePath);
}
