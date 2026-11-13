// Antigravity remote Google OAuth / Cloud Code quota adapter.
// Queries retrieveUserQuotaSummary first, then falls back to fetchAvailableModels + retrieveUserQuota.

import type { CredentialField, FetchContext, ProviderCredentials, ProviderDescriptor, ProviderFetchStrategy, RefreshResult } from "../adapter";
import { RateLimitedError, RefreshRejectedError, UnauthorizedError, UpstreamError } from "../adapter";
import type { HttpResponse } from "../http";
import type { NamedRateWindow, ProviderIdentitySnapshot, RateWindow, UsageSnapshot } from "../model";
import { asRecord, clampPercent, nonEmptyString, num, parseIsoOrUnix, retryAfterSeconds, safeJson, slug } from "../decode";
import { decodeRefreshResponse } from "./oauth-refresh";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const LOAD_CODE_ASSIST_URL = "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";
const ONBOARD_USER_URL = "https://cloudcode-pa.googleapis.com/v1internal:onboardUser";
const QUOTA_SUMMARY_URL = "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary";
const FETCH_AVAILABLE_MODELS_URL = "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels";
const RETRIEVE_USER_QUOTA_URL = "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota";

export const ANTIGRAVITY_DEFAULT_CLIENT_ID =
  "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
const USER_AGENT = "antigravity/hub/2.9.1 darwin/arm64";
const CLIENT_METADATA = {
  ideType: "ANTIGRAVITY",
  platform: "PLATFORM_UNSPECIFIED",
  pluginType: "GEMINI",
};

const SESSION_WINDOW_ALIASES = ["session", "5h", "5-hour", "five hour", "five-hour"];
const CANONICAL_FLASH_ID = "gemini-3.7-flash";
const CANONICAL_FLASH_LABEL = "Gemini 3.7 Flash";

export function extractAntigravityJwtClaims(idToken: string | undefined): { email: string | null; hostedDomain: string | null } {
  try {
    const part = idToken?.trim().split(".")[1];
    if (!part) return { email: null, hostedDomain: null };
    const base64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
    const payload = asRecord(JSON.parse(new TextDecoder().decode(bytes)));
    return {
      email: nonEmptyString(payload?.email),
      hostedDomain: nonEmptyString(payload?.hd),
    };
  } catch {
    return { email: null, hostedDomain: null };
  }
}

function parseProjectRef(value: unknown): string | null {
  const direct = nonEmptyString(value);
  if (direct) return direct;
  const obj = asRecord(value);
  return nonEmptyString(obj?.id) ?? nonEmptyString(obj?.projectId);
}

function rejectsClientForConsumerTier(codeAssist: Record<string, unknown>, storedProjectId: string | null): boolean {
  if (storedProjectId) return false;
  if (asRecord(codeAssist.currentTier) || parseProjectRef(codeAssist.cloudaicompanionProject)) return false;
  if (!Array.isArray(codeAssist.ineligibleTiers)) return false;
  // Unenrolled consumer OAuth clients receive placeholder 100% buckets from quota endpoints.
  return codeAssist.ineligibleTiers.some(
    (item) => nonEmptyString(asRecord(item)?.reasonCode) === "GOOGLE_TOS_NOT_SUPPORTED_BY_CLIENT",
  );
}

function pickOnboardTierId(codeAssist: Record<string, unknown>): string | null {
  if (Array.isArray(codeAssist.allowedTiers)) {
    for (const item of codeAssist.allowedTiers) {
      const tier = asRecord(item);
      if (tier?.isDefault === true && nonEmptyString(tier.id)) return nonEmptyString(tier.id);
    }
    for (const item of codeAssist.allowedTiers) {
      const id = nonEmptyString(asRecord(item)?.id);
      if (id) return id;
    }
  }
  return nonEmptyString(asRecord(codeAssist.paidTier)?.id)
    ?? nonEmptyString(asRecord(codeAssist.currentTier)?.id);
}

