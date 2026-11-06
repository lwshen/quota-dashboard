"use client";

import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { Header } from "@/components/Header";
import { LoginModal } from "@/components/LoginModal";
import { ProviderCard, type ProviderView } from "@/components/ProviderCard";
import { ProviderSettings } from "@/components/ProviderSettings";

const UsageHistoryDialog = dynamic(() => import("@/components/UsageHistoryDialog").then((module) => module.UsageHistoryDialog));

export default function Home() {
  const [views, setViews] = useState<ProviderView[]>([]);
  const [usageLoaded, setUsageLoaded] = useState(false);
  const [authed, setAuthed] = useState(false);
  const [now, setNow] = useState(0);

  const [showLogin, setShowLogin] = useState(false);
  const [showProviderSettings, setShowProviderSettings] = useState(false);
  const [managedProvider, setManagedProvider] = useState<string | undefined>();
  const [refreshing, setRefreshing] = useState(false);
  const [historyProvider, setHistoryProvider] = useState<string | null>(null);

  const loadUsage = useCallback(async () => {
    try {
      const res = await fetch("/api/usage", { cache: "no-store" });
      if (!res.ok) return;
      const j = await res.json();
      setViews(j.providers ?? []);
      setUsageLoaded(true);
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

  function openManagement(provider?: string) {
    setManagedProvider(provider);
    setShowProviderSettings(true);
  }

  async function logout() {
    try {
      await fetch("/api/logout", { method: "POST" });
    } finally {
      setAuthed(false);
      setShowProviderSettings(false);
      setHistoryProvider(null);
      // Re-fetch so account identity (balance / email) drops from the public view.
      loadUsage();
    }
  }

  async function onLoginSuccess() {
    setShowLogin(false);
    await Promise.all([loadSession(), loadUsage()]);
  }

  const selectedHistoryProvider = views.find((view) => view.provider === historyProvider);

  return (
    <div className="app">
      <div className="shell">
        <Header
          now={now}
          authed={authed}
          refreshing={refreshing}
          onOpenLogin={() => setShowLogin(true)}
          onRefresh={refreshNow}
          onManageProviders={() => openManagement()}
          onLogout={logout}
        />

        {usageLoaded && views.length === 0 && (
          <div className="qcard">
            <div className="emptystate">暂无显示的渠道{authed ? "，可在「渠道管理」中开启。" : "。"}</div>
          </div>
        )}
        <div className="qgrid">
          {views.map((v) => (
            <ProviderCard
              key={v.provider}
              view={v}
              now={now}
              authed={authed}
              onConfigure={authed ? openManagement : undefined}
              onHistory={setHistoryProvider}
            />
          ))}
        </div>
      </div>

      {showLogin && <LoginModal onClose={() => setShowLogin(false)} onSuccess={onLoginSuccess} />}

      {selectedHistoryProvider && (
        <UsageHistoryDialog key={selectedHistoryProvider.provider} provider={selectedHistoryProvider.provider}
          label={selectedHistoryProvider.label}
          authed={authed} onClose={() => setHistoryProvider(null)} />
      )}

      {authed && showProviderSettings && (
        <ProviderSettings initialProvider={managedProvider} onClose={() => setShowProviderSettings(false)} onChanged={loadUsage} />
      )}
    </div>
  );
}
