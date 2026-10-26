import type { ProviderCredentials, ProviderDescriptor, SourceMode } from "./adapter";
import { RateLimitedError, RefreshRejectedError, UnauthorizedError, runPipeline } from "./adapter";
import type { HttpClient } from "./http";
import type { UsageProvider, UsageSnapshot } from "./model";
import { getDescriptor } from "./registry";

export interface CredentialRecord {
  enabled: boolean;
  mode: SourceMode;
  credentials: ProviderCredentials;
  /** Opaque storage revision, changed on every credential write. */
  revision: string;
}

export interface UsageFetchResult {
  snapshot: UsageSnapshot | null;
  error: string | null;
}

interface Dependencies {
  load(provider: UsageProvider): CredentialRecord | null;
  update(provider: UsageProvider, credentials: ProviderCredentials, now: Date, revision: string): string | null;
  publish(provider: UsageProvider, snapshot: UsageSnapshot | null, error: string | null, now: Date): void;
  http(provider: UsageProvider): HttpClient;
  descriptor?(provider: UsageProvider): ProviderDescriptor;
  now?(): Date;
}

class CredentialsChangedError extends Error {
  constructor() { super("凭据已变更，已忽略旧请求"); }
}

export function createUsageFetcher(deps: Dependencies): (provider: UsageProvider) => Promise<UsageFetchResult> {
  const pending = new Map<UsageProvider, { revision: string; promise: Promise<UsageFetchResult> }>();
  const now = deps.now ?? (() => new Date());

  async function run(provider: UsageProvider, initial: CredentialRecord, slot: { revision: string }): Promise<UsageFetchResult> {
    let current = initial;
    const desc = (deps.descriptor ?? getDescriptor)(provider);
    const http = deps.http(provider);
    let refreshed = false;
    const isCurrent = () => deps.load(provider)?.revision === current.revision;
    function assertCurrent() {
      if (!isCurrent()) throw new CredentialsChangedError();
    }
    function persist(credentials: ProviderCredentials) {
      const revision = deps.update(provider, credentials, now(), current.revision);
      if (revision == null) throw new CredentialsChangedError();
      current = { ...current, credentials, revision };
      slot.revision = revision;
    }
    const expiry = () => Date.parse(current.credentials.expiresAt ?? "");

    async function refresh() {
      assertCurrent();
      const state = current.credentials.refreshState;
      if (state?.blocked) throw new RefreshRejectedError(state.error);
      if (state?.retryAt && Date.parse(state.retryAt) > now().getTime()) {
        throw new Error(state.error ?? "凭据续期暂时失败，稍后自动重试");
      }
      let credentials: ProviderCredentials;
      try {
        ({ credentials } = await desc.refresh!(current.credentials, { now: now(), http }));
      } catch (error) {
        const failures = Math.min((state?.failures ?? 0) + 1, 10);
        const retryAfter = error instanceof RateLimitedError && Number.isFinite(error.retryAfterSeconds) ? error.retryAfterSeconds! : 0;
        const seconds = Math.max(
          Math.min(60 * 2 ** (failures - 1), 1800),
          Math.max(0, retryAfter),
        );
        persist({
          ...current.credentials,
          refreshState: {
            failures, blocked: error instanceof RefreshRejectedError,
            retryAt: new Date(now().getTime() + Math.min(seconds, 86400) * 1000).toISOString(),
            error: error instanceof Error ? error.message : "凭据续期失败，请稍后重试",
          },
        });
        throw error;
      }
      // Persist rotations before any usage request; never overwrite a replacement credential.
      persist({ ...credentials, refreshState: undefined });
      refreshed = true;
    }

    try {
      assertCurrent();
      if (current.credentials.refreshState?.blocked) throw new RefreshRejectedError(current.credentials.refreshState.error);
      if (desc.refresh && current.credentials.refreshToken && desc.refreshLeadTimeMs != null
        && expiry() <= now().getTime() + desc.refreshLeadTimeMs) {
        try {
          await refresh();
        } catch (error) {
          if (error instanceof CredentialsChangedError || error instanceof RefreshRejectedError || expiry() <= now().getTime()) throw error;
          // A transient refresh outage need not discard usage from a still-valid access token.
        }
      }
      let snapshot: UsageSnapshot;
      try {
        snapshot = await runPipeline(desc, current.mode, current.credentials, { now: now(), http });
      } catch (error) {
        if (!(error instanceof UnauthorizedError) || !desc.refresh || !current.credentials.refreshToken || refreshed) throw error;
        await refresh();
        snapshot = await runPipeline(desc, current.mode, current.credentials, { now: now(), http });
      }
      assertCurrent();
      deps.publish(provider, snapshot, null, now());
      return { snapshot, error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isCurrent()) deps.publish(provider, null, message, now());
      return { snapshot: null, error: message };
    }
  }

  return (provider) => {
    const stored = deps.load(provider);
    if (!stored || !stored.enabled) return Promise.resolve({ snapshot: null, error: "未配置凭据" });
    const active = pending.get(provider);
    if (active?.revision === stored.revision) return active.promise;
    const slot = { revision: stored.revision, promise: null as unknown as Promise<UsageFetchResult> };
    slot.promise = Promise.resolve().then(() => run(provider, stored, slot)).finally(() => {
      if (pending.get(provider) === slot) pending.delete(provider);
    });
    pending.set(provider, slot);
    return slot.promise;
  };
}
