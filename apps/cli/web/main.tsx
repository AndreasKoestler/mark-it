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
  type CommentReplyInput,
  type TreePayload,
  type TreeDocument,
} from "@mark-it/react";
import "@mark-it/react/theme.css";
import "@mrsf/rehype-mrsf/style.css";
import { ClipboardTransport, type MrsfDocument } from "@mark-it/core";

declare const __MARK_IT_FILE_NAME__: string;

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

const LEGACY_AUTHOR = "Andreas Koestler (andreas@example.com)";

async function postSidecar(action: string, payload: unknown): Promise<MrsfDocument> {
  const res = await fetch("/api/sidecar", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
    async function refresh() {
      const [doc, sc, ss, tr] = await Promise.all([
        fetch("/api/document").then((r) => r.json() as Promise<DocumentPayload>),
        fetch("/api/sidecar").then((r) => r.json() as Promise<SidecarPayload>),
        fetch("/api/session").then((r) => r.json() as Promise<SessionPayload>),
        fetch("/api/tree").then((r) => r.json() as Promise<TreePayload>),
      ]);
      if (cancelled) return;
      setDocPayload(doc);
      setSidecar(sc.doc);
      setSession(ss);
      setTree(tr);
    }
    refresh().catch((e) => setError(String(e)));

    const es = new EventSource("/api/events");
    es.addEventListener("change", () => {
      refresh().catch((e) => setError(String(e)));
    });
    return () => {
      cancelled = true;
      es.close();
    };
  }, []);

  const commentApi = useMemo<CommentApi>(() => ({
    add: (input: CommentAddInput) => postSidecar("add", input),
    reply: (input: CommentReplyInput) => postSidecar("reply", input),
    resolve: (commentId: string) => postSidecar("resolve", { commentId }),
    unresolve: (commentId: string) => postSidecar("unresolve", { commentId }),
    delete: (commentId: string) => postSidecar("delete", { commentId }),
    resolveAll: () => postSidecar("resolveAll", {}),
  }), []);

  const transports = useMemo(() => [new ClipboardTransport()], []);

  async function selectDoc(d: TreeDocument) {
    const res = await fetch("/api/document/select", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
