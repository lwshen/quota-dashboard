"use client";

import { type FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        router.replace("/");
        router.refresh();
        return;
      }
      const j = await res.json().catch(() => ({}));
      setErr(j.error ?? "登录失败");
    } catch (e2) {
      setErr(String(e2));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
      <form onSubmit={submit} className="modal" style={{ maxWidth: 360 }}>
        <div className="logodot" style={{ width: 38, height: 38, borderRadius: 11, marginBottom: 15 }}>
          ◇
        </div>
        <div className="modal-title">管理员登录 · Admin</div>
        <div className="modal-sub">输入管理员密码以访问配额看板</div>
        <input
          className="field"
          type="password"
          autoFocus
          placeholder="管理员密码 · Admin password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {err ? <div className="formerr">⚠ {err}</div> : null}
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? "登录中… · signing in" : "登录 · Sign in"}
        </button>
      </form>
    </div>
  );
}
