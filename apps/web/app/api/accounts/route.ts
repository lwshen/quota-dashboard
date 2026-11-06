import { NextResponse } from "next/server";
import { isProvider } from "@quota/core";
import { createAccount, deleteAccount, getAccount, listAccounts, updateAccount } from "@/server/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function validName(value: unknown, required = false): value is string {
  return typeof value === "string" && value.trim().length <= 80 && (!required || value.trim().length > 0)
    && !/[\x00-\x1f\x7f]/.test(value);
}

export async function GET() {
  return NextResponse.json({ accounts: listAccounts() }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(req: Request) {
  let body;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid JSON" }, { status: 400 }); }
  if (!body || typeof body.provider !== "string" || !isProvider(body.provider) || body.provider === "codex2"
    || !validName(body.alias, true) || (body.groupName !== undefined && !validName(body.groupName))) {
    return NextResponse.json({ error: "请选择服务商，并填写 1–80 字的别名；分组最多 80 字，不能包含控制字符。" }, { status: 400 });
  }
  const account = createAccount(body.provider, body.alias.trim(), body.groupName?.trim() ?? "");
  return NextResponse.json({ account }, { status: 201 });
}

export async function PATCH(req: Request) {
  let body;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid JSON" }, { status: 400 }); }
  if (!body || typeof body.accountId !== "string" || (body.alias !== undefined && !validName(body.alias, true))
    || (body.groupName !== undefined && !validName(body.groupName))
    || (body.enabled !== undefined && typeof body.enabled !== "boolean")
    || body.provider !== undefined || (body.alias === undefined && body.groupName === undefined && body.enabled === undefined)) {
    return NextResponse.json({ error: "账号信息格式不正确；服务商创建后不能更改。" }, { status: 400 });
  }
  if (!getAccount(body.accountId)) return NextResponse.json({ error: "账号不存在" }, { status: 404 });
  updateAccount(body.accountId, { alias: body.alias?.trim(), groupName: body.groupName?.trim(), enabled: body.enabled });
  return NextResponse.json({ account: getAccount(body.accountId) });
}

export async function DELETE(req: Request) {
  const id = new URL(req.url).searchParams.get("accountId");
  if (!id || !getAccount(id)) return NextResponse.json({ error: "账号不存在" }, { status: 404 });
  deleteAccount(id);
  return NextResponse.json({ ok: true });
}
