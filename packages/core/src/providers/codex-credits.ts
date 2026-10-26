import type { FetchContext } from "../adapter";
import type { ProviderCostSnapshot } from "../model";
import { asRecord, clampPercent, nonEmptyString, num, parseIsoOrUnix, safeJson } from "../decode";

interface CreditLimit {
  used: number;
  limit: number;
  resetsAt: string | null;
}

function creditLimit(value: unknown): CreditLimit | null {
  const node = asRecord(value);
  const limit = num(node?.limit);
  if (limit == null || limit <= 0) return null;
  const remaining = num(node?.remaining_percent ?? node?.remainingPercent);
  const reportedUsed = num(node?.used);
  if (reportedUsed == null && remaining == null
    && (node?.used != null || node?.remaining_percent != null || node?.remainingPercent != null)) return null;
  const used = reportedUsed ?? (remaining != null ? limit * ((100 - clampPercent(remaining)) / 100) : 0);
  return {
    used: Math.max(0, used), limit,
    resetsAt: parseIsoOrUnix(node?.reset_at ?? node?.resets_at ?? node?.resetsAt),
  };
}

function monthlyLimit(value: unknown): CreditLimit | null {
  const node = asRecord(value);
  const effective = asRecord(node?.effective_monthly_limit);
  const limit = num(effective?.limit);
  const mode = nonEmptyString(effective?.enforcement_mode)?.toLowerCase();
  if (effective?.enforcement_mode != null && !mode) return null;
  if (mode && ["none", "off", "disabled", "no_limit"].includes(mode)) return null;
  if (limit == null || limit <= 0) return null;
  const used = num(node?.current_month_usage);
  if (node?.current_month_usage != null && used == null) return null;
  return { used: Math.max(0, used ?? 0), limit, resetsAt: null };
}

export async function codexCredits(
  usage: Record<string, unknown>, accountId: string | undefined, headers: Record<string, string>, ctx: FetchContext,
): Promise<ProviderCostSnapshot | null> {
  const rateLimit = asRecord(usage.rate_limit);
  const spendControl = asRecord(usage.spend_control) ?? asRecord(usage.spendControl);
  // Resolve source precedence before mapping the cap.
  const limitNode = usage.individual_limit ?? usage.individualLimit
    ?? rateLimit?.individual_limit ?? rateLimit?.individualLimit
    ?? spendControl?.individual_limit ?? spendControl?.individualLimit;
  let cap = creditLimit(limitNode);
  const plan = nonEmptyString(usage.plan_type)?.toLowerCase();
  const personalPlan = plan != null && ["guest", "free", "go", "plus", "pro"].includes(plan);
  if (!cap && accountId && ("spend_control" in usage || "spendControl" in usage) && !personalPlan) {
    try {
      const url = `https://chatgpt.com/backend-api/accounts/${encodeURIComponent(accountId)}/spend-controls/current-user/monthly-usage`;
      const res = await ctx.http.get(url, headers, { timeoutMs: 6_000, retry: false });
      if (res.status === 200) cap = monthlyLimit(safeJson(res.body));
    } catch {
      // Optional workspace billing must not discard usable quota or purchased credits.
    }
  }

  const credits = asRecord(usage.credits);
  const reportedBalance = credits?.has_credits === true && credits.unlimited !== true ? num(credits.balance) : undefined;
  let balance = reportedBalance != null && reportedBalance >= 0 ? reportedBalance : null;
  // Some accounts repeat the monthly pool remainder as credits.balance.
  if (cap && balance != null && Math.abs(balance - Math.max(0, cap.limit - cap.used)) <= 0.0001) balance = null;
  if (!cap && balance == null) return null;
  return {
    used: cap?.used ?? 0, limit: cap?.limit ?? 0, balance,
    currencyCode: "Credits", period: cap ? "Monthly credit limit" : "Credits balance", resetsAt: cap?.resetsAt ?? null,
  };
}
