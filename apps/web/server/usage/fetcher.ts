import type { HttpClient, HttpResponse, UsageProvider } from "@quota/core";
import { createUsageFetcher, nodeHttpClient } from "@quota/core";
import { ENV } from "@/runtime/env";
import { detectAndNotifyAlerts, detectAndNotifyResets } from "@/server/notify";
import { getCredential, listCredentials, saveSnapshot, updateCredentialSecret } from "@/server/storage";

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
const processState = globalThis as typeof globalThis & { quotaUsageFetcher?: ReturnType<typeof createUsageFetcher<string>> };
export const fetchAndStore = processState.quotaUsageFetcher ??= createUsageFetcher<string>({
  load: getCredential,
  update: updateCredentialSecret,
  http: debugHttpClient,
  publish(provider, snapshot, error, now, issue) {
    if (snapshot) detectAndNotifyResets(provider, snapshot, now);
    detectAndNotifyAlerts(provider, snapshot, issue, now);
    saveSnapshot(provider, snapshot, error, now);
  },
});

export async function fetchAllConfigured(): Promise<void> {
  const creds = listCredentials().filter((c) => c.enabled);
  await Promise.all(creds.map((c) => fetchAndStore(c.accountId)));
}
