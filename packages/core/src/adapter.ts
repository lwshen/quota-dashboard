import type { HttpClient } from "./http";
import type { UsageProvider, UsageSnapshot } from "./model";

export class NotConfiguredError extends Error {
  constructor(msg = "missing credentials") {
    super(msg);
    this.name = "NotConfiguredError";
  }
}

export class UnauthorizedError extends Error {
  constructor(msg = "unauthorized") {
    super(msg);
    this.name = "UnauthorizedError";
  }
}

export class RateLimitedError extends Error {
  retryAfterSeconds?: number;
  constructor(retryAfterSeconds?: number, msg = "rate limited") {
    super(msg);
    this.name = "RateLimitedError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class UpstreamError extends Error {
  status?: number;
  constructor(status?: number, msg = "upstream error") {
    super(`${msg}${status ? ` (${status})` : ""}`);
    this.name = "UpstreamError";
    this.status = status;
  }
}

export interface ProviderCredentials {
  bearerToken?: string;
  refreshToken?: string;
  /** Full `Cookie:` header value. */
  cookieHeader?: string;
  /** Codex `ChatGPT-Account-Id` header. */
  accountId?: string;
  baseUrlOverride?: string;
  /** Allowed values: ai / cn. */
  region?: string;
  /** ISO8601. */
  expiresAt?: string | null;
  extra?: Record<string, string>;
}

export interface FetchContext {
  now: Date;
  http: HttpClient;
  /** Used for reset backfill / identity matching. */
  cachedSnapshot?: UsageSnapshot | null;
}

export type SourceMode = "auto" | "api" | "oauth" | "web";

export interface ProviderFetchStrategy {
  id: string;
  sourceMode: Exclude<SourceMode, "auto">;
  isAvailable(creds: ProviderCredentials): boolean;
  fetch(creds: ProviderCredentials, ctx: FetchContext): Promise<UsageSnapshot>;
  /** Returns true only for auth errors (fall back), not for other failures. */
  shouldFallback(err: unknown): boolean;
}

export interface CredentialField {
  key: keyof ProviderCredentials | `extra.${string}`;
  label: string;
  required: boolean;
  secret: boolean;
  placeholder?: string;
  help?: string;
}

export interface RefreshResult {
  credentials: ProviderCredentials;
}

export interface ProviderDescriptor {
  provider: UsageProvider;
  label: string;
  /** Accent color (any CSS color) for the provider dot/avatar in the UI. Optional; UI falls back to a neutral tone. */
  accentColor?: string;
  credentialFields: CredentialField[];
  /** When false, the provider produces only balance/credits text, not time-varying RateWindows. */
  producesRateWindows: boolean;
  resolveStrategies(mode: SourceMode): ProviderFetchStrategy[];
  refresh?(creds: ProviderCredentials, ctx: FetchContext): Promise<RefreshResult>;
}

export async function runPipeline(
  desc: ProviderDescriptor,
  mode: SourceMode,
  creds: ProviderCredentials,
  ctx: FetchContext,
): Promise<UsageSnapshot> {
  const strategies = desc.resolveStrategies(mode).filter((s) => s.isAvailable(creds));
  if (strategies.length === 0) {
    throw new NotConfiguredError(`no available strategy for ${desc.provider} in mode ${mode}`);
  }
  let lastErr: unknown;
  for (const s of strategies) {
    try {
      return await s.fetch(creds, ctx);
    } catch (e) {
      lastErr = e;
      if (!s.shouldFallback(e)) throw e;
    }
  }
  throw lastErr ?? new NotConfiguredError();
}

export function isAuthError(err: unknown): boolean {
  return err instanceof UnauthorizedError;
}
