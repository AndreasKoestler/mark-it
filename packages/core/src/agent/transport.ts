import type { Comment } from "../sidemark.js";

export interface AgentPayload {
  /**
   * Path of the document being reviewed (relative when known).
   * `content` is intentionally unused by current transports/formatters —
   * kept optional for forward-compat callers that still attach it.
   */
  document: { path: string; content?: string };
  /** Comments to send. Replies appear after their parents in input order. */
  comments: Comment[];
  /** "single" if the user picked one thread; "all" if it's a bulk action. */
  intent: "single" | "all";
  /**
   * Comment ids that should be marked resolved atomically with the send.
   * Transports that talk to a backend can hand this off so the resolve and
   * the dispatch happen together (no client-side race).
   */
  resolveIds?: string[];
}

export interface AgentTransport {
  name: string;
  send(payload: AgentPayload): Promise<void>;
}
