// Grok gRPC-web wire contract, limited to the billing read endpoint.
import { RateLimitedError, UnauthorizedError, UpstreamError } from "../adapter";
import type { GrokBilling } from "./grok-billing";
import { periodMinutes, productShares } from "./grok-billing";

interface Field {
  number: number;
  varint?: bigint;
  float?: number;
  message?: Uint8Array;
}

function invalid(): never {
  throw new UpstreamError(undefined, "无法解析 Grok gRPC 账单数据");
}

function fields(bytes: Uint8Array): Field[] {
  let offset = 0;
  const result: Field[] = [];
  function varint(): bigint {
    let value = 0n;
    for (let shift = 0; shift < 70; shift += 7) {
      const byte = bytes[offset++];
      if (byte == null || (shift === 63 && byte > 1)) invalid();
      value |= BigInt(byte & 127) << BigInt(shift);
      if (!(byte & 128)) return value;
    }
    return invalid();
  }
  while (offset < bytes.length) {
    const key = varint();
    const number = Number(key >> 3n);
    if (number < 1 || number > 536_870_911) invalid();
    const field: Field = { number };
    switch (Number(key & 7n)) {
      case 0: field.varint = varint(); break;
      case 1:
        if (bytes.length - offset < 8) invalid();
        offset += 8;
        break;
      case 2: {
        const length = varint();
        if (length > BigInt(bytes.length - offset)) invalid();
        field.message = bytes.subarray(offset, offset + Number(length));
        offset += Number(length);
        break;
      }
      case 5:
        if (bytes.length - offset < 4) invalid();
        field.float = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getFloat32(0, true);
        offset += 4;
        break;
      default: invalid();
    }
    result.push(field);
  }
  return result;
}

export function validateGrokGrpcStatus(headers: Record<string, string>): void {
  const status = Number(headers["grpc-status"] ?? 0);
  if (!Number.isInteger(status)) invalid();
  if (status === 0) return;
  let message = headers["grpc-message"] ?? "";
  try { message = decodeURIComponent(message); } catch { /* Keep malformed escaped text for classification. */ }
  if (status === 16 || (status === 7 && /bad-credentials|unauthenticated|oauth2|access token/i.test(message))) {
    throw new UnauthorizedError("Grok 凭据已失效，请运行 grok login 后更新 Access Token");
  }
  if (status === 8) throw new RateLimitedError();
  if (status === 9 && /^no personal team\.?$/i.test(message.trim())) {
    throw new UpstreamError(undefined, "Grok 当前账单接口不支持此团队账户");
  }
  throw new UpstreamError(undefined, `Grok billing RPC failed (status ${status})`);
}

function payloads(bytes: Uint8Array): Uint8Array[] {
  // Raw protobuf responses start with a field key; framed responses start with flags.
  if (bytes.length && (bytes[0]! >> 3) > 0 && [0, 1, 2, 5].includes(bytes[0]! & 7) && bytes[0] !== 128) {
    return [bytes];
  }
  const result: Uint8Array[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (bytes.length - offset < 5) invalid();
    const flags = bytes[offset];
    if (flags !== 0 && flags !== 128) invalid();
    const length = new DataView(bytes.buffer, bytes.byteOffset + offset + 1, 4).getUint32(0);
    offset += 5;
    if (length > bytes.length - offset) invalid();
    const frame = bytes.subarray(offset, offset + length);
    offset += length;
    if (flags === 0) result.push(frame);
    else {
      const headers: Record<string, string> = {};
      for (const line of new TextDecoder().decode(frame).split(/\r?\n/)) {
        const colon = line.indexOf(":");
        if (colon >= 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
      }
      validateGrokGrpcStatus(headers);
    }
  }
  return result;
}

const MESSAGES = new Set([
  "1", "1.2", "1.3", "1.4", "1.5", "1.6", "1.7", "1.8", "1.12",
  "1.6.1", "1.6.2", "1.6.3", "1.8.2", "1.8.3", "1.6.3.2", "1.6.3.3",
]);

function productsFrom(root: Field[], percent: number): GrokBilling["products"] {
  const configs = root.filter((f) => f.number === 1);
  if (configs.length !== 1 || !configs[0]?.message) return [];
  const config = fields(configs[0].message);
  if (config.filter((f) => f.number === 1).length !== 1) return [];
  const products: { product: string; usagePercent: number }[] = [];
  const seen = new Set<bigint>();
  for (const field of config.filter((f) => f.number === 7)) {
    if (!field.message) return [];
    const entry = fields(field.message);
    const ids = entry.filter((f) => f.number === 1);
    const percents = entry.filter((f) => f.number === 2);
    const id = ids[0]?.varint;
    if (ids.length !== 1 || id == null || seen.has(id) || percents.length > 1) return [];
    if (percents.length && percents[0]?.float == null) return [];
    const share = percents[0]?.float ?? 0;
    if (!Number.isFinite(share) || share < 0) return [];
    seen.add(id);
    const name = id === 2n ? "GrokBuild" : id === 4n ? "GrokChat" : null;
    if (name) products.push({ product: name, usagePercent: share });
    else if (share > 0) return [];
  }
  return productShares(products, percent);
}

export function parseGrokGrpc(bytes: Uint8Array, now: Date): GrokBilling {
  const messages = payloads(bytes);
  if (!messages.length) invalid();
  const scanned: { field: Field; path: string; depth: number }[] = [];
  function scan(items: Field[], parent: number[] = []): void {
    for (const field of items) {
      const path = [...parent, field.number];
      const key = path.join(".");
      scanned.push({ field, path: key, depth: path.length });
      if (field.message && MESSAGES.has(key)) scan(fields(field.message), path);
    }
  }
  const roots = messages.map(fields);
  for (const root of roots) scan(root);
  const floats = scanned.filter((f) => f.field.float != null);
  const reported = floats.filter((f) => f.field.number === 1 && Number.isFinite(f.field.float)
    && f.field.float! >= 0 && f.field.float! <= 100).sort((a, b) => a.depth - b.depth)[0];
  const dates = scanned.flatMap((f) => {
    const value = f.field.varint;
    return value != null && value >= 1_700_000_000n && value <= 2_100_000_000n
      ? [{ path: f.path, ms: Number(value) * 1000 }] : [];
  });
  const future = dates.filter((f) => f.ms > now.getTime()).sort((a, b) => a.ms - b.ms);
  const reset = future.find((f) => f.path === "1.5.1") ?? future[0];
  const start = dates.find((f) => f.path === "1.8.2.1")?.ms;
  const end = dates.find((f) => f.path === "1.8.3.1")?.ms;
  const active = scanned.some((f) => f.path === "1.8.1" && (f.field.varint === 1n || f.field.varint === 2n))
    && start != null && start <= now.getTime() && end != null && end > now.getTime();
  // Proto3 omits a zero float. Infer zero only from one complete, active period.
  const implicitZero = messages.length === 1 && floats.length === 0 && active && reset != null;
  const percent = reported?.field.float ?? (implicitZero ? 0 : null);
  if (percent == null) invalid();
  const resetsAt = reset ? new Date(reset.ms).toISOString() : null;
  return {
    usedPercent: percent,
    resetsAt,
    windowMinutes: reset?.ms === end && start != null ? periodMinutes(start, resetsAt, now) : null,
    subscriptionTier: null,
    products: roots.length === 1 && reported?.path === "1.1" ? productsFrom(roots[0]!, percent) : [],
    balance: null,
    sourceKey: "credits",
  };
}
