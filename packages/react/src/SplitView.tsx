import { useEffect, useRef, useState, type ReactNode } from "react";

export interface SplitViewProps {
  left: ReactNode;
  right: ReactNode;
  /** Initial right-pane width in px. Default: 340. */
  defaultRightWidth?: number;
  /** Minimum right-pane width in px. Default: 220. */
  minRightWidth?: number;
  /** Maximum right-pane width in px. Default: 720. */
  maxRightWidth?: number;
}

export function SplitView({
  left,
  right,
  defaultRightWidth = 340,
  minRightWidth = 220,
  maxRightWidth = 720,
}: SplitViewProps) {
  const [width, setWidth] = useState(defaultRightWidth);
  const containerRef = useRef<HTMLElement | null>(null);
  const dragging = useRef<{ startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    function onMove(e: MouseEvent) {
      const d = dragging.current;
      if (!d) return;
      const delta = d.startX - e.clientX;
      const containerWidth = containerRef.current?.clientWidth ?? Infinity;
      const cap = Math.min(maxRightWidth, Math.max(minRightWidth, containerWidth - 240));
      const next = Math.max(minRightWidth, Math.min(cap, d.startWidth + delta));
      setWidth(next);
    }
    function onUp() {
      if (dragging.current) {
        dragging.current = null;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      }
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [minRightWidth, maxRightWidth]);

  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = { startX: e.clientX, startWidth: width };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      setWidth((w) => Math.min(maxRightWidth, w + 16));
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      setWidth((w) => Math.max(minRightWidth, w - 16));
    }
  };

  return (
    <section
      className="mi-content"
      ref={(el) => {
        containerRef.current = el;
      }}
      style={{
        gridTemplateColumns: `minmax(0, 1fr) 6px ${width}px`,
      }}
      data-testid="split-view"
    >
      {left}
      <div
        className="mi-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        tabIndex={0}
        data-testid="split-resizer"
        onMouseDown={onMouseDown}
        onKeyDown={onKeyDown}
      />
      {right}
    </section>
  );
}
