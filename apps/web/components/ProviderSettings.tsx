"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useModalDialog } from "@/lib/hooks";
import { splitLabel } from "@/lib/format";
import { emptyDraft, type CredentialDraft, type CredentialMeta, type ProviderMeta } from "@/lib/provider-management";
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
  const dialog = useModalDialog();
  const title = useRef<HTMLHeadingElement>(null);
  const listFocus = useRef<string | null>(null);

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
      dialog.current?.querySelector<HTMLButtonElement>(`button[data-provider="${listFocus.current}"]`)?.focus();
      listFocus.current = null;
    }
  }, [selected, loading, dialog]);

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

  async function toggle(provider: ProviderMeta) {
    if (busy) return;
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

  return (
    <dialog ref={dialog} className="modal provider-settings management-dialog" aria-labelledby="provider-settings-title"
      onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}
      onClick={(event) => {
        if (event.target !== event.currentTarget || busy) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
      }}>
      <header className="management-header">
        <div>
          {selected && <button type="button" className="management-back" disabled={busy} onClick={() => setSelected(null)}>← 返回渠道列表</button>}
          <h2 ref={title} tabIndex={-1} className="modal-title" id="provider-settings-title">{provider ? provider.label : "渠道管理"}</h2>
          <p className="modal-sub">{selected ? "配置凭据并查看获取结果。未保存的输入仅在本次管理会话保留。" : "管理渠道、凭据和用量获取状态。开关对所有访客生效，即时保存。"}</p>
        </div>
        <button type="button" className="modal-close" aria-label="关闭渠道管理" disabled={busy} onClick={onClose}>✕</button>
      </header>
      <div className="management-body" aria-busy={loading}>
        {loading && <p className="management-help" role="status">加载渠道设置…</p>}
        {error && <div className="management-feedback error" role="alert">{error}<button type="button" className="management-link" disabled={busy} onClick={retryLoad}>重新加载</button></div>}
        {notice && <p className="management-feedback" role="status">{notice}</p>}
        {!loading && !provider && providers.length > 0 && (
          <div className="provider-settings-list">
            {providers.map((p) => {
              const saved = credentials.find((c) => c.provider === p.provider);
              const { name, tag } = splitLabel(p.label);
              const status = !saved ? "未配置凭据" : saved.fetchError ? "获取失败" : saved.fetchedAt ? "已获取用量" : "已配置 · 待获取用量";
              return (
                <section className="provider-setting" key={p.provider} aria-label={p.label}>
                  <div className="provider-setting-info">
                    <h3 className="pname">{name} <span className="management-tag">{tag}</span></h3>
                    <p className={saved?.fetchError ? "management-status error-text" : "management-status"}>{status}</p>
                  </div>
                  <div className="provider-setting-actions">
                    <label className="management-switch">
                      <input type="checkbox" role="switch" aria-label={`启用 ${p.label}`} checked={p.enabled} disabled={busy} onChange={() => toggle(p)} />
                      <span aria-hidden="true">{p.enabled ? "已启用" : "已停用"}</span>
                    </label>
                    <button type="button" className="management-action" data-provider={p.provider} disabled={busy} onClick={() => open(p.provider)}>{saved ? "管理凭据" : "配置凭据"}</button>
                  </div>
                </section>
              );
            })}
          </div>
        )}
        {!loading && provider && (
          <AddCredentialForm key={provider.provider} provider={provider} credential={credential}
            draft={drafts[provider.provider] ?? emptyDraft(!!credential)}
            onDraftChange={(draft) => setDrafts((previous) => ({ ...previous, [provider.provider]: draft }))}
            onBusyChange={setBusy} onSaved={changed} />
        )}
      </div>
      {!selected && <footer className="management-footer"><span className="management-help">停用会隐藏渠道并停止刷新，保留凭据与历史数据。</span><button type="button" className="management-action" disabled={busy} onClick={onClose}>完成</button></footer>}
    </dialog>
  );
}