function resolvePlan(codeAssist: Record<string, unknown>, hostedDomain: string | null): string | null {
  const paidTier = asRecord(codeAssist.paidTier);
  const paidName = nonEmptyString(paidTier?.name);
  const paidId = nonEmptyString(paidTier?.id);
  if (paidName || paidId) return paidName ?? "Paid";

  const planType = nonEmptyString(asRecord(codeAssist.planInfo)?.planType);
  if (planType) return planType;

  const currentTier = asRecord(codeAssist.currentTier);
  const tierId = nonEmptyString(currentTier?.id);
  if (tierId === "standard-tier") return "Paid";
  if (tierId === "free-tier") return hostedDomain ? "Workspace" : "Free";
  if (tierId === "legacy-tier") return "Legacy";
  return nonEmptyString(currentTier?.name);
}

function parseRemainingFraction(bucket: Record<string, unknown>): number | null {
  const direct = num(bucket.remainingFraction);
  if (direct != null) return Math.max(0, Math.min(1, direct));
  const remaining = asRecord(bucket.remaining);
  if (!remaining) return null;
  const nested = remaining.case === "remainingFraction"
    ? num(remaining.value)
    : num(remaining.remainingFraction);
  return nested != null ? Math.max(0, Math.min(1, nested)) : null;
}

function normalizeGroupTitle(title: string): { displayTitle: string; rank: number } {
  const trimmed = title.trim();
  const lower = trimmed.toLowerCase();
  // Versioned experimental groups (e.g. "Gemini 4 Argon") keep their own label.
  if (lower.includes("gemini")) {
    return /\d/.test(trimmed)
      ? { displayTitle: trimmed, rank: 2 }
      : { displayTitle: "Gemini", rank: 0 };
  }
  if (lower.includes("claude") || lower.includes("gpt")) {
    return { displayTitle: "Claude/GPT", rank: 1 };
  }
  return { displayTitle: trimmed || "Quota", rank: 2 };
}

function normalizeWindowToken(value: string): string {
  let normalized = value.trim().toLowerCase().replace(/_/g, "-");
  if (normalized.endsWith(" limit")) {
    normalized = normalized.slice(0, -" limit".length).trim();
  }
  return normalized;
}

function matchesWindowAlias(candidate: string, alias: string): boolean {
  return candidate === alias || candidate.endsWith(`-${alias}`);
}

function classifyBucketWindow(
  bucketId: string,
  displayName: string,
  windowField: string | null,
): { windowMinutes: number | null; bucketTitle: string; rank: number } {
  const candidates = windowField ? [windowField] : [bucketId, displayName];
  for (const raw of candidates) {
    const normalized = normalizeWindowToken(raw);
    if (!normalized) continue;
    if (SESSION_WINDOW_ALIASES.some((alias) => matchesWindowAlias(normalized, alias))) {
      return { windowMinutes: 300, bucketTitle: "5-hour", rank: 0 };
    }
    if (matchesWindowAlias(normalized, "weekly")) {
      return { windowMinutes: 10080, bucketTitle: "weekly", rank: 1 };
    }
  }
  return { windowMinutes: null, bucketTitle: displayName, rank: 2 };
}

function isSuccessCode(code: unknown): boolean {
  if (code == null) return true;
  if (typeof code === "number") return code === 0;
  if (typeof code === "string") {
    const lower = code.trim().toLowerCase();
    return lower === "0" || lower === "ok" || lower === "success";
  }
  return false;
}

