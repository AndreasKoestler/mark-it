import type { IncomingMessage, ServerResponse } from "node:http";

export type AuthCheck = (req: IncomingMessage, res: ServerResponse) => boolean;

export function makeAuthCheck(token: string): AuthCheck {
  return function checkAuth(req, res) {
    const header = req.headers["x-mark-it-token"];
    const url = new URL(req.url ?? "", "http://localhost");
    const qp = url.searchParams.get("token");
    const got = (typeof header === "string" ? header : qp) ?? "";
    if (got !== token) {
      res.statusCode = 401;
      res.end("unauthorized");
      return false;
    }
    return true;
  };
}
