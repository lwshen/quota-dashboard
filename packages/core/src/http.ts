// Runs on Node (server side), so it can set headers browsers forbid (Cookie/User-Agent); hence a backend proxy is required.

export interface HttpOptions {
  timeoutMs?: number;
  /**
   * Transport-level retry. Defaults to a single retry for idempotent methods (GET/HEAD/OPTIONS),
   * none for others. Pass `false` to disable, or a policy to override.
   */
  retry?: RetryPolicy | false;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface HttpClient {
  get(url: string, headers?: Record<string, string>, opts?: HttpOptions): Promise<HttpResponse>;
  post(url: string, body: string, headers?: Record<string, string>, opts?: HttpOptions): Promise<HttpResponse>;
}

export interface RetryPolicy {
  maxRetries: number;
  retryableStatusCodes: number[];
  baseDelayMs: number;
  maxDelayMs: number;
}

// One retry on transient status codes, honoring Retry-After and otherwise backing off
// exponentially, capped at 10s.
export const TRANSIENT_IDEMPOTENT_RETRY: RetryPolicy = {
  maxRetries: 1,
  retryableStatusCodes: [408, 429, 500, 502, 503, 504],
  baseDelayMs: 1_000,
  maxDelayMs: 10_000,
};

export const DISABLED_RETRY: RetryPolicy = {
  maxRetries: 0,
  retryableStatusCodes: [],
  baseDelayMs: 0,
  maxDelayMs: 0,
};

const DEFAULT_TIMEOUT = 30_000;
const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function resolvePolicy(method: string, opts?: HttpOptions): RetryPolicy {
  if (opts?.retry === false) return DISABLED_RETRY;
  if (opts?.retry) return opts.retry;
  return IDEMPOTENT_METHODS.has(method) ? TRANSIENT_IDEMPOTENT_RETRY : DISABLED_RETRY;
}

// Prefer a numeric Retry-After header (seconds), else exponential backoff; both capped at maxDelayMs.
function retryDelayMs(policy: RetryPolicy, attempt: number, headers: Record<string, string> | null): number {
  const ra = headers?.["retry-after"];
  if (ra) {
    const seconds = Number(ra.trim());
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, policy.maxDelayMs);
  }
  if (policy.baseDelayMs <= 0) return 0;
  return Math.min(policy.baseDelayMs * 2 ** attempt, policy.maxDelayMs);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function once(
  method: string,
  url: string,
  body: string | undefined,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<HttpResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method, headers, body, signal: controller.signal, redirect: "follow" });
    const text = await res.text();
    const h: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      h[k.toLowerCase()] = v;
    });
    return { status: res.status, headers: h, body: text };
  } finally {
    clearTimeout(timer);
  }
}

async function request(
  method: string,
  url: string,
  body: string | undefined,
  headers: Record<string, string>,
  opts?: HttpOptions,
): Promise<HttpResponse> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT;
  const policy = resolvePolicy(method, opts);
  let attempt = 0;
  // Retry is transport-level and transparent: callers still see the final status code.
  while (true) {
    try {
      const res = await once(method, url, body, headers, timeoutMs);
      if (attempt < policy.maxRetries && policy.retryableStatusCodes.includes(res.status)) {
        await sleep(retryDelayMs(policy, attempt, res.headers));
        attempt += 1;
        continue;
      }
      return res;
    } catch (e) {
      // Network failure / timeout: retry idempotent requests, else surface the error.
      if (attempt < policy.maxRetries) {
        await sleep(retryDelayMs(policy, attempt, null));
        attempt += 1;
        continue;
      }
      throw e;
    }
  }
}

export const nodeHttpClient: HttpClient = {
  get: (url, headers = {}, opts) => request("GET", url, undefined, headers, opts),
  post: (url, body, headers = {}, opts) => request("POST", url, body, headers, opts),
};
