import { formatForAgent } from "./formatter.js";
import type { AgentPayload, AgentTransport } from "./transport.js";

export interface HttpAgentTransportOptions {
  /** Endpoint that accepts POST { text, resolveIds }. */
  url: string;
  format?: (payload: AgentPayload) => string;
  /** Fetch override (browser default in production; node-compatible fetch in tests). */
  fetch?: typeof globalThis.fetch;
}

/**
 * AgentTransport that POSTs the formatted prompt to a configurable URL.
 * In the mark-it CLI harness this hits /api/agent, which writes the prompt
 * to the CLI's stdout and exits the process — perfect for piping mark-it
 * as a step in a shell pipeline.
 */
export class HttpAgentTransport implements AgentTransport {
  readonly name = "http";
  private readonly url: string;
  private readonly format: (payload: AgentPayload) => string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(opts: HttpAgentTransportOptions) {
    this.url = opts.url;
    this.format = opts.format ?? formatForAgent;
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async send(payload: AgentPayload): Promise<void> {
    const text = this.format(payload);
    const body = JSON.stringify({
      text,
      resolveIds: payload.resolveIds ?? [],
    });
    const res = await this.fetchImpl(this.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    if (!res.ok) {
      const msg = await res.text().catch(() => "");
      throw new Error(`HttpAgentTransport(${this.url}) failed: ${res.status} ${msg}`);
    }
  }
}
