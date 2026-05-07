import { useRef, useState, useCallback, type ReactNode } from "react";

export interface SplitViewProps {
  /** Optional left pane (e.g. tree). When undefined, renders the two-column layout. */
  leftPane?: ReactNode;
  left: ReactNode;
  right: ReactNode;
  defaultLeftWidth?: number;
  minLeftWidth?: number;
  maxLeftWidth?: number;
  defaultRightWidth?: number;
  minRightWidth?: number;
  maxRightWidth?: number;
}

export function SplitView({
  leftPane,
  left,
  right,
  defaultLeftWidth = 220,
  minLeftWidth = 140,
  maxLeftWidth = 400,
  defaultRightWidth = 320,
  minRightWidth = 200,
  maxRightWidth = 600,
}: SplitViewProps) {
  const [leftWidth, setLeftWidth] = useState(defaultLeftWidth);
  const [rightWidth, setRightWidth] = useState(defaultRightWidth);
  const draggingLeft = useRef(false);
  const dragging = useRef(false);

  const onMouseDownLeft = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    draggingLeft.current = true;
    const startX = e.clientX;
    const startWidth = leftWidth;
    const onMove = (me: MouseEvent) => {
      if (!draggingLeft.current) return;
      const delta = me.clientX - startX;
      const next = Math.min(maxLeftWidth, Math.max(minLeftWidth, startWidth + delta));
      setLeftWidth(next);
    };
    const onUp = () => {
      draggingLeft.current = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [leftWidth, maxLeftWidth, minLeftWidth]);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    const startX = e.clientX;
    const startWidth = rightWidth;
    const onMove = (me: MouseEvent) => {
      if (!dragging.current) return;
      const delta = startX - me.clientX;
      const next = Math.min(maxRightWidth, Math.max(minRightWidth, startWidth + delta));
      setRightWidth(next);
    };
    const onUp = () => {
      dragging.current = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [rightWidth, maxRightWidth, minRightWidth]);

  if (leftPane === undefined) {
    // Two-column legacy layout
    const gridTemplate = `minmax(0, 1fr) 6px ${rightWidth}px`;
    return (
      <div
        className="mi-split"
        style={{ display: "grid", gridTemplateColumns: gridTemplate, alignItems: "start" }}
      >
        <div className="mi-split-main">{left}</div>
        <div
          className="mi-split-resizer"
          onMouseDown={onMouseDown}
          role="separator"
          aria-orientation="vertical"
        />
        <div className="mi-split-right">{right}</div>
      </div>
    );
  }

  // Three-column layout with tree pane
  const gridTemplate = `${leftWidth}px 6px minmax(0, 1fr) 6px ${rightWidth}px`;
  return (
    <div
      className="mi-split"
      style={{ display: "grid", gridTemplateColumns: gridTemplate, alignItems: "start" }}
    >
      <div className="mi-split-left" data-testid="tree-pane">{leftPane}</div>
      <div
        className="mi-split-resizer mi-split-resizer-left"
        onMouseDown={onMouseDownLeft}
        role="separator"
        aria-orientation="vertical"
      />
      <div className="mi-split-main">{left}</div>
      <div
        className="mi-split-resizer"
        onMouseDown={onMouseDown}
        role="separator"
        aria-orientation="vertical"
      />
      <div className="mi-split-right">{right}</div>
    </div>
  );
}
