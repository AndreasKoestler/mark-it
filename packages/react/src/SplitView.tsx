import { useEffect, useRef, useState, type ReactNode } from "react";

export interface SplitViewProps {
  /** Optional left pane (e.g. tree). When undefined, renders the two-column layout. */
  leftPane?: ReactNode;
  left: ReactNode;
  right: ReactNode;
  /** Initial right-pane width in px. Default: 340. */
  defaultRightWidth?: number;
  /** Minimum right-pane width in px. Default: 220. */
  minRightWidth?: number;
  /** Maximum right-pane width in px. Default: 720. */
  maxRightWidth?: number;
  /** Initial left-pane width in px. Default: 220. */
  defaultLeftWidth?: number;
  /** Minimum left-pane width in px. Default: 140. */
  minLeftWidth?: number;
  /** Maximum left-pane width in px. Default: 400. */
  maxLeftWidth?: number;
}

export function SplitView({
  leftPane,
  left,
  right,
  defaultRightWidth = 340,
  minRightWidth = 220,
  maxRightWidth = 720,
  defaultLeftWidth = 220,
  minLeftWidth = 140,
  maxLeftWidth = 400,
}: SplitViewProps) {
  const [width, setWidth] = useState(defaultRightWidth);
  const [leftWidth, setLeftWidth] = useState(defaultLeftWidth);
  const containerRef = useRef<HTMLElement | null>(null);
  const dragging = useRef<{ startX: number; startWidth: number } | null>(null);
  const draggingLeft = useRef<{ startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    function onMove(e: MouseEvent) {
      const d = dragging.current;
      if (d) {
        const delta = d.startX - e.clientX;
        const containerWidth = containerRef.current?.clientWidth ?? Infinity;
        const cap = Math.min(maxRightWidth, Math.max(minRightWidth, containerWidth - 240));
        setWidth(Math.max(minRightWidth, Math.min(cap, d.startWidth + delta)));
        return;
      }
      const dl = draggingLeft.current;
      if (dl) {
        const delta = e.clientX - dl.startX;
        setLeftWidth(Math.max(minLeftWidth, Math.min(maxLeftWidth, dl.startWidth + delta)));
      }
    }
    function onUp() {
      if (dragging.current || draggingLeft.current) {
        dragging.current = null;
        draggingLeft.current = null;
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
  }, [minRightWidth, maxRightWidth, minLeftWidth, maxLeftWidth]);

  const onMouseDownRight = (e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = { startX: e.clientX, startWidth: width };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  const onMouseDownLeft = (e: React.MouseEvent) => {
    e.preventDefault();
    draggingLeft.current = { startX: e.clientX, startWidth: leftWidth };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  const onKeyDownRight = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      setWidth((w) => Math.min(maxRightWidth, w + 16));
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      setWidth((w) => Math.max(minRightWidth, w - 16));
    }
  };

  const onKeyDownLeft = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowRight") {
      e.preventDefault();
      setLeftWidth((w) => Math.min(maxLeftWidth, w + 16));
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      setLeftWidth((w) => Math.max(minLeftWidth, w - 16));
    }
  };

  const gridTemplateColumns =
    leftPane !== undefined
      ? `${leftWidth}px 6px minmax(0, 1fr) 6px ${width}px`
      : `minmax(0, 1fr) 6px ${width}px`;

  return (
    <section
      className="mi-content"
      ref={(el) => {
        containerRef.current = el;
      }}
      style={{ gridTemplateColumns }}
      data-testid="split-view"
    >
      {leftPane !== undefined ? (
        <>
          <div data-testid="tree-pane">{leftPane}</div>
          <div
            className="mi-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize tree"
            tabIndex={0}
            data-testid="split-resizer-left"
            onMouseDown={onMouseDownLeft}
            onKeyDown={onKeyDownLeft}
          />
        </>
      ) : null}
      {left}
      <div
        className="mi-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        tabIndex={0}
        data-testid="split-resizer"
        onMouseDown={onMouseDownRight}
        onKeyDown={onKeyDownRight}
      />
      {right}
    </section>
  );
}
