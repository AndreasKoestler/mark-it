import { useMarkIt, type ViewMode } from "./MarkItProvider.js";

const MODES: ReadonlyArray<{ id: ViewMode; label: string }> = [
  { id: "rendered", label: "Rendered" },
  { id: "raw", label: "Raw" },
];

export function ViewToggle() {
  const { viewMode, setViewMode } = useMarkIt();
  return (
    <div className="mi-view-toggle" role="tablist" data-testid="view-toggle">
      {MODES.map((m) => (
        <button
          key={m.id}
          role="tab"
          type="button"
          aria-selected={viewMode === m.id}
          data-active={viewMode === m.id}
          data-testid={`view-toggle-${m.id}`}
          onClick={() => setViewMode(m.id)}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}
