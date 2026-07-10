import { formatForAgent } from "./formatter.js";
import type { AgentPayload, AgentTransport } from "./transport.js";

export interface HttpAgentTransportOptions {
  /** Endpoint that accepts POST { text, comments, resolveIds }. */
  url: string;
  format?: (payload: AgentPayload) => string;
  /** Fetch override (browser default in production; node-compatible fetch in tests). */
  fetch?: typeof globalThis.fetch;
  /** Extra request headers — used to thread the daemon auth token. */
  headers?: HeadersInit;
}

/**
 * AgentTransport that POSTs the formatted prompt to a configurable URL.
 * In the mark-it CLI harness this hits /api/agent, which broadcasts a
 * `send` event on the per-doc SSE stream (`/api/agent/events?doc=<id>`) —
 * the daemon-mode replacement for the old stdout envelope. Subscribers
 * (e.g. `mark-it tail`) receive `{ docId, text, comments, resolveIds }`.
 */
export class HttpAgentTransport implements AgentTransport {
  readonly name = "http";
  private readonly url: string;
  private readonly format: (payload: AgentPayload) => string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly headers: HeadersInit;

  constructor(opts: HttpAgentTransportOptions) {
    this.url = opts.url;
    this.format = opts.format ?? formatForAgent;
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.headers = opts.headers ?? {};
  }

  async send(payload: AgentPayload): Promise<void> {
    const text = this.format(payload);
    const body = JSON.stringify({
      text,
      comments: payload.comments,
      resolveIds: payload.resolveIds ?? [],
    });
    let res: Response;
    try {
      res = await this.fetchImpl(this.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...this.headers },
        body,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`HttpAgentTransport(${this.url}) network error: ${reason}`);
    }
    if (!res.ok) {
      const msg = await res.text().catch(() => "");
      throw new Error(`HttpAgentTransport(${this.url}) failed: ${res.status} ${msg}`);
    }
  }
}
