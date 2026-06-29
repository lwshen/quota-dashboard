"use client";

import { useEffect, useState } from "react";

export interface CredentialFieldMeta {
  key: string;
  label: string;
  required: boolean;
  secret: boolean;
  placeholder?: string;
  help?: string;
}

export interface ProviderMeta {
  provider: string;
  label: string;
  producesRateWindows: boolean;
  credentialFields: CredentialFieldMeta[];
}

export function AddCredentialForm({
  providers,
  initialProvider,
  onSaved,
  onClose,
}: {
  providers: ProviderMeta[];
  initialProvider?: string;
  onSaved: () => void;
  onClose: () => void;
}) {
  const [provider, setProvider] = useState(initialProvider ?? providers[0]?.provider ?? "");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    setFields({});
    setMsg(null);
  }, [provider]);

  const meta = providers.find((p) => p.provider === provider);

  async function submit() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, fields }),
      });
      const j = await res.json();
      if (!res.ok) {
        setMsg(j.error ?? "保存失败");
        return;
      }
      if (j.result?.error) {
        setMsg(`已保存，但抓取失败：${j.result.error}`);
        return;
      }
      onSaved();
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md space-y-4 rounded-xl border border-neutral-800 bg-neutral-900 p-5">
        <div className="flex items-center justify-between">
          <h2 className="font-medium">配置凭据</h2>
          <button onClick={onClose} className="text-neutral-500 hover:text-neutral-100">
            ✕
          </button>
        </div>

        <select
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
          className="w-full rounded bg-neutral-800 p-2 text-sm"
        >
          {providers.map((p) => (
            <option key={p.provider} value={p.provider}>
              {p.label}
            </option>
          ))}
        </select>

        {meta?.credentialFields.map((f) => (
          <div key={f.key} className="space-y-1">
            <label className="text-xs text-neutral-400">
              {f.label}
              {f.required && " *"}
            </label>
            <input
              type={f.secret ? "password" : "text"}
              placeholder={f.placeholder}
              value={fields[f.key] ?? ""}
              autoComplete="off"
              onChange={(e) => setFields((s) => ({ ...s, [f.key]: e.target.value }))}
              className="w-full rounded bg-neutral-800 p-2 text-sm outline-none focus:ring-1 focus:ring-emerald-500"
            />
            {f.help && <div className="text-[11px] text-neutral-600">{f.help}</div>}
          </div>
        ))}

        {msg && <div className="text-xs text-amber-400">{msg}</div>}

        <button
          disabled={busy}
          onClick={submit}
          className="w-full rounded bg-emerald-600 p-2 text-sm font-medium hover:bg-emerald-500 disabled:opacity-50"
        >
          {busy ? "保存中…" : "保存并抓取"}
        </button>
      </div>
    </div>
  );
}
