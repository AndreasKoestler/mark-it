import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import type { ActiveDocumentSpec } from "../server.js";

/**
 * Canonicalize so symlink / case-only spelling variants map to one docId.
 * Falls back to the input path when the file does not exist yet (e.g. stdin
 * temp paths mid-write).
 */
function canonicalize(absPath: string): string {
  try {
    return realpathSync(absPath);
  } catch {
    return absPath;
  }
}

export function docIdForLegacyPath(absPath: string): string {
  const hash = createHash("sha256").update(canonicalize(absPath)).digest("hex").slice(0, 16);
  return `legacy-${hash}`;
}

export function docIdForSpec(spec: ActiveDocumentSpec): string {
  return spec.documentId ?? docIdForLegacyPath(spec.filePath);
}
