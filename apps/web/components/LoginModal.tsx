"use client";

import { useState } from "react";
import { useOnEscape } from "@/lib/hooks";

export function LoginModal({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useOnEscape(onClose);

  async function submit() {
    const pw = password.trim();
    if (!pw) {
      setError("请输入管理员密码 · Enter password");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pw }),
      });
      if (res.ok) {
        onSuccess();
        return;
      }
      const j = await res.json().catch(() => ({}));
      setError(j.error ?? "登录失败");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="logodot" style={{ width: 38, height: 38, borderRadius: 11, marginBottom: 15 }}>
          ◇
        </div>
        <div className="modal-title">管理员登录 · Admin</div>
        <div className="modal-sub">输入管理员密码以访问配额看板</div>
        <input
          className="field"
          type="password"
          placeholder="管理员密码 · Admin password"
          value={password}
          autoFocus
          onChange={(e) => {
            setPassword(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />
        {error ? <div className="formerr">⚠ {error}</div> : null}
        <button type="button" className="btn-primary" disabled={busy} onClick={submit}>
          {busy ? "登录中… · signing in" : "登录 · Sign in"}
        </button>
      </div>
    </div>
  );
}
