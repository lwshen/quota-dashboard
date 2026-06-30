// Shared by the edge + node runtimes, so only Web Crypto / btoa / TextEncoder are used.

import { ENV } from "./env";

export const SESSION_COOKIE = "qd_session";
const TTL_SECONDS = 7 * 24 * 3600;

// ArrayBuffer-backed bytes to satisfy Web Crypto's BufferSource type.
function toBytes(s: string): Uint8Array<ArrayBuffer> {
  const enc = new TextEncoder().encode(s);
  const out = new Uint8Array(new ArrayBuffer(enc.byteLength));
  out.set(enc);
  return out;
}

async function hmacKey(): Promise<CryptoKey> {
  // Fail-closed: never sign/verify sessions with a hardcoded fallback, or anyone
  // could forge a valid cookie. A real deployment sets APP_ENC_KEY anyway (crypto.ts
  // requires it), and AUTH_SECRET falls back to it.
  const secret = ENV.authSecret || ENV.encKey;
  if (!secret) throw new Error("AUTH_SECRET or APP_ENC_KEY must be set to sign sessions");
  return crypto.subtle.importKey("raw", toBytes(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

function b64url(buf: ArrayBuffer): string {
  let bin = "";
  for (const b of new Uint8Array(buf)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sign(payload: string): Promise<string> {
  const key = await hmacKey();
  const sig = await crypto.subtle.sign("HMAC", key, toBytes(payload));
  return b64url(sig);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function createSessionToken(): Promise<{ token: string; maxAge: number }> {
  const exp = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  const payload = String(exp);
  return { token: `${payload}.${await sign(payload)}`, maxAge: TTL_SECONDS };
}

export async function verifySessionToken(token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const exp = Number(payload);
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return false;
  try {
    return timingSafeEqual(sig, await sign(payload));
  } catch {
    return false; // misconfigured secret → deny (fail-closed)
  }
}
