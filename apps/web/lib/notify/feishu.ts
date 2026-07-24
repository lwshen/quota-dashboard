import { createHmac } from "node:crypto";
import type { NotifyChannel, NotifyMessage } from "./types";
import { NotifyError } from "./types";

/**
 * Feishu (Lark) group custom-bot webhook.
 * Docs: https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot
 */
export class FeishuChannel implements NotifyChannel {
  readonly name = "feishu";

  constructor(
    private readonly webhookUrl: string,
    private readonly secret?: string,
  ) {}

  async send(message: NotifyMessage): Promise<void> {
    const body: Record<string, unknown> = {
      msg_type: "interactive",
      card: {
        config: { wide_screen_mode: true },
        header: { template: "green", title: { tag: "plain_text", content: message.title } },
        elements: [{ tag: "div", text: { tag: "lark_md", content: message.lines.join("\n") } }],
      },
    };
    if (this.secret) {
      const timestamp = String(Math.floor(Date.now() / 1000));
      body.timestamp = timestamp;
      // Feishu's scheme: the string-to-sign is the HMAC key and the signed message is empty.
      body.sign = createHmac("sha256", `${timestamp}\n${this.secret}`).update("").digest("base64");
    }

    let res: Response;
    try {
      res = await fetch(this.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new NotifyError(`飞书 webhook 请求失败: ${msg}`, true);
    }
    // Feishu rejects at the app level with HTTP 200 + code!=0 (e.g. 19021 sign mismatch),
    // so report HTTP status and app code separately; only transport-level failures retry.
    const payload = (await res.json().catch(() => null)) as { code?: number; msg?: string } | null;
    const httpFailed = !res.ok;
    const appFailed = payload?.code !== undefined && payload.code !== 0;
    if (httpFailed || appFailed) {
      const parts: string[] = [];
      if (httpFailed) parts.push(`HTTP ${res.status}`);
      if (appFailed) parts.push(`code ${payload?.code}`);
      if (payload?.msg) parts.push(payload.msg);
      const retryable = httpFailed && (res.status >= 500 || res.status === 429);
      throw new NotifyError(`飞书 webhook 发送失败: ${parts.join(" · ")}`, retryable);
    }
  }
}
