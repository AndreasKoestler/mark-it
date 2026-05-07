import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  MarkItProvider,
  Document,
  Toolbar,
  CommentSidebar,
  SplitView,
  type CommentApi,
  type CommentAddInput,
  type CommentEditInput,
  type CommentReplyInput,
} from "@mark-it/react";
import "@mark-it/react/theme.css";
import "@mrsf/rehype-mrsf/style.css";
import { HttpAgentTransport, type AgentTransport, type MrsfDocument } from "@mark-it/core";

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
    // Tell the server we're leaving as soon as the tab is closing. pagehide
    // fires for normal closes, navigation, and bfcache evictions; sendBeacon
    // is queued by the browser even during unload, so the server gets the
    // signal even though the page is gone.
    const bye = () => {
      navigator.sendBeacon("/api/bye");
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
    return [new HttpAgentTransport({ url: "/api/agent" })];
  }, []);

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
        <SplitView left={<Document />} right={<CommentSidebar />} />
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
