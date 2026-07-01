"use client";

import { useCallback, useEffect, useState } from "react";
import { ProviderCard, type ProviderView } from "@/components/ProviderCard";
import { AddCredentialForm, type ProviderMeta } from "@/components/AddCredentialForm";

export default function Home() {
  const [views, setViews] = useState<ProviderView[]>([]);
  const [providers, setProviders] = useState<ProviderMeta[]>([]);
  const [formProvider, setFormProvider] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [authed, setAuthed] = useState(false);

  const loadUsage = useCallback(async () => {
    const res = await fetch("/api/usage", { cache: "no-store" });
    const j = await res.json();
    setViews(j.providers ?? []);
  }, []);

  useEffect(() => {
    fetch("/api/session")
      .then((r) => r.json())
      .then((j) => setAuthed(Boolean(j.authed)))
      .catch(() => {});
    fetch("/api/providers")
      .then((r) => r.json())
      .then((j) => setProviders(j.providers ?? []))
      .catch(() => {});
    loadUsage();
    const t = setInterval(loadUsage, 15_000);
    return () => clearInterval(t);
  }, [loadUsage]);

  async function refreshNow() {
    setRefreshing(true);
    try {
      await fetch("/api/refresh", { method: "POST" });
      await loadUsage();
    } finally {
      setRefreshing(false);
    }
  }

  function openForm(provider?: string) {
    setFormProvider(provider ?? null);
    setShowForm(true);
  }

  async function logout() {
    // Always land on /login even if the request errors, and replace history so the
    // back button doesn't return to the authed view.
    try {
      await fetch("/api/logout", { method: "POST" });
    } finally {
      window.location.replace("/login");
    }
  }

  return (
    <main className="mx-auto max-w-3xl space-y-6 p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Quota Dashboard</h1>
          <p className="text-xs text-neutral-500">AI 服务商配额 / 用量看板</p>
        </div>
        <div className="flex gap-2">
          {authed ? (
            <>
              <button
                onClick={refreshNow}
                disabled={refreshing}
                className="rounded bg-neutral-800 px-3 py-1.5 text-sm hover:bg-neutral-700 disabled:opacity-50"
              >
                {refreshing ? "刷新中…" : "刷新"}
              </button>
              <button
                onClick={() => openForm()}
                className="rounded bg-emerald-600 px-3 py-1.5 text-sm hover:bg-emerald-500"
              >
                + 配置凭据
              </button>
              <button
                onClick={logout}
                className="rounded bg-neutral-800 px-3 py-1.5 text-sm text-neutral-400 hover:bg-neutral-700 hover:text-neutral-100"
              >
                登出
              </button>
            </>
          ) : (
            <a
              href="/login"
              className="rounded bg-neutral-800 px-3 py-1.5 text-sm hover:bg-neutral-700"
            >
              登录
            </a>
          )}
        </div>
      </header>

      <div className="grid gap-4 sm:grid-cols-2">
        {views.map((v) => (
          <ProviderCard key={v.provider} view={v} onConfigure={authed ? openForm : undefined} />
        ))}
      </div>

      {authed && showForm && (
        <AddCredentialForm
          providers={providers.filter((p) => !views.find((v) => v.provider === p.provider)?.external)}
          initialProvider={formProvider ?? undefined}
          onSaved={() => {
            setShowForm(false);
            loadUsage();
          }}
          onClose={() => setShowForm(false)}
        />
      )}
    </main>
  );
}
