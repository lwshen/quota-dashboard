"use client";

import { useEffect, useState } from "react";
import { useOnEscape } from "@/lib/hooks";

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
  useOnEscape(onClose);

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
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 420 }}>
        <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <div className="modal-title">配置凭据 · Credentials</div>
            <div className="modal-sub">凭据仅在服务端加密存储，不会返回前端</div>
          </div>
          <button type="button" className="modal-close" onClick={onClose}>
            ✕
          </button>
        </div>

        <select className="field" value={provider} onChange={(e) => setProvider(e.target.value)}>
          {providers.map((p) => (
            <option key={p.provider} value={p.provider}>
              {p.label}
            </option>
          ))}
        </select>

        {meta?.credentialFields.map((f) => (
          <div key={f.key}>
            <label className="flabel">
              {f.label}
              {f.required && " *"}
            </label>
            <input
              className="field"
              type={f.secret ? "password" : "text"}
              placeholder={f.placeholder}
              value={fields[f.key] ?? ""}
              autoComplete="off"
              onChange={(e) => setFields((s) => ({ ...s, [f.key]: e.target.value }))}
            />
            {f.help ? <div className="fhelp">{f.help}</div> : null}
          </div>
        ))}

        {msg ? <div className="formnote">{msg}</div> : null}

        <button type="button" className="btn-primary" disabled={busy} onClick={submit}>
          {busy ? "保存中… · saving" : "保存并抓取 · Save & fetch"}
        </button>
        <button type="button" className="btn-ghost" onClick={onClose}>
          取消 · Cancel
        </button>
      </div>
    </div>
  );
}
