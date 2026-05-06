import { useMemo } from "react";
import { splitFrontmatter } from "@mark-it/core";
import { useMarkIt } from "./MarkItProvider.js";

export function RawView() {
  const { source } = useMarkIt();

  const { yaml, body, keyCount, frontmatterLineCount } = useMemo(() => {
    const split = splitFrontmatter(source);
    return {
      yaml: split.yaml,
      body: split.body,
      keyCount: split.keyCount,
      frontmatterLineCount: split.lineCount,
    };
  }, [source]);

  const bodyLines = body.split(/\r?\n/);

  return (
    <pre className="mi-raw" data-testid="raw-view">
      {yaml !== null && (
        <details className="mi-frontmatter">
          <summary className="mi-frontmatter-summary">
            frontmatter ({keyCount})
          </summary>
          <code className="language-yaml">{yaml}</code>
        </details>
      )}
      {bodyLines.map((line, idx) => (
        <span
          key={idx}
          className="mi-raw-line"
          data-line={frontmatterLineCount + idx + 1}
        >
          {line}
          {"\n"}
        </span>
      ))}
    </pre>
  );
}
