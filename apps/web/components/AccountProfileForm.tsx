"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { AccountMeta, ProviderMeta } from "@/lib/provider-management";

export function AccountProfileForm({ account, providers, groups, initialGroup = "", onBusyChange, onSaved }: {
  account?: AccountMeta; providers: ProviderMeta[]; groups: string[]; initialGroup?: string;
  onBusyChange: (value: boolean) => void; onSaved: (account: AccountMeta) => Promise<void>;
}) {
  const [provider, setProvider] = useState(account?.provider ?? providers[0]?.provider ?? "codex");
  const [alias, setAlias] = useState(account?.alias ?? "");
  const [group, setGroup] = useState(account?.groupName ?? initialGroup);
  const [busy, setBusy] = useState(false);
  const [createdAccount, setCreatedAccount] = useState<AccountMeta | null>(null);
  const [feedback, setFeedback] = useState<{ error?: boolean; text: string } | null>(null);
  const pending = useRef(false);
  const feedbackRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (feedback) feedbackRef.current?.focus(); }, [feedback]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending.current) return;
    pending.current = true; setBusy(true); onBusyChange(true); setFeedback(null);
    let saved = false;
    try {
      if (createdAccount) {
        saved = true;
        await onSaved(createdAccount);
        return;
      }
      const res = await fetch("/api/accounts", {
        method: account ? "PATCH" : "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(account ? { accountId: account.id, alias, groupName: group } : { provider, alias, groupName: group }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "保存失败，请重试。");
      saved = true;
      if (!account) setCreatedAccount(data.account);
      await onSaved(data.account);
      setFeedback({ text: "账号信息已保存。" });
    } catch (e) {
      setFeedback({ error: true, text: saved ? "账号已保存，但列表更新失败，请重新加载账号。" : e instanceof Error ? e.message : "保存失败，请重试。" });
    } finally { pending.current = false; setBusy(false); onBusyChange(false); }
  }

  return (
    <form className="account-profile" onSubmit={submit} aria-label={account ? "账号信息" : "新增账号"}>
      <h3>{account ? "账号信息" : "添加一个服务账号"}</h3>
      {!account && <label className="account-label" htmlFor="account-provider">服务商
        <select id="account-provider" className="field" value={provider} disabled={busy || !!createdAccount} onChange={(event) => setProvider(event.target.value)}>
          {providers.map((item) => <option key={item.provider} value={item.provider}>{item.label}</option>)}
        </select>
      </label>}
      <label className="account-label" htmlFor="account-alias">账号别名
        <input id="account-alias" className="field" required maxLength={80} autoComplete="off" disabled={busy || !!createdAccount}
          placeholder="例如：工作账号、个人账号" value={alias} onChange={(event) => { setAlias(event.target.value); setFeedback(null); }} />
      </label>
      <label className="account-label" htmlFor="account-group">分组（可选）
        <input id="account-group" className="field" list="account-groups" maxLength={80} autoComplete="off" disabled={busy || !!createdAccount}
          placeholder="选择已有分组，或输入新分组" value={group} onChange={(event) => { setGroup(event.target.value); setFeedback(null); }} />
      </label>
      <datalist id="account-groups">{groups.map((name) => <option key={name} value={name} />)}</datalist>
      <p className="management-help">{account ? "修改别名和分组会保留凭据、历史记录和提醒状态。" : "创建后可配置凭据。同一服务商可以添加多个账号。"}</p>
      {feedback && <p ref={feedbackRef} tabIndex={-1} className={`management-feedback${feedback.error ? " error" : ""}`} role={feedback.error ? "alert" : "status"}>{feedback.text}</p>}
      <div className="account-form-actions"><button type="submit" className={account ? "management-action" : "btn-primary"} disabled={busy || !alias.trim()}>{busy ? "保存中…" : createdAccount ? "重新加载账号" : account ? "保存账号信息" : "创建并配置凭据"}</button></div>
    </form>
  );
}
