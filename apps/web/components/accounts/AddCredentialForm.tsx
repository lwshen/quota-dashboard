"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { parseGrokAuthFile, type GrokAuthImport } from "@quota/core/grok-auth";
import { credentialStatus, type CredentialFieldMeta, type CredentialMeta, type ProviderMeta } from "@/shared/provider-management";
import { CredentialJsonImport } from "@/components/accounts/CredentialJsonImport";

export function AddCredentialForm({ provider, accountId, credential, onBusyChange, onSaved }: {
  provider: ProviderMeta;
  accountId?: string;
  credential?: CredentialMeta;
  onBusyChange: (busy: boolean) => void;
  onSaved: () => Promise<void>;
}) {
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState<{ text: string; error?: boolean } | null>(null);
  const [accounts, setAccounts] = useState<GrokAuthImport[]>([]);
  const [scope, setScope] = useState("");
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [advanced, setAdvanced] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const feedbackRef = useRef<HTMLParagraphElement>(null);
  const mainFields = provider.credentialFields.filter((f) => f.required || f.key === "accountId");
  const extraFields = provider.credentialFields.filter((f) => !mainFields.includes(f));
  const status = credentialStatus(credential);

  useEffect(() => {
    if (Object.keys(errors).length) form.current?.querySelector<HTMLInputElement>('[aria-invalid="true"]')?.focus();
  }, [errors]);

  useEffect(() => {
    if (feedback && !Object.keys(errors).length) feedbackRef.current?.scrollIntoView({ block: "nearest" });
  }, [feedback, errors]);

  function setWorking(value: boolean) {
    pending.current = value;
    setBusy(value);
    onBusyChange(value);
  }

  function changeField(key: string, value: string) {
    setFields((previous) => ({ ...previous, [key]: value }));
    setErrors((previous) => { const next = { ...previous }; delete next[key]; return next; });
    setFeedback(null);
  }

  async function reloadAfterSave() {
    try { await onSaved(); }
    catch { setFeedback({ text: "操作已完成，但状态更新失败。请返回账号列表重新加载。", error: true }); }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending.current) return;
    const invalid: Record<string, string> = {};
    for (const field of provider.credentialFields) {
      if (field.required && !fields[field.key]?.trim()) {
        invalid[field.key] = `请填写 ${field.label}`;
      }
    }
    setErrors(invalid);
    if (Object.keys(invalid).length) {
      setFeedback({ text: "请检查标出的字段。", error: true });
      return;
    }
    setWorking(true);
    setFeedback(null);
    try {
      const res = await fetch("/api/credentials", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: accountId ?? provider.provider, fields, action: "replace" }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrors(data.fieldErrors ?? {});
        if (Object.keys(data.fieldErrors ?? {}).some((key) => extraFields.some((f) => f.key === key))) setAdvanced(true);
        throw new Error(data.error ?? "保存失败，请重试");
      }
      setFields({});
      setRevealed({});
      setAccounts([]);
      setScope("");
      setFeedback(data.disabled
        ? { text: "凭据已保存。此账号尚未启用，未获取用量；可在下方启用并获取用量。" }
        : data.result?.error
          ? { text: `凭据已保存，但获取用量失败：${data.result.error}`, error: true }
          : { text: "凭据已保存，已获取最新用量。" });
      await reloadAfterSave();
    } catch (e) { setFeedback({ text: e instanceof Error ? e.message : "保存失败，请重试", error: true }); }
    finally { setWorking(false); }
  }

  async function fetchUsage(enable: boolean) {
    if (pending.current) return;
    setWorking(true);
    setFeedback(null);
    let enabled = false;
    try {
      if (enable) {
        const res = await fetch("/api/accounts", {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ accountId: accountId ?? provider.provider, enabled: true }),
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "启用失败，请重试");
        enabled = true;
      }
      const res = await fetch("/api/refresh", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accountId: accountId ?? provider.provider }),
      });
      const data = await res.json();
      if (!res.ok || data.result?.error) throw new Error(data.error ?? data.result?.error ?? "获取失败，请重试");
      setFeedback({ text: enable ? "账号已启用，已获取最新用量。" : "已获取最新用量。" });
    } catch (e) {
      setFeedback({ text: `${enabled ? "账号已启用，但获取用量失败：" : ""}${e instanceof Error ? e.message : "获取失败，请重试"}`, error: true });
    } finally {
      await reloadAfterSave();
      setWorking(false);
    }
  }

  function applyImport(imported: Record<string, string>) {
    setFields(imported);
    setRevealed({});
    setAdvanced(true);
    setErrors({});
    setFeedback({ text: "已读取账户凭据，请检查后保存。" });
  }

  function renderField(field: CredentialFieldMeta) {
    const id = `credential-${field.key}`;
    const configured = !!credential?.configuredKeys.includes(field.key);
    return (
      <div className="credential-field" key={field.key}>
        <div className="credential-field-label"><label className="flabel" htmlFor={id}>{field.label}{field.required && <span className="credential-required">必填</span>}</label>
        {configured && <span className="credential-saved">已配置</span>}</div>
        <div className="credential-input-row">
          <input id={id} name={field.key} className="field" type={field.secret && !revealed[field.key] ? "password" : "text"}
            placeholder={field.placeholder}
            value={fields[field.key] ?? ""} disabled={busy} autoComplete="off" spellCheck={false}
            required={field.required} aria-invalid={!!errors[field.key]}
            aria-describedby={`${id}-help${errors[field.key] ? ` ${id}-error` : ""}`}
            onChange={(event) => changeField(field.key, event.target.value)} />
          {field.secret && <button type="button" className="credential-reveal" disabled={busy}
            aria-label={`${revealed[field.key] ? "隐藏" : "显示"} ${field.label}`} aria-pressed={!!revealed[field.key]}
            onClick={() => setRevealed((previous) => ({ ...previous, [field.key]: !previous[field.key] }))}>{revealed[field.key] ? "隐藏" : "显示"}</button>}
        </div>
        <p className="fhelp" id={`${id}-help`}>{field.help ?? (field.required ? "必填项。" : "可选项。")}</p>
        {errors[field.key] && <p className="credential-error" id={`${id}-error`}>{errors[field.key]}</p>}
      </div>
    );
  }

  return (
    <form ref={form} className="credential-form" onSubmit={submit} noValidate aria-label={`${provider.label} 凭据`}>
      <section className="credential-status" aria-label="账号状态">
        <div className="credential-status-heading"><strong>{provider.enabled ? "账号已启用" : "账号已停用"}</strong><span className={`management-badge ${status.tone}`}><span className={`management-status-dot ${status.tone}`} aria-hidden="true" />{status.label}</span></div>
        <p className="management-help">{credential?.fetchedAt ? `最近获取：${new Date(credential.fetchedAt).toLocaleString("zh-CN")}` : "尚未获取用量。"}</p>
        {credential?.fetchError && <p className="credential-error">上次获取失败：{credential.fetchError}</p>}
        {!provider.enabled && <p className="management-help">停用期间仅保存凭据，不会获取用量。启用后才会恢复显示和刷新。</p>}
      </section>
      {(provider.provider === "codex" || provider.provider === "codex2" || provider.provider === "claude") &&
        <CredentialJsonImport provider={provider.provider} busy={busy} onBusyChange={setWorking}
          onImported={applyImport} />}
      {provider.provider === "grok" && <section className="credential-import">
        <label className="flabel" htmlFor="grok-auth-file">导入 Grok auth.json</label>
        <input id="grok-auth-file" className="field" type="file" accept=".json,application/json" disabled={busy} aria-describedby="grok-import-help"
          onChange={async (event) => {
            const input = event.currentTarget, file = input.files?.[0];
            if (!file) return;
            setWorking(true);
            try {
              if (file.size > 1024 * 1024) throw new Error("凭据文件过大，请选择 ~/.grok/auth.json");
              const imported = parseGrokAuthFile(await file.text());
              const single = imported.length === 1 ? imported[0] : undefined;
              setAccounts(imported);
              setScope(single?.scope ?? "");
              if (single) applyImport(single.fields);
              else setFeedback({ text: "已找到多个账户，请选择要导入的账户。" });
            } catch (e) { setFeedback({ text: e instanceof Error ? e.message : "导入失败，请重新选择文件", error: true }); }
            finally { input.value = ""; setWorking(false); }
          }} />
        <p className="fhelp" id="grok-import-help">先运行 grok login，再选择 ~/.grok/auth.json。文件在浏览器内解析，仅提交所选账户的凭据。</p>
        {accounts.length > 1 && <><label className="flabel" htmlFor="grok-account">选择 Grok 账户</label><select id="grok-account" className="field" value={scope} disabled={busy}
          onChange={(event) => { setScope(event.target.value); const account = accounts.find((a) => a.scope === event.target.value); if (account) applyImport(account.fields); }}>
          <option value="">请选择账户</option>{accounts.map((account) => <option key={account.scope} value={account.scope}>{account.label}</option>)}
        </select></>}
      </section>}
      <section className="credential-fields-section" aria-labelledby="credential-fields-title"><div className="credential-section-heading"><h3 id="credential-fields-title">账户凭据</h3><p className="management-help">凭据在服务端加密存储，保存后不会返回前端。</p>{credential && <p className="management-help">重新保存会覆盖现有凭据并清除历史用量。请填写完整凭据，可选项留空会清除旧值。</p>}</div>{mainFields.map(renderField)}</section>
      {extraFields.length > 0 && <details className="credential-advanced" open={advanced} onToggle={(event) => setAdvanced(event.currentTarget.open)}>
        <summary><span>可选设置<span className="credential-advanced-hint">{extraFields.some((field) => field.key === "refreshToken") ? "自动续期与其他选项" : extraFields.map((field) => field.label.split("（")[0]).join("、")}</span></span><span className="credential-advanced-count">{extraFields.length} 项</span></summary>
        {extraFields.map(renderField)}
      </details>}
      {feedback && <p ref={feedbackRef} className={`management-feedback${feedback.error ? " error" : ""}`} role={feedback.error ? "alert" : "status"}>{feedback.text}</p>}
      <div className="credential-footer">
        <div className="credential-footer-actions">
        {credential && <button type="button" className="btn-ghost" disabled={busy} onClick={() => fetchUsage(!provider.enabled)}>{provider.enabled ? "重新获取用量" : "启用并获取用量"}</button>}
        <button type="submit" className="btn-primary" disabled={busy || (accounts.length > 1 && !scope)}>{busy ? "处理中…" : provider.enabled ? "保存并获取用量" : "保存凭据"}</button>
        </div>
      </div>
    </form>
  );
}
