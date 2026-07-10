import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  MarkItProvider,
  Document,
  Toolbar,
  CommentSidebar,
  SplitView,
  TreePane,
  type CommentApi,
  type CommentAddInput,
  type CommentEditInput,
  type CommentReplyInput,
  type TreePayload,
  type TreeDocument,
} from "@mark-it/react";
import "@mark-it/react/theme.css";
import "@mrsf/rehype-mrsf/style.css";
import { HttpAgentTransport, type AgentTransport, type MrsfDocument } from "@mark-it/core";

declare const __MARK_IT_FILE_NAME__: string;

// Per-doc routing in daemon mode is driven by `?doc=<id>` in the page URL.
// Token auth (also via the URL) is used by the daemon to gate /api/* —
// legacy startServer-mode pages have neither and fall through to the
// server's "active doc" + open-no-token semantics.
const URL_PARAMS = new URLSearchParams(window.location.search);
const DOC_ID = URL_PARAMS.get("doc") ?? "";
const TOKEN = URL_PARAMS.get("token") ?? "";

function withParams(path: string): string {
  if (!DOC_ID && !TOKEN) return path;
  const u = new URL(path, window.location.origin);
  if (DOC_ID && !u.searchParams.has("doc")) u.searchParams.set("doc", DOC_ID);
  if (TOKEN && !u.searchParams.has("token")) u.searchParams.set("token", TOKEN);
  return u.pathname + (u.search ? u.search : "");
}

const FETCH_HEADERS: HeadersInit = TOKEN ? { "X-Mark-It-Token": TOKEN } : {};

interface DocumentPayload {
  path: string;
  name: string;
  content: string;
}

interface SidecarPayload {
  doc: MrsfDocument;
  sidecarPath: string;
}

interface SessionPayload {
  legacy?: boolean;
  org?: { id: string; name: string };
  user?: { id: string; handle: string };
  active: {
    documentId?: string;
    documentName?: string;
    projectId?: string;
    projectName?: string;
    filePath: string;
  };
}

const LEGACY_AUTHOR = "Anonymous";

async function postSidecar(action: string, payload: unknown): Promise<MrsfDocument> {
  const res = await fetch(withParams("/api/sidecar"), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...FETCH_HEADERS },
    body: JSON.stringify({ action, payload }),
  });
  if (!res.ok) {
    const msg = await res.text();
    throw new Error(`${action} failed: ${msg}`);
  }
  const body = (await res.json()) as SidecarPayload;
  return body.doc;
}

