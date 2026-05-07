import type { Plugin } from "vite";
import { makeAuthCheck } from "./auth.js";

/**
 * Vite plugin that enforces token auth on every `/api/*` request. Other
 * routes (the bundled HTML, JS, asset files Vite serves) are left alone
 * so the browser can load the page itself.
 */
export function markItAuthPlugin(token: string): Plugin {
  const check = makeAuthCheck(token);
  return {
    name: "mark-it-auth",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith("/api")) {
          next();
          return;
        }
        if (check(req, res)) next();
      });
    },
  };
}
