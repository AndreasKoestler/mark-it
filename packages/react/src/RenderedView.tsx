import { useEffect, useMemo, useRef, type ReactElement } from "react";
import { MrsfController } from "@mrsf/rehype-mrsf/controller";
import { commentsForRender } from "@mark-it/core";
import { useMarkIt, useMarkItState } from "./MarkItProvider.js";
import { buildPipeline } from "./pipeline.js";

export function RenderedView() {
  const { source, documentPath } = useMarkIt();
  const { doc, revision } = useMarkItState();
  const containerRef = useRef<HTMLElement | null>(null);

  const tree = useMemo<ReactElement>(() => {
    const proc = buildPipeline({
      comments: commentsForRender(doc, source),
      documentPath,
      interactive: true,
    });
    const file = proc.processSync(source);
    return file.result as ReactElement;
  }, [source, documentPath, revision, doc]);

  useEffect(() => {
    if (!containerRef.current) return;
    const ctrl = new MrsfController(containerRef.current, {
      interactive: true,
      gutterPosition: "right",
      inlineHighlights: true,
    });
    return () => ctrl.destroy();
  }, [tree]);

  return (
    <article
      className="mi-rendered"
      data-testid="rendered-view"
      ref={(el) => {
        containerRef.current = el;
      }}
    >
      {tree}
    </article>
  );
}
