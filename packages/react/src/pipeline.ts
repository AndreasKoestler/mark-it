import { unified, type Processor } from "unified";
import remarkParse from "remark-parse";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkRehype, { type Options as RemarkRehypeOptions } from "remark-rehype";
import rehypeReact, { type Options as RehypeReactOptions } from "rehype-react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { rehypeMrsf } from "@mrsf/rehype-mrsf";
import { countYamlKeys, type MrsfDocument } from "@mark-it/core";
import { rehypeBlockLines } from "./rehype-block-lines.js";

export interface BuildPipelineOptions {
  /** Sidemark/MRSF document to feed into rehype-mrsf. Omit to skip the comments layer. */
  comments?: MrsfDocument;
  /** Document path passed to rehype-mrsf for context. */
  documentPath?: string;
  /** Forward to rehype-mrsf — emits action attributes for the controller to wire up. */
  interactive?: boolean;
}

export function buildPipeline(opts: BuildPipelineOptions = {}): Processor {
  const handlers: NonNullable<RemarkRehypeOptions["handlers"]> = {
    yaml(_state, node: { value: string }) {
      const keys = countYamlKeys(node.value);
      return {
        type: "element",
        tagName: "details",
        properties: { className: ["mi-frontmatter"] },
        children: [
          {
            type: "element",
            tagName: "summary",
            properties: { className: ["mi-frontmatter-summary"] },
            children: [{ type: "text", value: `frontmatter (${keys})` }],
          },
          {
            type: "element",
            tagName: "pre",
            properties: { className: ["mi-frontmatter-body"] },
            children: [
              {
                type: "element",
                tagName: "code",
                properties: { className: ["language-yaml"] },
                children: [{ type: "text", value: node.value }],
              },
            ],
          },
        ],
      };
    },
  };

  let proc = unified()
    .use(remarkParse)
    .use(remarkFrontmatter, ["yaml"])
    .use(remarkGfm)
    .use(remarkRehype, { allowDangerousHtml: false, handlers })
    .use(rehypeBlockLines);

  if (opts.comments) {
    proc = proc.use(rehypeMrsf, {
      comments: opts.comments,
      documentPath: opts.documentPath,
      interactive: opts.interactive ?? true,
      gutterPosition: "right",
      inlineHighlights: true,
      theme: "auto",
    });
  }

  proc = proc.use(rehypeReact, {
    Fragment,
    jsx,
    jsxs,
  } satisfies RehypeReactOptions);

  return proc as Processor;
}
