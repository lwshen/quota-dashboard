"use client";

import { useEffect, useRef, useState } from "react";
import { useOnEscape } from "@/lib/hooks";

export interface ProviderSetting {
  provider: string;
  label: string;
  enabled: boolean;
}

export function ProviderSettings({
  onClose,
  onChanged,
}: {
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [providers, setProviders] = useState<ProviderSetting[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useOnEscape(onClose);

  useEffect(() => {
    const previousFocus = document.activeElement;
    const element = dialog.current;
    element?.showModal();
    return () => {
      element?.close();
      if (previousFocus instanceof HTMLElement) previousFocus.focus();
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/providers", { cache: "no-store", signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error("渠道设置加载失败，请重新打开重试");
        const data = await res.json();
        setProviders(data.providers);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "渠道设置加载失败");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);

  async function toggle(provider: ProviderSetting) {
    if (saving) return;
    setSaving(provider.provider);
    setError(null);
    try {
      const res = await fetch("/api/providers", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: provider.provider, enabled: !provider.enabled }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "保存失败，请重试");
      }
      setProviders((previous) => previous.map((p) => p.provider === provider.provider ? { ...p, enabled: !p.enabled } : p));
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败，请重试");
    } finally {
      setSaving(null);
    }
  }

  return (
    <dialog
      ref={dialog}
      className="modal provider-settings"
      aria-labelledby="provider-settings-title"
      aria-describedby="provider-settings-description"
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      onClick={(e) => {
        if (e.target !== e.currentTarget) return;
        const rect = e.currentTarget.getBoundingClientRect();
        if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) onClose();
      }}
    >
      <div className="row" style={{ justifyContent: "space-between", gap: 16 }}>
        <h2 className="modal-title" id="provider-settings-title">渠道管理</h2>
        <button type="button" className="modal-close" aria-label="关闭渠道管理" onClick={onClose}>✕</button>
      </div>
      <p className="modal-sub" id="provider-settings-description">
        关闭后隐藏渠道，并停止自动和手动刷新。凭据与历史数据保留，设置对所有访客生效。
      </p>
      {loading ? <p className="modal-sub" role="status">加载中…</p> : (
        <div className="provider-settings-list" aria-busy={saving !== null}>
          {providers.map((p) => (
            <label className="provider-setting" key={p.provider}>
              <span className="provider-setting-info">
                <span className="pname">{p.label}</span>
                <span className="ptag">{saving === p.provider ? "保存中…" : p.enabled ? "显示并刷新" : "已隐藏 · 已停止刷新"}</span>
              </span>
              <input
                type="checkbox"
                role="switch"
                aria-label={`启用 ${p.label}`}
                checked={p.enabled}
                disabled={saving !== null}
                onChange={() => toggle(p)}
              />
            </label>
          ))}
        </div>
      )}
      {error && <div className="formerr" role="alert">{error}</div>}
      <button type="button" className="btn-ghost" onClick={onClose}>完成</button>
    </dialog>
  );
}
