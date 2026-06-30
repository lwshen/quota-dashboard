import type { FetchContext, UsageProvider, UsageSnapshot } from "@quota/core";
import { ALL_PROVIDERS, getDescriptor, nodeHttpClient, runPipeline, UnauthorizedError } from "@quota/core";
import { getCredential, listCredentials, saveSnapshot, updateCredentialSecret } from "./store";
import { fileSourceFor, loadFileCredential, writeBackFileCredential, type FileSource } from "./extCreds";

export interface FetchResult {
  snapshot: UsageSnapshot | null;
  error: string | null;
}

export async function fetchAndStore(provider: UsageProvider): Promise<FetchResult> {
  const now = new Date();
  const fileSrc = fileSourceFor(provider);
  if (fileSrc) return fetchFromFileSource(fileSrc, now);

  const stored = getCredential(provider);
  if (!stored || !stored.enabled) {
    return { snapshot: null, error: "未配置凭据" };
  }
  const desc = getDescriptor(provider);
  let creds = stored.credentials;
  const ctx: FetchContext = { now, http: nodeHttpClient, cachedSnapshot: null };

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

// Live file source: re-read the credential file every fetch so host-side refreshes are picked up.
// Read-only sources never call refresh: rotating the token would invalidate the refresh token in
// the source file and break whoever owns it (e.g. the local CLI). Mount read-write + set
// QUOTA_<P>_FILE_WRITABLE=true only when the dashboard is the sole refresher.
async function fetchFromFileSource(src: FileSource, now: Date): Promise<FetchResult> {
  const desc = getDescriptor(src.provider);
  const ctx: FetchContext = { now, http: nodeHttpClient, cachedSnapshot: null };

  let loaded: ReturnType<typeof loadFileCredential>;
  try {
    loaded = loadFileCredential(src);
  } catch (e) {
    const msg = `读取凭据文件失败: ${e instanceof Error ? e.message : String(e)}`;
    saveSnapshot(src.provider, null, msg, now);
    return { snapshot: null, error: msg };
  }

  let creds = loaded.credentials;
  try {
    const snap = await runPipeline(desc, loaded.mode, creds, ctx);
    saveSnapshot(src.provider, snap, null, now);
    return { snapshot: snap, error: null };
  } catch (e) {
    if (e instanceof UnauthorizedError && desc.refresh && creds.refreshToken) {
      if (!src.writable) {
        const msg =
          `凭据已过期；只读文件源不会自动刷新（以免使源文件的 refresh token 失效）。` +
          `请让该凭据的拥有者刷新（如运行对应 CLI），或挂载为可写并设置 ${`QUOTA_${src.provider.toUpperCase()}_FILE_WRITABLE`}=true`;
        saveSnapshot(src.provider, null, msg, now);
        return { snapshot: null, error: msg };
      }
      try {
        const refreshed = await desc.refresh(creds, ctx);
        creds = refreshed.credentials;
        try {
          writeBackFileCredential(src, creds, loaded.raw);
        } catch (we) {
          console.error(`[extCreds] 写回凭据文件失败 ${src.provider}:`, we);
        }
        const snap = await runPipeline(desc, loaded.mode, creds, ctx);
        saveSnapshot(src.provider, snap, null, now);
        return { snapshot: snap, error: null };
      } catch (e2) {
        const msg = e2 instanceof Error ? e2.message : String(e2);
        saveSnapshot(src.provider, null, `刷新后仍失败: ${msg}`, now);
        return { snapshot: null, error: msg };
      }
    }
    const msg = e instanceof Error ? e.message : String(e);
    saveSnapshot(src.provider, null, msg, now);
    return { snapshot: null, error: msg };
  }
}

export async function fetchAllConfigured(): Promise<void> {
  const providers = new Set<UsageProvider>();
  for (const p of ALL_PROVIDERS) if (fileSourceFor(p)) providers.add(p);
  for (const c of listCredentials()) if (c.enabled) providers.add(c.provider);
  await Promise.all([...providers].map((p) => fetchAndStore(p)));
}
