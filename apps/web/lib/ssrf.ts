// SSRF: resolve DNS too, to reject public domains that point at private addresses.

import { lookup } from "node:dns/promises";
import { assertSafeExternalUrl, isPrivateIpLiteral } from "@quota/core";

export async function assertSafeBaseUrl(raw: string): Promise<void> {
  assertSafeExternalUrl(raw);
  const host = new URL(raw).hostname.replace(/^\[|\]$/g, "");
  let addrs: { address: string }[];
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    throw new Error(`无法解析主机: ${host}`);
  }
  for (const a of addrs) {
    if (isPrivateIpLiteral(a.address)) throw new Error(`主机解析到私有地址: ${a.address}`);
  }
}
