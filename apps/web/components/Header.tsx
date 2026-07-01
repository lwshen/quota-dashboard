"use client";

import { useState } from "react";
import { formatClock } from "@/lib/format";
import { useOnEscape } from "@/lib/hooks";

export function Header({
  now,
  authed,
  refreshing,
  onOpenLogin,
  onRefresh,
  onAddCredential,
  onLogout,
}: {
  now: number;
  authed: boolean;
  refreshing: boolean;
  onOpenLogin: () => void;
  onRefresh: () => void;
  onAddCredential: () => void;
  onLogout: () => void;
}) {
  // Initialize from the attribute the no-flash script already applied to <html>, so the
  // toggle label is correct on first client render (server renders the "dark" default;
  // suppressHydrationWarning on the button covers the intentional client/server difference).
  const [theme, setTheme] = useState<"dark" | "light">(() =>
    typeof document !== "undefined" && document.documentElement.dataset.theme === "light" ? "light" : "dark",
  );
  const [menuOpen, setMenuOpen] = useState(false);

  useOnEscape(() => setMenuOpen(false));

  function toggleTheme() {
    setTheme((prev) => {
      const next = prev === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      try {
        localStorage.setItem("qd-theme", next);
      } catch {
        // ignore storage failures (private mode, etc.)
      }
      return next;
    });
  }

  return (
    <div className="hdr">
      <div className="row" style={{ gap: 13 }}>
        <span className="logodot">◇</span>
        <div>
          <div className="h-title">Quota Dashboard</div>
          <div className="h-sub">AI 服务商配额 · 用量看板</div>
        </div>
      </div>
      <div className="ctl">
        <span className="live">
          <span className="livedot" />
          <span className="mono">{formatClock(now)}</span>
        </span>
        <button type="button" className="tgl" onClick={toggleTheme} suppressHydrationWarning>
          ◐ {theme === "dark" ? "Light" : "Dark"}
        </button>
        <div style={{ position: "relative" }}>
          {authed ? (
            <>
              <button type="button" className="userchip" onClick={() => setMenuOpen((o) => !o)}>
                <span className="avatar">A</span>
                <span className="uemail">Admin</span>
                <span style={{ color: "var(--faint)", fontSize: 10 }}>▾</span>
              </button>
              {menuOpen ? (
                <>
                  <div onClick={() => setMenuOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 30 }} />
                  <div className="menu">
                    <div className="menu-h">
                      <div style={{ fontSize: 12.5, fontWeight: 600 }}>已登录 · Admin</div>
                      <div style={{ fontSize: 11, color: "var(--faint)", marginTop: 2 }}>管理员 · Administrator</div>
                    </div>
                    <button
                      type="button"
                      className="menu-item"
                      disabled={refreshing}
                      onClick={() => {
                        setMenuOpen(false);
                        onRefresh();
                      }}
                    >
                      <span className="mi-icon">↻</span>
                      {refreshing ? "刷新中… · refreshing" : "刷新数据 · Refresh"}
                    </button>
                    <button
                      type="button"
                      className="menu-item"
                      onClick={() => {
                        setMenuOpen(false);
                        onAddCredential();
                      }}
                    >
                      <span className="mi-icon">⚿</span>配置凭据 · Credentials
                    </button>
                    <button
                      type="button"
                      className="menu-item"
                      style={{ color: "var(--danger)" }}
                      onClick={() => {
                        setMenuOpen(false);
                        onLogout();
                      }}
                    >
                      <span>⏻</span>退出登录 · Sign out
                    </button>
                  </div>
                </>
              ) : null}
            </>
          ) : (
            <button type="button" className="login" onClick={onOpenLogin}>
              登录
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
