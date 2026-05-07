import { useState } from "react";

export interface TreeDocument {
  id: string;
  name: string;
  file_path: string;
  isActive?: boolean;
}

export interface TreeProject {
  id: string;
  name: string;
  documents: TreeDocument[];
}

export interface TreePayload {
  org: { id: string; name: string };
  projects: TreeProject[];
}

export interface TreePaneProps {
  tree: TreePayload;
  activeDocumentId?: string;
  onSelectDocument: (doc: TreeDocument) => void | Promise<void>;
}

export function TreePane({ tree, activeDocumentId, onSelectDocument }: TreePaneProps) {
  const [busyId, setBusyId] = useState<string | null>(null);
  return (
    <nav className="mi-tree" aria-label="Documents">
      <header className="mi-tree-org">{tree.org.name}</header>
      {tree.projects.map((p) => (
        <details
          key={p.id}
          className="mi-tree-project"
          open={p.documents.some((d) => d.id === activeDocumentId)}
        >
          <summary className="mi-tree-project-summary">{p.name}</summary>
          <ul className="mi-tree-doc-list">
            {p.documents.map((d) => (
              <li key={d.id}>
                <button
                  type="button"
                  className="mi-tree-doc"
                  data-active={d.id === activeDocumentId ? "" : undefined}
                  data-busy={busyId === d.id ? "" : undefined}
                  onClick={async () => {
                    setBusyId(d.id);
                    try {
                      await onSelectDocument(d);
                    } finally {
                      setBusyId(null);
                    }
                  }}
                >
                  {d.name}
                </button>
              </li>
            ))}
          </ul>
        </details>
      ))}
    </nav>
  );
}