export function parseAntigravityQuotaSummary(text: string): NamedRateWindow[] | null {
  const root = asRecord(safeJson(text));
  if (!root || !isSuccessCode(root.code)) return null;
  const payload = asRecord(root.response) ?? asRecord(root.summary) ?? (Array.isArray(root.groups) ? root : null);
  if (!payload || !Array.isArray(payload.groups)) return null;

  const parsedGroups: {
    displayTitle: string;
    rank: number;
    index: number;
    buckets: { window: NamedRateWindow; rank: number; index: number }[];
  }[] = [];

  for (const [groupIndex, rawGroup] of payload.groups.entries()) {
    const group = asRecord(rawGroup);
    if (!group || !Array.isArray(group.buckets)) continue;
    const rawGroupTitle = nonEmptyString(group.displayName) ?? nonEmptyString(group.name) ?? "";
    const { displayTitle, rank: groupRank } = normalizeGroupTitle(rawGroupTitle);
    const buckets: { window: NamedRateWindow; rank: number; index: number }[] = [];

    for (const [bucketIndex, rawBucket] of group.buckets.entries()) {
      const bucket = asRecord(rawBucket);
      if (!bucket) continue;
      const rawId = nonEmptyString(bucket.bucketId) ?? nonEmptyString(bucket.id) ?? "";
      const rawName = nonEmptyString(bucket.displayName) ?? nonEmptyString(bucket.name) ?? "";
      const bucketId = rawId || rawName;
      if (!bucketId) continue;
      const displayName = rawName || bucketId;
      const remainingFraction = parseRemainingFraction(bucket);
      const disabled = bucket.disabled === true;
      const usageKnown = !disabled && remainingFraction != null;
      const usedPercent = usageKnown ? clampPercent(Math.round((1 - remainingFraction) * 1e8) / 1e6) : 0;
      const resetsAt = parseIsoOrUnix(bucket.resetTime);
      const resetDescription = nonEmptyString(bucket.description);
      const { windowMinutes, bucketTitle, rank: bucketRank } = classifyBucketWindow(
        bucketId,
        displayName,
        nonEmptyString(bucket.window),
      );
      buckets.push({
        rank: bucketRank,
        index: bucketIndex,
        window: {
          id: `antigravity-quota-summary-${bucketId}`,
          title: `${displayTitle} ${bucketTitle}`,
          window: {
            usedPercent,
            windowMinutes,
            resetsAt,
            resetDescription,
            ...(usageKnown ? {} : { usageKnown: false }),
          },
          usageKnown,
        },
      });
    }

    if (!buckets.length) continue;
    buckets.sort((a, b) => a.rank - b.rank || a.index - b.index);
    parsedGroups.push({ displayTitle, rank: groupRank, index: groupIndex, buckets });
  }

  if (!parsedGroups.length) return null;
  parsedGroups.sort((a, b) => a.rank - b.rank || a.index - b.index);
  const windows = parsedGroups.flatMap((g) => g.buckets.map((b) => b.window));
  return windows.some((w) => w.usageKnown) ? windows : null;
}

interface ModelQuotaEntry {
  label: string;
  modelId: string;
  remainingFraction: number | null;
  resetsAt: string | null;
  resetDescription: string | null;
}

function isRetiredFlashModelId(modelId: string): boolean {
  const lower = modelId.trim().toLowerCase();
  return lower.startsWith("gemini-3.6-flash")
    || lower.startsWith("gemini-3.5-flash")
    || lower === "gemini-3-flash-agent";
}

function humanizeModelLabel(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || (trimmed.includes(" ") && !trimmed.includes("_") && !trimmed.includes("-"))) return trimmed;
  let base = trimmed.replace(/^models\//i, "");
  let thinking = false;
  if (base.toLowerCase().endsWith("-thinking")) {
    base = base.slice(0, -"-thinking".length);
    thinking = true;
  }
  base = base.replace(/-(\d+)-(\d+)(?=-|$)/g, "-$1.$2");
  const words = base.split(/[-_]+/).filter(Boolean).map((token) => {
    const lower = token.toLowerCase();
    if (lower === "gpt") return "GPT";
    if (lower === "oss") return "OSS";
    if (/^[o]\d+$/i.test(token)) return token.toLowerCase();
    if (/^\d/.test(token)) return token;
    return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
  });
  const label = words.join(" ") || trimmed;
  return thinking ? `${label} (Thinking)` : label;
}

