"use client";

import { useEffect, useState } from "react";
import { useOnEscape } from "@/lib/hooks";
import { parseGrokAuthFile } from "@quota/core/grok-auth";
import type { GrokAuthImport } from "@quota/core/grok-auth";

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
  const [importedAccounts, setImportedAccounts] = useState<GrokAuthImport[]>([]);
  const [importedScope, setImportedScope] = useState("");
  useOnEscape(onClose);

  useEffect(() => {
    setFields({});
    setMsg(null);
    setImportedAccounts([]);
    setImportedScope("");
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

        <select className="field" value={provider} disabled={busy} onChange={(e) => setProvider(e.target.value)}>
          {providers.map((p) => (
            <option key={p.provider} value={p.provider}>
              {p.label}
            </option>
          ))}
        </select>

        {provider === "grok" ? (
          <div>
            <label className="flabel" htmlFor="grok-auth-file">导入 Grok auth.json</label>
            <input id="grok-auth-file" className="field" type="file" accept=".json,application/json" disabled={busy}
              onChange={async (event) => {
                const input = event.currentTarget;
                const file = input.files?.[0];
                if (!file) return;
                setBusy(true);
                try {
                  if (file.size > 1024 * 1024) throw new Error("凭据文件过大，请选择 ~/.grok/auth.json");
                  const accounts = parseGrokAuthFile(await file.text());
                  setImportedAccounts(accounts);
                  const first = accounts.length === 1 ? accounts[0] : undefined;
                  setImportedScope(first?.scope ?? "");
                  setFields(first?.fields ?? {});
                  setMsg(null);
                } catch (error) {
                  setMsg(error instanceof Error ? error.message : "导入失败");
                } finally {
                  input.value = "";
                  setBusy(false);
                }
              }} />
            <div className="fhelp">先运行 grok login，选择 ~/.grok/auth.json。文件在浏览器内解析，保存时仅提交所选账户所需的凭据。</div>
            {importedAccounts.length > 1 ? (
              <select className="field" aria-label="选择 Grok 账户" value={importedScope}
                onChange={(event) => {
                  const account = importedAccounts.find((a) => a.scope === event.target.value);
                  setImportedScope(account?.scope ?? "");
                  setFields(account?.fields ?? {});
                }}>
                <option value="">请选择要导入的账户</option>
                {importedAccounts.map((account) => <option key={account.scope} value={account.scope}>{account.label}</option>)}
              </select>
            ) : null}
          </div>
        ) : null}

        {meta?.credentialFields.map((f) => (
          <div key={f.key}>
            <label className="flabel" htmlFor={`credential-${f.key}`}>
              {f.label}
              {f.required && " *"}
            </label>
            <input
              id={`credential-${f.key}`}
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
