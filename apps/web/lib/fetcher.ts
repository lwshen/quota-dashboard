import type { HttpClient, HttpResponse, UsageProvider, UsageSnapshot } from "@quota/core";
import { createUsageFetcher, nodeHttpClient } from "@quota/core";
import { ENV } from "./env";
import { detectAndNotifyResets } from "./notify";
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

// Route handlers and instrumentation may load separate copies of this module.
const processState = globalThis as typeof globalThis & { quotaUsageFetcher?: ReturnType<typeof createUsageFetcher> };
export const fetchAndStore = processState.quotaUsageFetcher ??= createUsageFetcher({
  load: getCredential,
  update: updateCredentialSecret,
  http: debugHttpClient,
  publish(provider, snapshot, error, now) {
    if (snapshot) detectAndNotifyResets(provider, snapshot, now);
    saveSnapshot(provider, snapshot, error, now);
  },
});

export async function fetchAllConfigured(): Promise<void> {
  const creds = listCredentials().filter((c) => c.enabled);
  await Promise.all(creds.map((c) => fetchAndStore(c.provider)));
}
