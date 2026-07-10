import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export type AuthCheck = (req: IncomingMessage, res: ServerResponse) => boolean;

function tokensEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    // Still run a compare against `b` so length leaks don't short-circuit
    // the constant-time path on equal-length secrets.
    timingSafeEqual(bb, bb);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

export function makeAuthCheck(token: string): AuthCheck {
  return function checkAuth(req, res) {
    const header = req.headers["x-mark-it-token"];
    const url = new URL(req.url ?? "", "http://localhost");
    const qp = url.searchParams.get("token");
    const got = (typeof header === "string" ? header : qp) ?? "";
    if (!tokensEqual(got, token)) {
      res.statusCode = 401;
      res.end("unauthorized");
      return false;
    }
    return true;
  };
}