function compareRestrictiveness(a: ModelQuotaEntry, b: ModelQuotaEntry): number {
  const aKnown = a.remainingFraction != null ? 0 : 1;
  const bKnown = b.remainingFraction != null ? 0 : 1;
  if (aKnown !== bKnown) return aKnown - bKnown;
  if (a.remainingFraction != null && b.remainingFraction != null && Math.abs(a.remainingFraction - b.remainingFraction) > 1e-9) {
    return a.remainingFraction - b.remainingFraction;
  }
  const aTime = a.resetsAt ? Date.parse(a.resetsAt) : Number.POSITIVE_INFINITY;
  const bTime = b.resetsAt ? Date.parse(b.resetsAt) : Number.POSITIVE_INFINITY;
  if (aTime !== bTime) return aTime - bTime;
  return 0;
}

function normalizeModelQuotas(entries: ModelQuotaEntry[]): ModelQuotaEntry[] {
  const byModelId = new Map<string, ModelQuotaEntry>();
  for (const raw of entries) {
    const canonical = isRetiredFlashModelId(raw.modelId)
      ? { ...raw, modelId: CANONICAL_FLASH_ID, label: CANONICAL_FLASH_LABEL }
      : { ...raw, label: humanizeModelLabel(raw.label) };
    const key = canonical.modelId.trim().toLowerCase();
    const existing = byModelId.get(key);
    if (!existing || compareRestrictiveness(canonical, existing) < 0) {
      byModelId.set(key, canonical);
    }
  }
  return Array.from(byModelId.values());
}

function parseAvailableModels(text: string): ModelQuotaEntry[] {
  const root = asRecord(safeJson(text));
  const models = asRecord(root?.models);
  if (!models) return [];
  const entries: ModelQuotaEntry[] = [];
  for (const [modelId, rawModel] of Object.entries(models)) {
    const model = asRecord(rawModel);
    if (!model || model.isInternal === true) continue;
    const quota = asRecord(model.quotaInfo);
    if (!quota) continue;
    const remainingFraction = num(quota.remainingFraction);
    const resetsAt = parseIsoOrUnix(quota.resetTime);
    if (remainingFraction == null && !resetsAt) continue;
    entries.push({
      modelId,
      label: nonEmptyString(model.displayName) ?? modelId,
      remainingFraction: remainingFraction != null ? Math.max(0, Math.min(1, remainingFraction)) : null,
      resetsAt,
      resetDescription: null,
    });
  }
  return entries;
}

function parseRetrieveUserQuota(text: string): ModelQuotaEntry[] {
  const root = asRecord(safeJson(text));
  if (!root || !Array.isArray(root.buckets)) return [];
  const entries: ModelQuotaEntry[] = [];
  for (const rawBucket of root.buckets) {
    const bucket = asRecord(rawBucket);
    const modelId = nonEmptyString(bucket?.modelId);
    if (!bucket || !modelId) continue;
    const remainingFraction = num(bucket.remainingFraction);
    const resetsAt = parseIsoOrUnix(bucket.resetTime);
    if (remainingFraction == null && !resetsAt) continue;
    entries.push({
      modelId,
      label: modelId,
      remainingFraction: remainingFraction != null ? Math.max(0, Math.min(1, remainingFraction)) : null,
      resetsAt,
      resetDescription: null,
    });
  }
  return entries;
}

function mergeVerifiedQuotas(models: ModelQuotaEntry[], verified: ModelQuotaEntry[]): ModelQuotaEntry[] {
  const verifiedById = new Map<string, ModelQuotaEntry>();
  for (const entry of verified) {
    if (entry.remainingFraction == null) continue;
    const key = entry.modelId.toLowerCase();
    const existing = verifiedById.get(key);
    if (!existing || compareRestrictiveness(entry, existing) < 0) {
      verifiedById.set(key, entry);
    }
  }
  const merged: ModelQuotaEntry[] = [];
  const seen = new Set<string>();
  for (const model of models) {
    const key = model.modelId.toLowerCase();
    const match = verifiedById.get(key);
    if (!match) continue;
    seen.add(key);
    merged.push({
      ...model,
      remainingFraction: match.remainingFraction,
      resetsAt: match.resetsAt ?? model.resetsAt,
    });
  }
  for (const [key, entry] of verifiedById) {
    if (!seen.has(key)) merged.push(entry);
  }
  return merged;
}

