"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useModalDialog } from "@/lib/hooks";
import { splitLabel } from "@/lib/format";
import { credentialStatus, emptyDraft, hasDraftChanges, type CredentialDraft, type CredentialMeta, type ProviderMeta } from "@/lib/provider-management";
import { AddCredentialForm } from "./AddCredentialForm";

export function ProviderSettings({ initialProvider, onClose, onChanged }: {
  initialProvider?: string;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [providers, setProviders] = useState<ProviderMeta[]>([]);
  const [credentials, setCredentials] = useState<CredentialMeta[]>([]);
  const [selected, setSelected] = useState<string | null>(initialProvider ?? null);
  const [drafts, setDrafts] = useState<Record<string, CredentialDraft>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "unconfigured" | "error">("all");
  const dialog = useModalDialog();
  const title = useRef<HTMLHeadingElement>(null);
  const listFocus = useRef<string | null>(null);
  const toggleFocus = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    const responses = await Promise.all([
      fetch("/api/providers", { cache: "no-store", signal }),
      fetch("/api/credentials", { cache: "no-store", signal }),
    ]);
    if (responses.some((res) => !res.ok)) throw new Error("渠道设置加载失败，请重试；登录过期时请重新登录。");
    const [providerData, credentialData] = await Promise.all(responses.map((res) => res.json()));
    setProviders(providerData.providers);
    setCredentials(credentialData.credentials);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal)
      .catch((e) => { if (!controller.signal.aborted) setError(e.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [load]);

  useEffect(() => {
    if (loading) return;
    if (selected) {
      dialog.current?.querySelector(".management-body")?.scrollTo({ top: 0 });
      title.current?.focus();
    }
    else if (listFocus.current) {
      const target = dialog.current?.querySelector<HTMLButtonElement>(`button[data-provider="${listFocus.current}"]`);
      (target ?? title.current)?.focus();
      listFocus.current = null;
    }
  }, [selected, loading, dialog]);

  useEffect(() => {
    if (!busy && toggleFocus.current) {
      toggleFocus.current.focus({ preventScroll: true });
      toggleFocus.current = null;
    }
  }, [busy]);

  async function retryLoad() {
    setLoading(true);
    setError(null);
    try { await load(); } catch (e) { setError(e instanceof Error ? e.message : "加载失败，请重试"); }
    finally { setLoading(false); }
  }

  async function changed() {
    try {
      await Promise.all([load(), onChanged()]);
    } catch (error) {
      setError("操作已完成，但渠道状态更新失败，请重新加载。");
      throw error;
    }
  }

  async function toggle(provider: ProviderMeta, trigger: HTMLInputElement) {
    if (busy) return;
    toggleFocus.current = trigger;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/providers", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: provider.provider, enabled: !provider.enabled }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "保存失败，请重试");
      setProviders((previous) => previous.map((p) => p.provider === provider.provider ? { ...p, enabled: !p.enabled } : p));
      setNotice(provider.enabled ? "已停用，凭据和历史数据保留。" : "已启用；已配置凭据的渠道将在下次刷新时获取用量。");
      await onChanged();
    } catch (e) { setError(e instanceof Error ? e.message : "保存失败，请重试"); }
    finally { setBusy(false); }
  }

  function open(provider: string) {
    listFocus.current = provider;
    setSelected(provider);
    setError(null);
    setNotice(null);
  }

  const provider = providers.find((p) => p.provider === selected);
  const credential = credentials.find((c) => c.provider === selected);
  const filters = [
    { key: "all", label: "全部", count: providers.length },
    { key: "unconfigured", label: "待配置", count: providers.filter((p) => !credentials.some((c) => c.provider === p.provider)).length },
    { key: "error", label: "获取失败", count: credentials.filter((c) => c.fetchError).length },
  ] as const;
  const visibleProviders = providers.filter((p) => {
    const saved = credentials.find((c) => c.provider === p.provider);
    return filter === "all" || (filter === "unconfigured" ? !saved : !!saved?.fetchError);
  });

  return (
    <dialog ref={dialog} className={`modal provider-settings management-dialog${provider ? " management-detail" : ""}`} aria-labelledby="provider-settings-title"
      onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}
      onClick={(event) => {
        if (event.target !== event.currentTarget || busy) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
      }}>
      <header className="management-header">
        <div>
          {selected && <button type="button" className="management-back" disabled={busy} onClick={() => setSelected(null)}>← 返回渠道列表</button>}
          <h2 ref={title} tabIndex={-1} className="modal-title" id="provider-settings-title">{provider ? splitLabel(provider.label).name : "渠道管理"}{provider && <span className="management-title-tag">{splitLabel(provider.label).tag}</span>}</h2>
          <p className="modal-sub">{provider ? "配置凭据并查看用量获取结果。切换渠道时保留未保存的输入。" : "管理服务凭据和用量获取状态。渠道开关即时保存，对所有访客生效。"}</p>
        </div>
        <button type="button" className="modal-close" aria-label="关闭渠道管理" disabled={busy} onClick={onClose}>✕</button>
      </header>
      <div className="management-workspace">
        {provider && <nav className="management-nav" aria-label="切换配置渠道">
          <p className="management-nav-label">渠道</p>
          {providers.map((p) => {
            const status = credentialStatus(credentials.find((c) => c.provider === p.provider));
            return <button type="button" key={p.provider} className="management-nav-item" aria-current={selected === p.provider ? "page" : undefined} disabled={busy} onClick={() => open(p.provider)}>
              <span>{splitLabel(p.label).name}<span className="management-nav-status">{hasDraftChanges(drafts[p.provider]) ? "未保存" : !p.enabled ? "已停用" : status.label}</span></span>
              <span className={`management-status-dot ${!p.enabled ? "muted" : status.tone}`} aria-hidden="true" />
            </button>;
          })}
        </nav>}
      <div className="management-body" aria-busy={loading}>
        {provider && <div className="management-mobile-select"><label htmlFor="management-provider">切换渠道</label><select id="management-provider" className="field" value={provider.provider} disabled={busy} onChange={(event) => open(event.target.value)}>{providers.map((p) => <option key={p.provider} value={p.provider}>{p.label}{hasDraftChanges(drafts[p.provider]) ? " · 未保存" : ""}</option>)}</select></div>}
        {loading && <p className="management-help" role="status">加载渠道设置…</p>}
        {error && <div className="management-feedback error" role="alert">{error}<button type="button" className="management-link" disabled={busy} onClick={retryLoad}>重新加载</button></div>}
        {notice && <p className="management-feedback" role="status">{notice}</p>}
        {!loading && !provider && providers.length > 0 && (
          <>
          <div className="management-toolbar">
            <div className="management-filters" role="group" aria-label="筛选渠道">{filters.map((item) => <button type="button" key={item.key} aria-pressed={filter === item.key} onClick={() => setFilter(item.key)}>{item.label}<span>{item.count}</span></button>)}</div>
            <span className="management-summary">{providers.filter((p) => p.enabled).length} / {providers.length} 已启用</span>
          </div>
          <div className="provider-settings-list">
            {visibleProviders.map((p) => {
              const saved = credentials.find((c) => c.provider === p.provider);
              const { name, tag } = splitLabel(p.label);
              const status = credentialStatus(saved);
              return (
                <section className="provider-setting" key={p.provider} aria-label={p.label}>
                  <div className="provider-setting-info">
                    <div className="provider-setting-heading"><h3 className="pname">{name}{hasDraftChanges(drafts[p.provider]) && <span className="management-draft">未保存</span>}</h3><p className="management-tag">{tag}</p></div>
                    <div className="management-status-row"><span className={`management-badge ${status.tone}`}><span className={`management-status-dot ${status.tone}`} aria-hidden="true" />{status.label}</span>{saved?.fetchedAt && <span className="management-last-fetch">最近获取 {new Date(saved.fetchedAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>}</div>
                  </div>
                  <div className="provider-setting-actions">
                    <label className="management-switch">
                      <input type="checkbox" role="switch" aria-label={`启用 ${p.label}`} checked={p.enabled} disabled={busy} onChange={(event) => toggle(p, event.currentTarget)} />
                      <span className="management-switch-track" aria-hidden="true" />
                      <span aria-hidden="true">{p.enabled ? "已启用" : "已停用"}</span>
                    </label>
                    <button type="button" className="management-action" data-provider={p.provider} disabled={busy} onClick={() => open(p.provider)}>{saved ? "管理凭据" : "配置凭据"}</button>
                  </div>
                </section>
              );
            })}
            {visibleProviders.length === 0 && <div className="management-empty"><p>{filter === "error" ? "没有获取失败的渠道" : "所有渠道均已配置凭据"}</p><button type="button" className="management-action" onClick={() => setFilter("all")}>查看全部渠道</button></div>}
          </div>
          </>
        )}
        {!loading && provider && (
          <AddCredentialForm key={provider.provider} provider={provider} credential={credential}
            draft={drafts[provider.provider] ?? emptyDraft(!!credential)}
            onDraftChange={(draft) => setDrafts((previous) => ({ ...previous, [provider.provider]: draft }))}
            onBusyChange={setBusy} onSaved={changed} />
        )}
      </div>
      </div>
      {!selected && <footer className="management-footer"><span className="management-help">停用会隐藏渠道并停止刷新，保留凭据与历史数据。</span><button type="button" className="management-action" disabled={busy} onClick={onClose}>完成</button></footer>}
    </dialog>
  );
}
