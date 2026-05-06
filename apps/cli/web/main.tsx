import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  MarkItProvider,
  Document,
  Toolbar,
  CommentSidebar,
  type CommentApi,
  type CommentAddInput,
  type CommentReplyInput,
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

const AUTHOR = "Andreas Koestler (andreas@example.com)";

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
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      const [doc, sc] = await Promise.all([
        fetch("/api/document").then((r) => r.json() as Promise<DocumentPayload>),
        fetch("/api/sidecar").then((r) => r.json() as Promise<SidecarPayload>),
      ]);
      if (cancelled) return;
      setDocPayload(doc);
      setSidecar(sc.doc);
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

  return (
    <div className="mi-root">
      <MarkItProvider
        source={docPayload.content}
        documentPath={docPayload.path}
        documentName={docPayload.name}
        author={AUTHOR}
        doc={sidecar}
        commentApi={commentApi}
        transports={transports}
      >
        <Toolbar />
        <section className="mi-content">
          <Document />
          <CommentSidebar />
        </section>
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
