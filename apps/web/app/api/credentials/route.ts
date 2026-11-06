import { NextResponse } from "next/server";
import type { ProviderCredentials, SourceMode } from "@quota/core";
import { getDescriptor, isProvider } from "@quota/core";
import { deleteCredential, getAccount, getCredential, listCredentials, listSnapshots, saveCredential, updateCredentialSecret } from "@/server/storage";
import { CredentialInputError, prepareCredentialInput } from "@/server/credentials/input";
import { fetchAndStore } from "@/server/usage/fetcher";
import { assertSafeBaseUrl } from "@/server/security/ssrf";
import { normalizeGrokCredentials } from "@quota/core/grok-auth";
import { resetHealthAlertState } from "@/server/notify/alerts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Never return any secret.
export async function GET() {
  const snapshots = new Map(listSnapshots().map((s) => [s.provider, s]));
  const credentials = listCredentials().map((c) => ({
    accountId: c.accountId,
    provider: c.provider,
    enabled: c.enabled,
    mode: c.mode,
    configuredKeys: getDescriptor(c.provider).credentialFields
      .filter((field) => {
        const value = field.key.startsWith("extra.") ? c.credentials.extra?.[field.key.slice(6)]
          : c.credentials[field.key as keyof ProviderCredentials];
        return value != null && value !== "";
      })
      .map((field) => field.key),
    updatedAt: c.updatedAt,
    fetchedAt: snapshots.get(c.accountId)?.fetchedAt ?? null,
    fetchError: snapshots.get(c.accountId)?.error ?? null,
  }));
  return NextResponse.json({ credentials });
}

export async function POST(req: Request) {
  let body: { accountId?: string; provider?: string; mode?: SourceMode; fields?: Record<string, unknown>; action?: "update" | "replace"; clearFields?: string[]; confirmSameAccount?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  if (!body || typeof body !== "object" || Array.isArray(body) ||
    (body.accountId !== undefined && typeof body.accountId !== "string") ||
    (body.provider !== undefined && typeof body.provider !== "string") ||
    (body.fields != null && (typeof body.fields !== "object" || Array.isArray(body.fields))) ||
    (body.action != null && body.action !== "update" && body.action !== "replace") ||
    (body.mode != null && !["auto", "api", "oauth", "web"].includes(body.mode)) ||
    (body.clearFields != null && (!Array.isArray(body.clearFields) || body.clearFields.some((key) => typeof key !== "string")))) {
    return NextResponse.json({ error: "凭据请求格式不正确" }, { status: 400 });
  }
  const accountId = body.accountId ?? body.provider ?? "";
  const account = getAccount(accountId);
  const provider = account?.provider ?? (body.accountId === undefined && isProvider(accountId) ? accountId : null);
  if (!provider) return NextResponse.json({ error: "账号不存在" }, { status: 404 });
  if (body.accountId && body.provider && body.provider !== provider) return NextResponse.json({ error: "服务商与账号不匹配" }, { status: 400 });

  const desc = getDescriptor(provider);
  const existing = getCredential(accountId);
  if (body.action === "update" && body.mode != null && body.mode !== existing?.mode) {
    return NextResponse.json({ error: "修改数据源模式时请替换整套凭据" }, { status: 400 });
  }
  const mode = body.mode ?? (body.action === "update" ? existing?.mode : undefined) ?? "auto";
  const fields = body.fields ?? {};

  let creds: ProviderCredentials;
  try {
    creds = prepareCredentialInput(desc, fields, {
      action: body.action ?? "replace", existing: existing?.credentials,
      clearFields: body.clearFields ?? [], confirmSameAccount: body.confirmSameAccount === true,
    });
  } catch (error) {
    if (error instanceof CredentialInputError) {
      return NextResponse.json({ error: error.message, fieldErrors: error.fieldErrors }, { status: 400 });
    }
    throw error;
  }

  if (provider === "grok") {
    try { creds = normalizeGrokCredentials(creds); } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : "Grok 凭据格式不正确" }, { status: 400 });
    }
  }

  // SSRF: baseUrlOverride must be a public https URL.
  if (creds.baseUrlOverride) {
    try {
      await assertSafeBaseUrl(creds.baseUrlOverride);
    } catch (e) {
      return NextResponse.json({ error: `Base URL 不被接受: ${e instanceof Error ? e.message : String(e)}` }, { status: 400 });
    }
  }

  const now = new Date();
  if (account && !getAccount(accountId)) return NextResponse.json({ error: "账号已被删除，请重新打开账号管理。" }, { status: 409 });
  if (body.action === "update") {
    if (!existing || !updateCredentialSecret(accountId, creds, now, existing.revision)) {
      return NextResponse.json({ error: "凭据已被其他请求更新，请重新打开配置后重试" }, { status: 409 });
    }
    resetHealthAlertState(accountId);
  } else {
    saveCredential(accountId, mode, creds, now);
  }
  if (!getCredential(accountId)?.enabled) return NextResponse.json({ ok: true, disabled: true });
  const result = await fetchAndStore(accountId);
  return NextResponse.json({ ok: true, result });
}

export async function DELETE(req: Request) {
  const params = new URL(req.url).searchParams;
  const accountId = params.get("accountId") ?? params.get("provider") ?? "";
  if (!getAccount(accountId)) return NextResponse.json({ error: "账号不存在" }, { status: 404 });
  deleteCredential(accountId);
  return NextResponse.json({ ok: true });
}
