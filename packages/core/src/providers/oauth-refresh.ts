import type { ProviderCredentials } from "../adapter";
import { RateLimitedError, RefreshRejectedError, UpstreamError } from "../adapter";
import type { HttpResponse } from "../http";
import { asRecord, nonEmptyString, num, retryAfterSeconds, safeJson } from "../decode";

const TERMINAL_ERRORS = new Set([
  "invalid_grant", "invalid_client", "refresh_token_expired", "refresh_token_reused", "refresh_token_invalidated",
]);

export function decodeRefreshResponse(res: HttpResponse, creds: ProviderCredentials, now: Date): ProviderCredentials {
  const json = asRecord(safeJson(res.body));
  if (res.status === 429) throw new RateLimitedError(retryAfterSeconds(res.headers));
  if (res.status !== 200) {
    const code = nonEmptyString(asRecord(json?.error)?.code)
      ?? nonEmptyString(json?.error) ?? nonEmptyString(json?.code);
    // Error descriptions can contain credentials; only emit a fixed, actionable message.
    if (TERMINAL_ERRORS.has(code?.toLowerCase() ?? "") || res.status === 401) {
      throw new RefreshRejectedError("刷新凭据已失效，请重新登录并更新凭据");
    }
    throw new UpstreamError(res.status, "token refresh failed");
  }
  const accessToken = nonEmptyString(json?.access_token);
  if (!accessToken || /\s/.test(accessToken)) throw new UpstreamError(undefined, "invalid token refresh response");
  const seconds = num(json?.expires_in);
  const expiresAt = seconds != null && seconds > 0 && seconds < 365 * 86400
    ? new Date(now.getTime() + seconds * 1000).toISOString() : null;
  return {
    ...creds,
    bearerToken: accessToken,
    refreshToken: nonEmptyString(json?.refresh_token) ?? creds.refreshToken,
    expiresAt,
    refreshState: undefined,
  };
}
