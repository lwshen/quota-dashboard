"use client";

import { useRef, useState } from "react";
import { MAX_CREDENTIAL_IMPORT_BYTES, parseCredentialJson, type JsonCredentialProvider } from "@/shared/credential-import";

export function CredentialJsonImport({ provider, busy, onBusyChange, onImported }: {
  provider: JsonCredentialProvider;
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
  onImported: (fields: Record<string, string>) => void;
}) {
  const [method, setMethod] = useState<"file" | "text">("file");
  const [source, setSource] = useState("");
  const [error, setError] = useState<string | null>(null);
  const reading = useRef(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const path = provider === "claude"
    ? "~/.claude/.credentials.json"
    : provider === "antigravity"
      ? "~/.codexbar/antigravity/oauth_creds.json 或 ~/.gemini/antigravity-cli/antigravity-oauth-token"
      : "~/.codex/auth.json";
  const placeholder = provider === "claude"
    ? '{"claudeAiOauth":{"accessToken":"…","refreshToken":"…"}}'
    : provider === "antigravity"
      ? '{"access_token":"…","refresh_token":"…","client_id":"…","client_secret":"…"}'
      : '{"tokens":{"access_token":"…","refresh_token":"…","account_id":"…"}}';
  const id = `${provider}-json-import`;

  function apply(source: string) {
    const fields = parseCredentialJson(provider, source);
    onImported(fields);
    setSource("");
    setError(null);
  }

  return <section className="credential-import" aria-labelledby={`${id}-title`}>
    <div className="credential-section-heading"><h3 id={`${id}-title`}>从 JSON 导入</h3></div>
    <div className="management-filters credential-import-methods" role="group" aria-label="JSON 导入方式">
      {([{ key: "file", label: "选择文件" }, { key: "text", label: "粘贴 JSON" }] as const).map((item) =>
        <button type="button" key={item.key} aria-pressed={method === item.key} disabled={busy}
          onClick={() => { setMethod(item.key); setError(null); }}>{item.label}</button>)}
    </div>
    {method === "file" ? <>
      <label className="flabel" htmlFor={`${id}-file`}>JSON 凭据文件</label>
      <input id={`${id}-file`} className="field" type="file" accept=".json,application/json" disabled={busy}
        aria-invalid={!!error} aria-describedby={`${id}-help${error ? ` ${id}-error` : ""}`}
        onChange={async (event) => {
          const input = event.currentTarget, file = input.files?.[0];
          if (!file || busy || reading.current) return;
          reading.current = true;
          setError(null);
          onBusyChange(true);
          try {
            if (file.size > MAX_CREDENTIAL_IMPORT_BYTES) throw new Error("凭据文件过大，请选择不超过 1 MB 的 JSON 文件");
            apply(await file.text());
          } catch (e) { setError(e instanceof Error ? e.message : "文件读取失败，请重新选择"); }
          finally { input.value = ""; reading.current = false; onBusyChange(false); }
        }} />
    </> : <>
      <label className="flabel" htmlFor={`${id}-text`}>JSON 字符串</label>
      <textarea ref={textarea} id={`${id}-text`} className="field credential-json-source" rows={5} value={source}
        disabled={busy} autoComplete="off" spellCheck={false} autoCapitalize="off"
        placeholder={placeholder}
        aria-invalid={!!error} aria-describedby={`${id}-help${error ? ` ${id}-error` : ""}`}
        onChange={(event) => { setSource(event.target.value); setError(null); }} />
      <button type="button" className="management-action" disabled={busy || !source.trim()} onClick={() => {
        if (busy || reading.current) return;
        try { apply(source); }
        catch (e) { setError(e instanceof Error ? e.message : "导入失败，请检查 JSON 内容"); textarea.current?.focus(); }
      }}>读取并填入表单</button>
    </>}
    <p className="fhelp" id={`${id}-help`}>支持 {path} 的完整内容或其中的 Token 对象（最多 1 MB）。在浏览器内解析，检查表单后保存。</p>
    {error && <p className="credential-error" id={`${id}-error`} role="alert">{error}</p>}
  </section>;
}