function App() {
  const [docPayload, setDocPayload] = useState<DocumentPayload | null>(null);
  const [sidecar, setSidecar] = useState<MrsfDocument | null>(null);
  const [session, setSession] = useState<SessionPayload | null>(null);
  const [tree, setTree] = useState<TreePayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // A refresh() started by an older "change" event can still be in flight
    // when a newer one fires (e.g. rapid tree-pane doc switching). Track the
    // latest generation so a slow, superseded response can't partially
    // overwrite state a newer refresh() already applied.
    let latestGeneration = 0;
    const fetchOpts: RequestInit = { headers: FETCH_HEADERS };
    async function refresh() {
      const generation = ++latestGeneration;
      const [doc, sc, ss, tr] = await Promise.all([
        fetch(withParams("/api/document"), fetchOpts).then(
          (r) => r.json() as Promise<DocumentPayload>,
        ),
        fetch(withParams("/api/sidecar"), fetchOpts).then(
          (r) => r.json() as Promise<SidecarPayload>,
        ),
        fetch(withParams("/api/session"), fetchOpts).then(
          (r) => r.json() as Promise<SessionPayload>,
        ),
        fetch(withParams("/api/tree"), fetchOpts).then(
          (r) => r.json() as Promise<TreePayload>,
        ),
      ]);
      if (cancelled || generation !== latestGeneration) return;
      setDocPayload(doc);
      setSidecar(sc.doc);
      setSession(ss);
      setTree(tr);
    }
    refresh().catch((e) => setError(String(e)));

    // EventSource per spec cannot set request headers, so token auth rides
    // on `?token=` (set by withParams) and `?doc=<id>` scopes the stream.
    const es = new EventSource(withParams("/api/events"));
    es.addEventListener("change", () => {
      refresh().catch((e) => setError(String(e)));
    });
    es.addEventListener("focus", () => {
      try {
        window.focus();
      } catch {
        /* not all browsers permit programmatic focus; silently ignore */
      }
    });
    // Tell the server we're leaving as soon as the tab is closing. pagehide
    // fires for normal closes, navigation, and bfcache evictions; sendBeacon
    // is queued by the browser even during unload, so the server gets the
    // signal even though the page is gone.
    const bye = () => {
      navigator.sendBeacon(withParams("/api/bye"));
    };
    window.addEventListener("pagehide", bye);
    return () => {
      cancelled = true;
      es.close();
      window.removeEventListener("pagehide", bye);
    };
  }, []);

  const commentApi = useMemo<CommentApi>(() => ({
    add: (input: CommentAddInput) => postSidecar("add", input),
    reply: (input: CommentReplyInput) => postSidecar("reply", input),
    edit: (input: CommentEditInput) => postSidecar("edit", input),
    resolve: (commentId: string) => postSidecar("resolve", { commentId }),
    unresolve: (commentId: string) => postSidecar("unresolve", { commentId }),
    delete: (commentId: string, opts?: { cascade?: boolean }) =>
      postSidecar("delete", { commentId, cascade: opts?.cascade ?? false }),
    resolveAll: () => postSidecar("resolveAll", {}),
  }), []);

  const transports = useMemo<ReadonlyArray<AgentTransport>>(() => {
    // Test harness escape hatch: Playwright may install its own transport via
    // `window.__markItTestTransports` to avoid the server-exit behavior.
    const stub = (window as unknown as {
      __markItTestTransports?: ReadonlyArray<AgentTransport>;
    }).__markItTestTransports;
    if (Array.isArray(stub) && stub.length > 0) return stub;
    return [
      new HttpAgentTransport({
        url: withParams("/api/agent"),
        headers: FETCH_HEADERS,
      }),
    ];
  }, []);

  async function selectDoc(d: TreeDocument) {
    const res = await fetch(withParams("/api/document/select"), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...FETCH_HEADERS },
      body: JSON.stringify({ documentId: d.id }),
    });
    if (!res.ok) throw new Error(`select failed: ${await res.text()}`);
    // Server broadcasts SSE on success; the existing handler refreshes everything.
  }

  if (error) {
    return (
      <div className="mi-root" style={{ padding: "1rem", color: "tomato" }}>
        Failed to load: {error}
      </div>
    );
  }
  if (!docPayload || !sidecar) {
    return (
      <div className="mi-root" style={{ padding: "1rem", color: "var(--mi-muted)" }}>
        Loading {__MARK_IT_FILE_NAME__}…
      </div>
    );
  }

  const author = session?.user?.handle ?? LEGACY_AUTHOR;
  const userId = session?.user?.id ?? null;
  const activeDocumentId = session?.active?.documentId;
  const isDbMode = session && !session.legacy && tree && !("legacy" in tree && (tree as { legacy?: boolean }).legacy);

  return (
    <div className="mi-root">
      <MarkItProvider
        source={docPayload.content}
        documentPath={docPayload.path}
        documentName={docPayload.name}
        author={author}
        userId={userId}
        doc={sidecar}
        commentApi={commentApi}
        transports={transports}
      >
        <Toolbar />
        <SplitView
          leftPane={
            isDbMode && tree
              ? (
                <TreePane
                  tree={tree}
                  activeDocumentId={activeDocumentId}
                  onSelectDocument={selectDoc}
                />
              )
              : undefined
          }
          left={<Document />}
          right={<CommentSidebar />}
        />
      </MarkItProvider>
    </div>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(
  <StrictMode>
    <App />
  </StrictMode>,
);