type QuotaFamily = "geminiPro" | "geminiFlash" | "claudeModels" | "gpt" | "other";

function classifyModelFamily(entry: ModelQuotaEntry): QuotaFamily {
  const lower = `${entry.label} ${entry.modelId}`.toLowerCase();
  if (lower.includes("gemini") && lower.includes("pro")) return "geminiPro";
  if (lower.includes("gemini") && lower.includes("flash")) return "geminiFlash";
  if (lower.includes("claude") || lower.includes("anthropic") || lower.includes("sonnet") || lower.includes("opus") || lower.includes("haiku")) {
    return "claudeModels";
  }
  if (lower.includes("gpt") || lower.includes("openai") || /\bo[134]\b/.test(lower)) return "gpt";
  return "other";
}

function isExcludedFromSummaryPool(entry: ModelQuotaEntry): boolean {
  const lower = `${entry.label} ${entry.modelId}`.toLowerCase();
  return lower.includes("lite") || lower.includes("tab_") || lower.includes("autocomplete") || lower.includes("image");
}

function pickRepresentative(entries: ModelQuotaEntry[]): ModelQuotaEntry | null {
  if (!entries.length) return null;
  return [...entries].sort(compareRestrictiveness)[0] ?? null;
}

function toRateWindow(entry: ModelQuotaEntry): RateWindow {
  const usageKnown = entry.remainingFraction != null;
  return {
    usedPercent: usageKnown ? clampPercent(Math.round((1 - entry.remainingFraction!) * 1e8) / 1e6) : 0,
    windowMinutes: null,
    resetsAt: entry.resetsAt,
    resetDescription: entry.resetDescription,
    ...(usageKnown ? {} : { usageKnown: false }),
  };
}

function matchesPoolRepresentative(entry: ModelQuotaEntry, rep: ModelQuotaEntry | null): boolean {
  if (!rep) return false;
  const entryPct = entry.remainingFraction != null ? Math.round(entry.remainingFraction * 100) : -1;
  const repPct = rep.remainingFraction != null ? Math.round(rep.remainingFraction * 100) : -1;
  return entryPct === repPct && (entry.resetsAt ?? "") === (rep.resetsAt ?? "");
}

