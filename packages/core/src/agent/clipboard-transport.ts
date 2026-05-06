import { formatForAgent } from "./formatter.js";
import type { AgentPayload, AgentTransport } from "./transport.js";

export interface ClipboardTransportOptions {
  /** Override the formatter (defaults to the canonical formatForAgent). */
  format?: (payload: AgentPayload) => string;
  /**
   * Override the clipboard write strategy. Useful for tests or non-browser
   * hosts. Defaults to navigator.clipboard.writeText when available.
   */
  writeText?: (text: string) => Promise<void>;
}

export class ClipboardTransport implements AgentTransport {
  readonly name = "clipboard";
  private readonly format: (payload: AgentPayload) => string;
  private readonly writeText: (text: string) => Promise<void>;

  constructor(opts: ClipboardTransportOptions = {}) {
    this.format = opts.format ?? formatForAgent;
    this.writeText = opts.writeText ?? defaultWriteText;
  }

  async send(payload: AgentPayload): Promise<void> {
    const text = this.format(payload);
    await this.writeText(text);
  }
}

async function defaultWriteText(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard) {
    await navigator.clipboard.writeText(text);
    return;
  }
  throw new Error("ClipboardTransport: navigator.clipboard is unavailable");
}
