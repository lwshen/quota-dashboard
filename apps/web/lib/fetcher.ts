import type { FetchContext, HttpClient, HttpResponse, UsageProvider, UsageSnapshot } from "@quota/core";
import { getDescriptor, nodeHttpClient, runPipeline, UnauthorizedError } from "@quota/core";
import { ENV } from "./env";
import { getCredential, listCredentials, saveSnapshot, updateCredentialSecret } from "./store";

export interface FetchResult {
  snapshot: UsageSnapshot | null;
  error: string | null;
}

function debugHttpClient(provider: UsageProvider): HttpClient {
  if (!ENV.debug) return nodeHttpClient;

  const logResponse = (response: HttpResponse): HttpResponse => {
    console.log(`[quota-debug] ${provider} raw response (HTTP ${response.status}): ${response.body}`);
    return response;
  };

  return {
    get: async (...args) => logResponse(await nodeHttpClient.get(...args)),
    post: nodeHttpClient.post,
  };
}

export async function fetchAndStore(provider: UsageProvider): Promise<FetchResult> {
  const now = new Date();
  const stored = getCredential(provider);
  if (!stored || !stored.enabled) {
    return { snapshot: null, error: "未配置凭据" };
  }
  const desc = getDescriptor(provider);
  let creds = stored.credentials;
  const ctx: FetchContext = { now, http: debugHttpClient(provider), cachedSnapshot: null };

  try {
    const snap = await runPipeline(desc, stored.mode, creds, ctx);
    saveSnapshot(provider, snap, null, now);
    return { snapshot: snap, error: null };
  } catch (e) {
    if (e instanceof UnauthorizedError && desc.refresh && creds.refreshToken) {
      try {
        const refreshed = await desc.refresh(creds, ctx);
        creds = refreshed.credentials;
        updateCredentialSecret(provider, creds, now);
        const snap = await runPipeline(desc, stored.mode, creds, ctx);
        saveSnapshot(provider, snap, null, now);
        return { snapshot: snap, error: null };
      } catch (e2) {
        const msg = e2 instanceof Error ? e2.message : String(e2);
        saveSnapshot(provider, null, `刷新后仍失败: ${msg}`, now);
        return { snapshot: null, error: msg };
      }
    }
    const msg = e instanceof Error ? e.message : String(e);
    saveSnapshot(provider, null, msg, now);
    return { snapshot: null, error: msg };
  }
}

export async function fetchAllConfigured(): Promise<void> {
  const creds = listCredentials().filter((c) => c.enabled);
  await Promise.all(creds.map((c) => fetchAndStore(c.provider)));
}