function buildModelWindows(rawQuotas: ModelQuotaEntry[]): {
  primary: RateWindow | null;
  secondary: RateWindow | null;
  extra: NamedRateWindow[];
} {
  const quotas = normalizeModelQuotas(rawQuotas);
  const eligible = quotas.filter((q) => !isExcludedFromSummaryPool(q));
  const geminiPro = eligible.filter((q) => classifyModelFamily(q) === "geminiPro");
  const geminiFlash = eligible.filter((q) => classifyModelFamily(q) === "geminiFlash");
  const claudeGpt = eligible.filter((q) => {
    const f = classifyModelFamily(q);
    return f === "claudeModels" || f === "gpt";
  });

  // Prefer Gemini Pro when measured; fall back to Gemini Flash before reset-only pools.
  const geminiRep = pickRepresentative(geminiPro.filter((q) => q.remainingFraction != null))
    ?? pickRepresentative(geminiFlash.filter((q) => q.remainingFraction != null))
    ?? pickRepresentative(geminiPro)
    ?? pickRepresentative(geminiFlash);
  const claudeGptRep = pickRepresentative(claudeGpt);

  const primary = geminiRep && geminiRep.remainingFraction != null ? toRateWindow(geminiRep) : null;
  const secondary = claudeGptRep && claudeGptRep.remainingFraction != null ? toRateWindow(claudeGptRep) : null;

  const extra: NamedRateWindow[] = [];
  if (geminiRep && geminiRep.remainingFraction == null) {
    extra.push({
      id: "gemini-models",
      title: "Gemini Models",
      window: toRateWindow(geminiRep),
      usageKnown: false,
    });
  }
  if (claudeGptRep && claudeGptRep.remainingFraction == null) {
    extra.push({
      id: "claude-gpt",
      title: "Claude/GPT",
      window: toRateWindow(claudeGptRep),
      usageKnown: false,
    });
  }

  const seenIds = new Set<string>(extra.map((w) => w.id));
  for (const entry of quotas) {
    if (isExcludedFromSummaryPool(entry)) continue;
    const family = classifyModelFamily(entry);
    const poolRep = family === "geminiPro" || family === "geminiFlash"
      ? geminiRep
      : family === "claudeModels" || family === "gpt"
        ? claudeGptRep
        : null;
    if (matchesPoolRepresentative(entry, poolRep)) continue;
    const id = slug(entry.label) || slug(entry.modelId);
    if (!id || seenIds.has(id)) continue;
    seenIds.add(id);
    extra.push({
      id,
      title: entry.label,
      window: toRateWindow(entry),
      usageKnown: entry.remainingFraction != null,
    });
  }

  return { primary, secondary, extra };
}

function checkCloudCodeResponse(res: HttpResponse): void {
  if (res.status === 401) throw new UnauthorizedError();
  if (res.status === 429) throw new RateLimitedError(retryAfterSeconds(res.headers));
  if (res.status >= 400) throw new UpstreamError(res.status, res.body.slice(0, 200));
}

async function fetchModelQuotas(
  projectId: string | null,
  headers: Record<string, string>,
  ctx: FetchContext,
): Promise<ModelQuotaEntry[]> {
  const payload = JSON.stringify(projectId ? { project: projectId } : {});
  const modelsRes = await ctx.http.post(FETCH_AVAILABLE_MODELS_URL, payload, headers, { timeoutMs: 15_000 });
  if (modelsRes.status === 403) {
    const quotaRes = await ctx.http.post(RETRIEVE_USER_QUOTA_URL, payload, headers, { timeoutMs: 15_000 });
    if (quotaRes.status === 403) return [];
    checkCloudCodeResponse(quotaRes);
    return parseRetrieveUserQuota(quotaRes.body);
  }
  checkCloudCodeResponse(modelsRes);
  const modelQuotas = parseAvailableModels(modelsRes.body);
  if (modelQuotas.length > 0 && modelQuotas.every((q) => (q.remainingFraction ?? 0) >= 0.999)) {
    // Unverified all-100% responses from fetchAvailableModels can be placeholder values.
    const quotaRes = await ctx.http.post(RETRIEVE_USER_QUOTA_URL, payload, headers, { timeoutMs: 15_000 });
    if (quotaRes.status === 401) throw new UnauthorizedError();
    if (quotaRes.status === 429) throw new RateLimitedError(retryAfterSeconds(quotaRes.headers));
    if (quotaRes.status !== 200) return [];
    const verified = parseRetrieveUserQuota(quotaRes.body);
    if (!verified.some((q) => q.remainingFraction != null)) return [];
    return mergeVerifiedQuotas(modelQuotas, verified);
  }
  return modelQuotas;
}

