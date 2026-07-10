import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import type { Plugin } from "vite";
import type { ServerResponse } from "node:http";
import {
  addComment,
  editComment,
  resolveComment,
  unresolveComment,
  removeComment,
  type MrsfDocument,
  type AddCommentOptions,
  type Comment,
} from "@mrsf/cli";
import type { SessionRegistry, DocSession } from "../daemon/sessions.js";
import { resolveSession, type Session } from "../server.js";
import { readJson } from "../util/read-json.js";

class IdentityError extends Error {}

const SIDECAR_ACTIONS = [
  "add",
  "reply",
  "edit",
  "resolve",
  "unresolve",
  "delete",
  "resolveAll",
] as const;

type SidecarAction = (typeof SIDECAR_ACTIONS)[number];

/** Actions that require the request payload's author/actor to match the session. */
const AUTHOR_MATCH_ACTIONS = new Set<SidecarAction>(["add", "reply", "edit"]);

/** Actions that require the target comment to be owned by the session user. */
const OWNERSHIP_ACTIONS = new Set<SidecarAction>([
  "edit",
  "resolve",
  "unresolve",
  "delete",
]);

function parseSidecarAction(raw: unknown): SidecarAction {
  if (typeof raw === "string" && (SIDECAR_ACTIONS as readonly string[]).includes(raw)) {
    return raw as SidecarAction;
  }
  throw new Error(`Unknown action: ${String(raw)}`);
}

function enforceAuthorMatch(
  session: Session | null,
  action: SidecarAction,
  payload: unknown,
): void {
  if (!session) return;
  if (process.env.MARK_IT_ALLOW_AUTHOR_OVERRIDE === "1") return;
  if (!AUTHOR_MATCH_ACTIONS.has(action)) return;
  const p = payload as { author?: string; actor?: string; x_user_id?: string };
  const author = p.author ?? p.actor;
  if (author !== session.userHandle || p.x_user_id !== session.userId) {
    throw new IdentityError("403: identity mismatch");
  }
}

function enforceCommentOwnership(
  session: Session | null,
  action: SidecarAction,
  comment: Comment | undefined,
): void {
  if (!session) return;
  if (process.env.MARK_IT_ALLOW_AUTHOR_OVERRIDE === "1") return;
  if (!OWNERSHIP_ACTIONS.has(action)) return;
  if (!comment) return;
  const ext = comment as Comment & { x_user_id?: string };
  if (ext.author !== session.userHandle || ext.x_user_id !== session.userId) {
    throw new IdentityError(`403: cannot ${action} another user's comment`);
  }
}

