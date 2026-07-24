// Channel-agnostic notification plumbing. To add a channel (Telegram, Slack, ...):
// implement NotifyChannel in a sibling file and register it in buildChannels() (index.ts).

export interface NotifyMessage {
  title: string;
  /** Markdown-flavored body lines; channels render them as faithfully as their format allows. */
  lines: string[];
}

export interface NotifyChannel {
  readonly name: string;
  /** Deliver one message. Throw on failure — the dispatcher isolates and logs errors per channel. */
  send(message: NotifyMessage): Promise<void>;
}

export interface NotifyDeliveryResult {
  channel: string;
  ok: boolean;
  error: string | null;
}

/** Channel send failure; retryable marks transient transport errors worth retrying. */
export class NotifyError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = "NotifyError";
  }
}
