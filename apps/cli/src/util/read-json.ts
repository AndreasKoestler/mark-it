import type { IncomingMessage } from "node:http";

const DEFAULT_MAX_BYTES = 1_048_576; // 1 MiB

/**
 * Read and parse a JSON request body with a hard size cap so a runaway
 * client can't OOM the daemon.
 */
export async function readJson<T>(
  req: IncomingMessage,
  opts: { maxBytes?: number } = {},
): Promise<T> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    total += buf.length;
    if (total > maxBytes) {
      throw new Error(`request body exceeds ${maxBytes} bytes`);
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) throw new Error("empty request body");
  return JSON.parse(raw) as T;
}
