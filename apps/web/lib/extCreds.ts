// External credential configuration via environment variables.
//
// Two ways to supply a provider's credential without the UI:
//
//   1. Inline env vars  (seeded into the DB once at startup, then behaves like a UI-entered
//      credential — refresh persists to the DB):
//        QUOTA_<PROVIDER>_BEARERTOKEN / _REFRESHTOKEN / _ACCOUNTID / _REGION / _BASEURLOVERRIDE / _EXPIRESAT
//        QUOTA_<PROVIDER>_JSON        full ProviderCredentials JSON
//        QUOTA_<PROVIDER>_EXTRA_<KEY> -> credentials.extra[<KEY>]
//        QUOTA_<PROVIDER>_MODE        auto | api | oauth | web   (default auto)
//        QUOTA_<PROVIDER>_OVERWRITE   true -> re-seed on every restart (default: only seed if absent)
//
//   2. Local file source (read fresh on every poll; the file is the source of truth — designed
//      for mounting the live ~/.claude/.credentials.json / ~/.codex/auth.json, read-only):
//        QUOTA_<PROVIDER>_FILE          path to the credential file
//        QUOTA_<PROVIDER>_FILE_FORMAT   native (parsed by the provider) | json  (default native)
//        QUOTA_<PROVIDER>_FILE_WRITABLE true -> dashboard may refresh + write the file back
//                                       (default false = read-only; see fetcher for why this matters)
//      Individual field env vars (region / accountId / baseUrlOverride / ...) are overlaid on top
//      of the file, so you can read the token from the file but set the region from the env.
//
// A file source takes precedence over everything; when set, inline seeding is skipped.

import { readFileSync, writeFileSync } from "node:fs";
import type { ProviderCredentials, SourceMode, UsageProvider } from "@quota/core";
import { ALL_PROVIDERS, getDescriptor } from "@quota/core";
import { getCredential, saveCredential } from "./store";

const PREFIX = "QUOTA_";

// ProviderCredentials scalar field keys settable via QUOTA_<P>_<UPPERKEY>.
const FIELD_KEYS: Array<keyof ProviderCredentials> = [
  "bearerToken",
  "refreshToken",
  "cookieHeader",
  "accountId",
  "baseUrlOverride",
  "region",
  "expiresAt",
];

function env(name: string): string | undefined {
  const v = process.env[name];
  return v != null && v !== "" ? v : undefined;
}

function key(provider: UsageProvider, suffix: string): string {
  return `${PREFIX}${provider.toUpperCase()}_${suffix}`;
}

function parseMode(v: string | undefined): SourceMode {
  return v === "api" || v === "oauth" || v === "web" || v === "auto" ? v : "auto";
}

function mergeCreds(base: ProviderCredentials, overlay: ProviderCredentials): ProviderCredentials {
  const merged: ProviderCredentials = { ...base, ...overlay };
  const extra = { ...(base.extra ?? {}), ...(overlay.extra ?? {}) };
  if (Object.keys(extra).length) merged.extra = extra;
  else delete (merged as { extra?: unknown }).extra;
  return merged;
}

/** Individual field + EXTRA_ env vars assembled into a (possibly empty) credential object. */
function readFieldEnv(provider: UsageProvider): ProviderCredentials {
  const out: ProviderCredentials = {};
  for (const k of FIELD_KEYS) {
    const v = env(key(provider, String(k).toUpperCase()));
    if (v != null) (out as Record<string, unknown>)[k] = v;
  }
  const extra: Record<string, string> = {};
  const ePrefix = key(provider, "EXTRA_");
  for (const [name, value] of Object.entries(process.env)) {
    if (value != null && value !== "" && name.startsWith(ePrefix)) extra[name.slice(ePrefix.length)] = value;
  }
  if (Object.keys(extra).length) out.extra = extra;
  return out;
}

// ---------------------------------------------------------------------------
// File source (live)
// ---------------------------------------------------------------------------

export interface FileSource {
  provider: UsageProvider;
  path: string;
  format: "native" | "json";
  writable: boolean;
  mode: SourceMode;
}

