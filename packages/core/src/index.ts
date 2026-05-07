export const VERSION = "0.0.0";

export {
  splitFrontmatter,
  countYamlKeys,
  type FrontmatterSplit,
} from "./frontmatter.js";

export {
  emptyDocument,
  commentsForRender,
  isOrphanedAnchor,
  PERFECT_SCORE,
  MRSF_HIGH_THRESHOLD,
  type MrsfDocument,
  type Comment,
} from "./sidemark.js";

export {
  createStore,
  createMarkItStore,
  setDoc,
  openDraft,
  closeDraft,
  openEdit,
  closeEdit,
  type DraftAnchor,
  type MarkItState,
  type Store,
  type Subscriber,
} from "./store.js";

export {
  formatForAgent,
  ClipboardTransport,
  HttpAgentTransport,
  type ClipboardTransportOptions,
  type HttpAgentTransportOptions,
  type AgentPayload,
  type AgentTransport,
} from "./agent/index.js";