function ownsComment(session: Session, comment: Comment): boolean {
  const ext = comment as Comment & { x_user_id?: string };
  return ext.author === session.userHandle && ext.x_user_id === session.userId;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

export function markItSidecarPlugin(registry: SessionRegistry): Plugin {
  return {
    name: "mark-it-sidecar",
    configureServer(server) {
      async function loadDoc(sess: DocSession): Promise<MrsfDocument> {
        const doc = await sess.sidecar.load();
        if (!doc.document) {
          doc.document = relative(process.cwd(), sess.spec.filePath);
        }
        return doc;
      }

      server.middlewares.use("/api/sidecar", async (req, res, next) => {
        const r = resolveSession(req, registry);
        if ("error" in r) {
          json(res, r.status, { error: r.error });
          return;
        }
        const sess = r.session;

        if (req.method === "GET") {
          try {
            // Watcher-driven re-anchoring is a latency optimization, not a
            // correctness path: editor swap-write patterns and bursty edits
            // can slip past chokidar. Re-checking on every GET ensures the
            // client never sees a stale anchor on refresh.
            await sess.ensureFreshAnchors();
            const doc = await loadDoc(sess);
            const sidecarPath = `${sess.spec.filePath}.review.yaml`;
            json(res, 200, { doc, sidecarPath });
          } catch (err) {
            json(res, 500, { error: String(err) });
          }
          return;
        }

        if (req.method === "POST") {
          try {
            const body = await readJson<{ action: unknown; payload?: unknown }>(req);
            const action = parseSidecarAction(body.action);
            const updated = await sess.withWriteLock(async () => {
              const doc = await loadDoc(sess);
              const result = await applyAction(
                doc,
                action,
                body.payload,
                sess.spec.filePath,
                sess.session,
              );
              await sess.sidecar.save(result);
              return result;
            });
            const sidecarPath = `${sess.spec.filePath}.review.yaml`;
            json(res, 200, { doc: updated, sidecarPath });
          } catch (err) {
            if (err instanceof IdentityError) {
              json(res, 403, { error: err.message });
              return;
            }
            json(res, 400, { error: String(err) });
          }
          return;
        }

        next();
      });
    },
  };
}

async function applyAction(
  doc: MrsfDocument,
  action: SidecarAction,
  payload: unknown,
  filePath: string,
  session: Session | null,
): Promise<MrsfDocument> {
  enforceAuthorMatch(session, action, payload);
  switch (action) {
    case "add": {
      const p = payload as Partial<AddCommentOptions> & {
        selected_text?: string;
        x_user_id?: string;
      };
      if (!p?.text || !p.author) throw new Error("add: text and author are required");
      const opts: AddCommentOptions = {
        text: p.text,
        author: p.author,
        line: p.line,
        end_line: p.end_line,
      };
      await addComment(doc, opts);
      const last = doc.comments[doc.comments.length - 1];
      if (last && p.line) {
        const docContent = await readFile(filePath, "utf8");
        const lines = docContent.split(/\r?\n/);
        const startIdx = (p.line ?? 1) - 1;
        const endIdx = (p.end_line ?? p.line ?? 1) - 1;
        const slice = lines.slice(startIdx, endIdx + 1).join("\n");
        // Only accept client-supplied selected_text when it actually occurs
        // at (or within) the stated line range; otherwise derive from source.
        if (p.selected_text && slice.includes(p.selected_text)) {
          last.selected_text = p.selected_text;
        } else if (slice) {
          last.selected_text = slice;
        }
      }
      if (last && p.x_user_id) {
        (last as Comment & { x_user_id?: string }).x_user_id = p.x_user_id;
      }
      return doc;
    }
    case "reply": {
      const p = payload as {
        parentId?: string;
        text?: string;
        author?: string;
        x_user_id?: string;
      };
      if (!p?.parentId || !p.text || !p.author) {
        throw new Error("reply: parentId, text, author are required");
      }
      const parent = doc.comments.find((c) => c.id === p.parentId);
      if (!parent) throw new Error(`reply: parent ${p.parentId} not found`);
      await addComment(doc, {
        text: p.text,
        author: p.author,
        line: parent.line,
        end_line: parent.end_line,
        reply_to: p.parentId,
      });
      const lastReply = doc.comments[doc.comments.length - 1];
      if (lastReply && p.x_user_id) {
        (lastReply as Comment & { x_user_id?: string }).x_user_id = p.x_user_id;
      }
      return doc;
    }
    case "edit": {
      const p = payload as {
        commentId?: string;
        text?: string;
        actor?: string;
        x_user_id?: string;
      };
      if (!p?.commentId || !p.text) {
        throw new Error("edit: commentId and text are required");
      }
      const target = doc.comments.find((c) => c.id === p.commentId);
      enforceCommentOwnership(session, action, target);
      editComment(doc, p.commentId, { text: p.text, actor: p.actor });
      if (p.x_user_id) {
        const after = doc.comments.find((c) => c.id === p.commentId);
        if (after) {
          (after as Comment & { x_user_id?: string }).x_user_id = p.x_user_id;
        }
      }
      return doc;
    }
    case "resolve": {
      const p = payload as { commentId?: string };
      if (!p?.commentId) throw new Error("resolve: commentId required");
      const target = doc.comments.find((c) => c.id === p.commentId);
      enforceCommentOwnership(session, action, target);
      if (!resolveComment(doc, p.commentId)) {
        throw new Error(`resolve: ${p.commentId} not found`);
      }
      return doc;
    }
    case "unresolve": {
      const p = payload as { commentId?: string };
      if (!p?.commentId) throw new Error("unresolve: commentId required");
      const target = doc.comments.find((c) => c.id === p.commentId);
      enforceCommentOwnership(session, action, target);
      if (!unresolveComment(doc, p.commentId)) {
        throw new Error(`unresolve: ${p.commentId} not found`);
      }
      return doc;
    }
    case "delete": {
      const p = payload as { commentId?: string; cascade?: boolean };
      if (!p?.commentId) throw new Error("delete: commentId required");
      const target = doc.comments.find((c) => c.id === p.commentId);
      enforceCommentOwnership(session, action, target);
      if (!removeComment(doc, p.commentId, { cascade: p.cascade ?? false })) {
        throw new Error(`delete: ${p.commentId} not found`);
      }
      return doc;
    }
    case "resolveAll": {
      if (session && process.env.MARK_IT_ALLOW_AUTHOR_OVERRIDE !== "1") {
        for (const c of doc.comments) {
          if (ownsComment(session, c)) c.resolved = true;
        }
      } else {
        for (const c of doc.comments) c.resolved = true;
      }
      return doc;
    }
  }
}
