"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useModalDialog } from "@/lib/hooks";
import { splitLabel } from "@/lib/format";
import { credentialStatus, type AccountMeta, type CredentialMeta, type ProviderMeta } from "@/lib/provider-management";
import { AddCredentialForm } from "./AddCredentialForm";
import { AccountProfileForm } from "./AccountProfileForm";

export function ProviderSettings({ initialProvider, onClose, onChanged }: {
  initialProvider?: string; onClose: () => void; onChanged: () => Promise<void>;
}) {
  const [providers, setProviders] = useState<ProviderMeta[]>([]);
  const [accounts, setAccounts] = useState<AccountMeta[]>([]);
  const [credentials, setCredentials] = useState<CredentialMeta[]>([]);
  const [selected, setSelected] = useState<string | null>(initialProvider ?? null);
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "unconfigured" | "error">("all");
  const [group, setGroup] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const dialog = useModalDialog();
  const title = useRef<HTMLHeadingElement>(null);
  const listFocus = useRef<string | null>(null);
  const toggleFocus = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    const responses = await Promise.all(["providers", "accounts", "credentials"].map((path) => fetch(`/api/${path}`, { cache: "no-store", signal })));
    if (responses.some((res) => !res.ok)) throw new Error("账号设置加载失败，请重试；登录过期时请重新登录。");
    const [providerData, accountData, credentialData] = await Promise.all(responses.map((res) => res.json()));
    setProviders(providerData.providers); setAccounts(accountData.accounts); setCredentials(credentialData.credentials);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal).catch((e) => { if (!controller.signal.aborted) setError(e.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [load]);

  useEffect(() => {
    if (loading) return;
    dialog.current?.querySelector(".management-body")?.scrollTo({ top: 0 });
    const target = !selected && !creating && listFocus.current ? document.getElementById(`manage-${listFocus.current}`) : null;
    (target ?? title.current)?.focus();
    if (!selected && !creating) listFocus.current = null;
  }, [selected, creating, loading, dialog]);

  useEffect(() => { if (!busy && toggleFocus.current) { toggleFocus.current.focus({ preventScroll: true }); toggleFocus.current = null; } }, [busy]);
  useEffect(() => { if (confirmDelete) dialog.current?.querySelector<HTMLButtonElement>(".account-delete-confirm .account-delete")?.focus(); }, [confirmDelete, dialog]);
  useEffect(() => { if (group && !accounts.some((item) => item.groupName === group)) setGroup(""); }, [accounts, group]);

  async function changed() { await Promise.all([load(), onChanged()]); }
  async function retryLoad() {
    setLoading(true); setError(null);
    try { await changed(); } catch (e) { setError(e instanceof Error ? e.message : "加载失败，请重试。"); }
    finally { setLoading(false); }
  }
  function open(id: string) {
    listFocus.current = id; setSelected(id); setCreating(false); setConfirmDelete(false); setError(null); setNotice(null);
  }
  function back() { setSelected(null); setCreating(false); setConfirmDelete(false); setError(null); setNotice(null); }
  async function toggle(account: AccountMeta, trigger: HTMLInputElement) {
    if (busy) return;
    toggleFocus.current = trigger; setBusy(true); setError(null); setNotice(null);
    setAccounts((items) => items.map((item) => item.id === account.id ? { ...item, enabled: !account.enabled } : item));
    let saved = false;
    try {
      const res = await fetch("/api/accounts", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accountId: account.id, enabled: !account.enabled }) });
      if (!res.ok) throw new Error((await res.json()).error ?? "保存失败，请重试。");
      saved = true;
      await changed();
      setNotice(account.enabled ? "账号已停用，凭据和历史数据保留。" : "账号已启用，将在下次刷新时获取用量。");
    } catch (e) {
      if (!saved) setAccounts((items) => items.map((item) => item.id === account.id ? { ...item, enabled: account.enabled } : item));
      setError(saved ? "开关已保存，但列表更新失败，请重新加载。" : e instanceof Error ? e.message : "保存失败，请重试。");
    }
    finally { setBusy(false); }
  }
  async function remove(account: AccountMeta) {
    if (busy) return;
    setBusy(true); setError(null);
    let removed = false;
    try {
      const res = await fetch(`/api/accounts?accountId=${encodeURIComponent(account.id)}`, { method: "DELETE" });
      if (!res.ok) throw new Error((await res.json()).error ?? "删除失败，请重试。");
      removed = true; listFocus.current = null; back(); setNotice("账号已删除。"); await changed();
    } catch (e) { setError(removed ? "账号已删除，但列表更新失败，请重新加载。" : e instanceof Error ? e.message : "删除失败，请重试。"); }
    finally { setBusy(false); }
  }

  const account = accounts.find((item) => item.id === selected);
  const descriptor = providers.find((item) => item.provider === account?.provider);
  const credential = credentials.find((item) => item.accountId === selected);
  const groups = [...new Set(accounts.map((item) => item.groupName).filter(Boolean))].sort();
  const statusFor = (item: AccountMeta) => credentialStatus(credentials.find((c) => c.accountId === item.id));
  const filters = [
    { key: "all", label: "全部", count: accounts.length },
    { key: "unconfigured", label: "待配置", count: accounts.filter((item) => !credentials.some((c) => c.accountId === item.id)).length },
    { key: "error", label: "获取失败", count: credentials.filter((item) => item.fetchError).length },
  ] as const;
  const visible = accounts.filter((item) => (!group || item.groupName === group)
    && (filter === "all" || (filter === "unconfigured" ? !credentials.some((c) => c.accountId === item.id) : !!credentials.find((c) => c.accountId === item.id)?.fetchError)));

  return (
    <dialog ref={dialog} className={`modal provider-settings management-dialog${account ? " management-detail" : ""}`} aria-labelledby="provider-settings-title"
      onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}
      onClick={(event) => {
        if (event.target !== event.currentTarget || busy) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
      }}>
      <header className="management-header">
        <div>
          {(selected || creating) && <button type="button" className="management-back" disabled={busy} onClick={back}>← 返回账号列表</button>}
          <h2 ref={title} tabIndex={-1} className="modal-title" id="provider-settings-title">{creating ? "新增账号" : account?.alias ?? "账号管理"}</h2>
          <p className="modal-sub">{account ? `${descriptor?.label ?? account.provider}${account.groupName ? ` · ${account.groupName}` : ""}` : "同一服务商可添加多个账号，按别名和分组管理。"}</p>
        </div>
        <button type="button" className="modal-close" aria-label="关闭账号管理" disabled={busy} onClick={onClose}>✕</button>
      </header>
      <div className="management-workspace">
        {account && <nav className="management-nav" aria-label="切换账号"><p className="management-nav-label">账号</p>
          {accounts.map((item) => <button type="button" key={item.id} className="management-nav-item" aria-current={selected === item.id ? "page" : undefined} disabled={busy} onClick={() => open(item.id)}>
            <span>{item.alias}<span className="management-nav-status">{splitLabel(providers.find((p) => p.provider === item.provider)?.label ?? item.provider).name} · {!item.enabled ? "已停用" : statusFor(item).label}</span></span>
            <span className={`management-status-dot ${!item.enabled ? "muted" : statusFor(item).tone}`} aria-hidden="true" />
          </button>)}
        </nav>}
        <div className="management-body" aria-busy={loading}>
          {account && <div className="management-mobile-select"><label htmlFor="management-provider">切换账号</label><select id="management-provider" className="field" value={account.id} disabled={busy} onChange={(event) => open(event.target.value)}>{accounts.map((item) => <option key={item.id} value={item.id}>{item.alias}</option>)}</select></div>}
          {loading && <p className="management-help" role="status">加载账号设置…</p>}
          {error && <div className="management-feedback error" role="alert">{error}<button type="button" className="management-link" disabled={busy} onClick={retryLoad}>重新加载</button></div>}
          {notice && <p className="management-feedback" role="status">{notice}</p>}
          {!loading && creating && <AccountProfileForm providers={providers} groups={groups} initialGroup={group} onBusyChange={setBusy}
            onSaved={async (created) => { await changed(); open(created.id); }} />}
          {!loading && !creating && !selected && <>
            <div className="management-toolbar">
              <div className="management-filters" role="group" aria-label="筛选账号">{filters.map((item) => <button type="button" key={item.key} aria-pressed={filter === item.key} onClick={() => setFilter(item.key)}>{item.label}<span>{item.count}</span></button>)}</div>
              <button type="button" className="management-action" disabled={busy || !providers.length} onClick={() => { setCreating(true); setError(null); setNotice(null); }}>新增账号</button>
            </div>
            {groups.length > 0 && <label className="account-group-filter" htmlFor="management-group">分组<select id="management-group" className="field" value={group} onChange={(event) => setGroup(event.target.value)}><option value="">全部分组</option>{groups.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>}
            <div className="provider-settings-list">
              {visible.map((item) => {
                const status = statusFor(item);
                return <section className="provider-setting" key={item.id} aria-label={item.alias}>
                  <div className="provider-setting-info"><div className="provider-setting-heading"><h3 className="pname">{item.alias}</h3><p className="management-tag">{splitLabel(providers.find((p) => p.provider === item.provider)?.label ?? item.provider).name}</p></div>
                    <div className="management-status-row"><span className={`management-badge ${status.tone}`}><span className={`management-status-dot ${status.tone}`} aria-hidden="true" />{status.label}</span><span className="management-last-fetch">{item.groupName || "未分组"}</span></div>
                  </div>
                  <div className="provider-setting-actions"><label className="management-switch"><input type="checkbox" role="switch" aria-label={`启用 ${item.alias}`} checked={item.enabled} disabled={busy} onChange={(event) => toggle(item, event.currentTarget)} /><span className="management-switch-track" aria-hidden="true" /><span aria-hidden="true">{item.enabled ? "已启用" : "已停用"}</span></label>
                    <button id={`manage-${item.id}`} type="button" className="management-action" disabled={busy} onClick={() => open(item.id)}>管理账号</button>
                  </div>
                </section>;
              })}
              {!visible.length && <div className="management-empty">{accounts.length ? "当前筛选下没有账号，可调整筛选或新增账号。" : "暂无账号，点击「新增账号」开始配置。"}</div>}
            </div>
          </>}
          {!loading && account && descriptor && <>
            <fieldset className="account-form-section" disabled={busy}><AccountProfileForm key={`profile-${account.id}`} account={account} providers={providers} groups={groups} onBusyChange={setBusy} onSaved={changed} /></fieldset>
            <fieldset className="account-form-section" disabled={busy}><AddCredentialForm key={account.id} accountId={account.id} provider={{ ...descriptor, enabled: account.enabled, label: account.alias }} credential={credential} onBusyChange={setBusy} onSaved={changed} /></fieldset>
            <section className="account-danger"><h3>删除账号</h3><p className="management-help">仅删除此账号的凭据、用量和历史记录，其他账号不受影响。此操作无法恢复。</p>
              {confirmDelete ? <div className="account-delete-confirm" role="alert"><p>确认删除「{account.alias}」及其历史记录？</p><button type="button" className="management-action account-delete" disabled={busy} onClick={() => remove(account)}>确认删除账号</button><button type="button" className="management-action" disabled={busy} onClick={() => setConfirmDelete(false)}>取消</button></div>
                : <button type="button" className="management-action account-delete" disabled={busy} onClick={() => setConfirmDelete(true)}>删除此账号</button>}
            </section>
          </>}
          {!loading && selected && !account && <div className="management-empty">账号不存在或已被删除。<button type="button" className="management-action" onClick={back}>返回账号列表</button></div>}
        </div>
      </div>
      {!selected && !creating && <footer className="management-footer"><span className="management-help">停用仅影响该账号，保留凭据和历史数据。</span><button type="button" className="management-action" disabled={busy} onClick={onClose}>完成</button></footer>}
    </dialog>
  );
}