export function fileSourceFor(provider: UsageProvider): FileSource | null {
  const path = env(key(provider, "FILE"));
  if (!path) return null;
  return {
    provider,
    path,
    format: env(key(provider, "FILE_FORMAT")) === "json" ? "json" : "native",
    writable: (env(key(provider, "FILE_WRITABLE")) ?? "false") === "true",
    mode: parseMode(env(key(provider, "MODE"))),
  };
}

export interface LoadedFileCredential {
  credentials: ProviderCredentials;
  mode: SourceMode;
  /** Raw parsed file JSON, kept so a write-back can preserve unrelated fields. */
  raw: unknown;
}

export function loadFileCredential(src: FileSource): LoadedFileCredential {
  const raw = JSON.parse(readFileSync(src.path, "utf8")) as unknown;
  let creds: ProviderCredentials | null;
  if (src.format === "json") {
    creds = raw && typeof raw === "object" ? (raw as ProviderCredentials) : null;
  } else {
    const desc = getDescriptor(src.provider);
    if (!desc.parseCredentialFile) {
      throw new Error(`${src.provider} 无 native 凭据文件解析；请设置 ${key(src.provider, "FILE_FORMAT")}=json`);
    }
    creds = desc.parseCredentialFile(raw);
  }
  if (!creds || !creds.bearerToken) throw new Error(`凭据文件无法解析或缺少 token: ${src.path}`);
  return { credentials: mergeCreds(creds, readFieldEnv(src.provider)), mode: src.mode, raw };
}

/** Write refreshed tokens back to a writable file source. No-op for read-only sources. */
export function writeBackFileCredential(src: FileSource, creds: ProviderCredentials, prevRaw: unknown): void {
  if (!src.writable) return;
  let next: unknown;
  if (src.format === "json") {
    const base = prevRaw && typeof prevRaw === "object" ? { ...(prevRaw as Record<string, unknown>) } : {};
    // Only persist the rotated token fields; never leak overlay env fields into the file.
    next = { ...base, bearerToken: creds.bearerToken, refreshToken: creds.refreshToken, expiresAt: creds.expiresAt };
  } else {
    const desc = getDescriptor(src.provider);
    next = desc.serializeCredentialFile ? desc.serializeCredentialFile(creds, prevRaw) : creds;
  }
  writeFileSync(src.path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

// ---------------------------------------------------------------------------
// Inline env source (DB seed)
// ---------------------------------------------------------------------------

function inlineCredentialFor(provider: UsageProvider): { credentials: ProviderCredentials; mode: SourceMode } | null {
  let base: ProviderCredentials = {};
  const jsonRaw = env(key(provider, "JSON"));
  if (jsonRaw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonRaw);
    } catch {
      throw new Error(`${key(provider, "JSON")} 不是合法 JSON`);
    }
    if (parsed && typeof parsed === "object") base = parsed as ProviderCredentials;
  }
  const credentials = mergeCreds(base, readFieldEnv(provider));
  if (!Object.keys(credentials).length) return null;
  return { credentials, mode: parseMode(env(key(provider, "MODE"))) };
}

/**
 * Seed inline env credentials into the DB. Called once at startup. File-source providers are
 * skipped (they are live, not stored). By default a provider is only seeded when the DB has no
 * credential for it, so a token refreshed into the DB is not clobbered on restart; set
 * QUOTA_<P>_OVERWRITE=true to always re-seed from the env.
 */
export function seedCredentialsFromEnv(): void {
  const now = new Date();
  for (const provider of ALL_PROVIDERS) {
    if (fileSourceFor(provider)) continue;
    let inline: { credentials: ProviderCredentials; mode: SourceMode } | null;
    try {
      inline = inlineCredentialFor(provider);
    } catch (e) {
      console.error(`[extCreds] ${provider} 内联凭据解析失败:`, e instanceof Error ? e.message : e);
      continue;
    }
    if (!inline) continue;
    const overwrite = (env(key(provider, "OVERWRITE")) ?? "false") === "true";
    if (getCredential(provider) && !overwrite) continue;
    saveCredential(provider, inline.mode, inline.credentials, now);
    console.log(`[extCreds] seeded ${provider} credential from env`);
  }
}