const antigravityOAuthStrategy: ProviderFetchStrategy = {
  id: "antigravity-oauth",
  sourceMode: "oauth",
  isAvailable: (c) => !!c.bearerToken?.trim(),
  shouldFallback: () => false,
  async fetch(c, ctx) {
    const token = c.bearerToken!.trim().replace(/^Bearer(?:\s+|$)/i, "").trim();
    if (!token || /\s/.test(token)) throw new UnauthorizedError();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    };

    const codeAssistRes = await ctx.http.post(
      LOAD_CODE_ASSIST_URL,
      JSON.stringify({ metadata: CLIENT_METADATA }),
      headers,
      { timeoutMs: 15_000 },
    );
    checkCloudCodeResponse(codeAssistRes);
    const codeAssist = asRecord(safeJson(codeAssistRes.body));
    if (!codeAssist) throw new UpstreamError(codeAssistRes.status, "invalid JSON");

    const storedProjectId = nonEmptyString(c.extra?.projectId);
    if (rejectsClientForConsumerTier(codeAssist, storedProjectId)) {
      throw new UnauthorizedError("当前 Antigravity OAuth 客户端无法读取个人账户配额，请重新登录并更新凭据");
    }

    let projectId = storedProjectId ?? parseProjectRef(codeAssist.cloudaicompanionProject);
    if (!projectId) {
      const tierId = pickOnboardTierId(codeAssist);
      if (tierId) {
        try {
          const onboardRes = await ctx.http.post(
            ONBOARD_USER_URL,
            JSON.stringify({ tierId, metadata: CLIENT_METADATA }),
            headers,
            { timeoutMs: 10_000, retry: false },
          );
          if (onboardRes.status === 200) {
            const onboard = asRecord(safeJson(onboardRes.body));
            projectId = parseProjectRef(asRecord(onboard?.response)?.cloudaicompanionProject);
          }
        } catch {
          // Optional onboarding fallback must not abort quota lookup.
        }
      }
    }

    const tokenClaims = extractAntigravityJwtClaims(c.extra?.idToken);
    const accountEmail = nonEmptyString(c.extra?.email) ?? tokenClaims.email;
    const hostedDomain = nonEmptyString(c.extra?.hostedDomain) ?? tokenClaims.hostedDomain;
    let plan = resolvePlan(codeAssist, hostedDomain);

    let summaryWindows: NamedRateWindow[] | null = null;
    try {
      const summaryRes = await ctx.http.post(
        QUOTA_SUMMARY_URL,
        JSON.stringify(projectId ? { project: projectId } : {}),
        headers,
        { timeoutMs: 10_000, retry: false },
      );
      if (summaryRes.status === 401) throw new UnauthorizedError();
      if (summaryRes.status === 429) throw new RateLimitedError(retryAfterSeconds(summaryRes.headers));
      if (summaryRes.status === 200) {
        summaryWindows = parseAntigravityQuotaSummary(summaryRes.body);
      }
    } catch (error) {
      if (error instanceof UnauthorizedError || error instanceof RateLimitedError) throw error;
    }

    if (summaryWindows) {
      // Suppress contradictory "Free" plan badge when an active 5-hour session quota window exists.
      if (plan?.toLowerCase() === "free" && summaryWindows.some((w) => w.usageKnown && w.window.windowMinutes === 300)) {
        plan = null;
      }
      const identity: ProviderIdentitySnapshot | null = accountEmail || plan ? {
        providerID: "antigravity",
        accountEmail,
        loginMethod: plan ? `Plan: ${plan}` : null,
      } : null;
      return {
        provider: "antigravity",
        primary: null,
        secondary: null,
        tertiary: null,
        extraRateWindows: summaryWindows,
        identity,
        dataConfidence: "exact",
        updatedAt: ctx.now.toISOString(),
      };
    }

    const modelQuotas = await fetchModelQuotas(projectId, headers, ctx);
    const { primary, secondary, extra } = buildModelWindows(modelQuotas);
    const identity: ProviderIdentitySnapshot | null = accountEmail || plan ? {
      providerID: "antigravity",
      accountEmail,
      loginMethod: plan ? `Plan: ${plan}` : null,
    } : null;

    const snapshot: UsageSnapshot = {
      provider: "antigravity",
      primary,
      secondary,
      tertiary: null,
      extraRateWindows: extra.length ? extra : null,
      identity,
      dataConfidence: primary || secondary || extra.some((w) => w.usageKnown) ? "exact" : "unknown",
      updatedAt: ctx.now.toISOString(),
    };
    return snapshot;
  },
};

