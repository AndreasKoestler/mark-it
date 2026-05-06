import { useMarkIt } from "./MarkItProvider.js";
import { RenderedView } from "./RenderedView.js";
import { RawView } from "./RawView.js";

export function Document() {
  const { viewMode } = useMarkIt();
  return viewMode === "rendered" ? <RenderedView /> : <RawView />;
}
