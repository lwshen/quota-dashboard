"use client";

import { useCallback, useEffect, useState } from "react";
import { Header } from "@/components/Header";
import { LoginModal } from "@/components/LoginModal";
import { ProviderCard, type ProviderView } from "@/components/ProviderCard";
import { AddCredentialForm, type ProviderMeta } from "@/components/AddCredentialForm";

export default function Home() {
  const [views, setViews] = useState<ProviderView[]>([]);
  const [providers, setProviders] = useState<ProviderMeta[]>([]);
  const [authed, setAuthed] = useState(false);
  const [now, setNow] = useState(0);

  const [showLogin, setShowLogin] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [formProvider, setFormProvider] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const loadUsage = useCallback(async () => {
    try {
      const res = await fetch("/api/usage", { cache: "no-store" });
      const j = await res.json();
      setViews(j.providers ?? []);
    } catch {
      // keep the last view on transient errors
    }
  }, []);

  const loadSession = useCallback(async () => {
    try {
      const j = await fetch("/api/session").then((r) => r.json());
      setAuthed(Boolean(j.authed));
    } catch {
      // ignore
    }
  }, []);

  // Live clock / countdown tick (client only, so no SSR hydration mismatch).
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    loadSession();
    fetch("/api/providers")
      .then((r) => r.json())
      .then((j) => setProviders(j.providers ?? []))
      .catch(() => {});
    loadUsage();
    const t = setInterval(loadUsage, 15_000);
    return () => clearInterval(t);
  }, [loadSession, loadUsage]);

  const refreshNow = useCallback(async () => {
    setRefreshing(true);
    try {
      await fetch("/api/refresh", { method: "POST" });
      await loadUsage();
    } finally {
      setRefreshing(false);
    }
  }, [loadUsage]);

  function openForm(provider?: string) {
    setFormProvider(provider ?? null);
    setShowForm(true);
  }

  async function logout() {
    try {
      await fetch("/api/logout", { method: "POST" });
    } finally {
      setAuthed(false);
      setShowForm(false);
      // Re-fetch so account identity (balance / email) drops from the public view.
      loadUsage();
    }
  }

  async function onLoginSuccess() {
    setShowLogin(false);
    await Promise.all([loadSession(), loadUsage()]);
  }

  return (
    <div className="app">
      <div className="shell">
        <Header
          now={now}
          authed={authed}
          refreshing={refreshing}
          onOpenLogin={() => setShowLogin(true)}
          onRefresh={refreshNow}
          onAddCredential={() => openForm()}
          onLogout={logout}
        />

        <div className="qgrid">
          {views.map((v) => (
            <ProviderCard
              key={v.provider}
              view={v}
              now={now}
              authed={authed}
              onConfigure={authed ? openForm : undefined}
            />
          ))}
        </div>
      </div>

      {showLogin && <LoginModal onClose={() => setShowLogin(false)} onSuccess={onLoginSuccess} />}

      {authed && showForm && (
        <AddCredentialForm
          providers={providers}
          initialProvider={formProvider ?? undefined}
          onSaved={() => {
            setShowForm(false);
            loadUsage();
          }}
          onClose={() => setShowForm(false)}
        />
      )}
    </div>
  );
}