async function refresh(creds: ProviderCredentials, ctx: FetchContext): Promise<RefreshResult> {
  const refreshToken = creds.refreshToken?.trim();
  const clientSecret = creds.extra?.clientSecret?.trim();
  if (!refreshToken || !clientSecret) {
    throw new RefreshRejectedError("Antigravity 自动续期缺少 Refresh Token 或 Client Secret，请重新导入凭据");
  }
  const clientId = creds.extra?.clientId?.trim() || ANTIGRAVITY_DEFAULT_CLIENT_ID;
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  }).toString();
  const res = await ctx.http.post(
    TOKEN_URL,
    body,
    { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    { timeoutMs: 15_000, retry: false },
  );
  const next = decodeRefreshResponse(res, creds, ctx.now);
  const json = asRecord(safeJson(res.body));
  const idToken = nonEmptyString(json?.id_token);
  if (idToken) {
    const claims = extractAntigravityJwtClaims(idToken);
    next.extra = {
      ...next.extra,
      ...(claims.email ? { email: claims.email } : {}),
      ...(claims.hostedDomain ? { hostedDomain: claims.hostedDomain } : {}),
    };
  }
  return { credentials: next };
}

const CREDENTIAL_FIELDS: CredentialField[] = [
  {
    key: "bearerToken",
    label: "OAuth Access Token",
    required: true,
    secret: true,
    placeholder: "ya29....",
    help: "可从 ~/.gemini/antigravity-cli/antigravity-oauth-token 或 OAuth 凭据 JSON 导入，或填写 access_token",
  },
  {
    key: "refreshToken",
    label: "Refresh Token（可选，用于自动续期）",
    required: false,
    secret: true,
    placeholder: "1//...",
    help: "对应 refresh_token；配合 Client Secret 支持自动刷新",
  },
  {
    key: "extra.clientSecret",
    label: "OAuth Client Secret（自动续期时必填）",
    required: false,
    secret: true,
    placeholder: "GOCSPX-...",
    help: "对应 client_secret，从凭据 JSON 导入时自动填写",
  },
  {
    key: "extra.clientId",
    label: "OAuth Client ID（可选）",
    required: false,
    secret: false,
    placeholder: ANTIGRAVITY_DEFAULT_CLIENT_ID,
    help: "对应 client_id；留空时使用 Antigravity 默认 OAuth Client ID",
  },
  {
    key: "extra.projectId",
    label: "Cloud Code Project ID（可选）",
    required: false,
    secret: false,
    placeholder: "cloudaicompanion-...",
    help: "对应 project_id；留空时由接口自动解析",
  },
  {
    key: "extra.email",
    label: "账户邮箱（可选）",
    required: false,
    secret: false,
    placeholder: "user@example.com",
    help: "从 JSON 导入或刷新 id_token 时自动提取",
  },
  {
    key: "extra.hostedDomain",
    label: "Workspace 域名（可选）",
    required: false,
    secret: false,
    placeholder: "example.com",
    help: "对应 id_token 中的 hd，从 JSON 导入或刷新时自动提取",
  },
  {
    key: "expiresAt",
    label: "过期时间（可选）",
    required: false,
    secret: false,
    placeholder: "2026-11-13T12:00:00Z",
    help: "对应 expiry_date / expiry；从 JSON 导入时自动转换",
  },
];

export const antigravityDescriptor: ProviderDescriptor = {
  provider: "antigravity",
  label: "Antigravity (Google OAuth)",
  accentColor: "#60ba7e",
  producesRateWindows: true,
  refreshLeadTimeMs: 60_000,
  credentialFields: CREDENTIAL_FIELDS,
  resolveStrategies: (mode) => (mode === "auto" || mode === "oauth" ? [antigravityOAuthStrategy] : []),
  refresh,
};
