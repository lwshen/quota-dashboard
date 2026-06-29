// Runs on Node (server side), so it can set headers browsers forbid (Cookie/User-Agent); hence a backend proxy is required.

export interface HttpOptions {
  timeoutMs?: number;
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

const DEFAULT_TIMEOUT = 30_000;

async function request(
  method: string,
  url: string,
  body: string | undefined,
  headers: Record<string, string>,
  opts?: HttpOptions,
): Promise<HttpResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? DEFAULT_TIMEOUT);
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

export const nodeHttpClient: HttpClient = {
  get: (url, headers = {}, opts) => request("GET", url, undefined, headers, opts),
  post: (url, body, headers = {}, opts) => request("POST", url, body, headers, opts),
};
