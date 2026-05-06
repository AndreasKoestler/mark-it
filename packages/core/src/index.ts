export const VERSION = "0.0.0";

export {
  splitFrontmatter,
  countYamlKeys,
  type FrontmatterSplit,
} from "./frontmatter.js";

export {
  emptyDocument,
  type MrsfDocument,
  type Comment,
} from "./sidemark.js";

export {
  createStore,
  createMarkItStore,
  setDoc,
  openDraft,
  closeDraft,
  type DraftAnchor,
  type MarkItState,
  type Store,
  type Subscriber,
} from "./store.js";

export {
  formatForAgent,
  ClipboardTransport,
  type ClipboardTransportOptions,
  type AgentPayload,
  type AgentTransport,
} from "./agent/index.js";
