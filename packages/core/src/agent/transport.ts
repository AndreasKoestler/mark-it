import type { Comment } from "../sidemark.js";

export interface AgentPayload {
  /** Path of the document being reviewed (relative when known). */
  document: { path: string; content?: string };
  /** Comments to send. Replies appear after their parents in input order. */
  comments: Comment[];
  /** "single" if the user picked one thread; "all" if it's a bulk action. */
  intent: "single" | "all";
}

export interface AgentTransport {
  name: string;
  send(payload: AgentPayload): Promise<void>;
}
