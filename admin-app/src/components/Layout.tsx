import { t, useI18n } from "../i18n";
import { useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useHostScope } from "../host-context";
import { useLive } from "../live/context";
import { useAuth } from "../auth";
import { Icon } from "./Icon";

// Copy is translated at render time: module-level constants are evaluated once, so calling t() here would freeze the startup language.
const NAV: { to: string; label: string; icon: string }[] = [
  { to: "/", label: "Overview", icon: "grid" },
  { to: "/builders", label: "Builders", icon: "box" },
  { to: "/scheduler", label: "Schedulers", icon: "clock" },
  { to: "/profiles", label: "Configuration", icon: "layers" },
  { to: "/roles", label: "Business roles", icon: "agent" },
  { to: "/plans", label: "Plans", icon: "workflow" },
  { to: "/tasks", label: "Tasks", icon: "tasks" },
  { to: "/terminal", label: "Terminal", icon: "terminal" },
  { to: "/chat", label: "Chat", icon: "chat" },
  { to: "/logs", label: "Logs", icon: "logs" },
];

function transportLabel(host: { transport?: string; address?: string }): string {
  if (host.transport === "local") return t("Local");
  return host.address || "SSH";
}

export function Layout() {
  const [theme, setTheme] = useState(() => localStorage.getItem("app-theme") ?? "light");
  const [hostOpen, setHostOpen] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);
  const { hosts, host, setHostId } = useHostScope();
  const { lang, setLang } = useI18n();
  const live = useLive();
  const auth = useAuth();
  const navigate = useNavigate();
  // Policy and account management are only shown to principals that may read them.
  const nav = [
    ...NAV,
    ...(auth.hasScope("audit:read")
      ? [{ to: "/policy", label: "Policy", icon: "shield" }]
      : []),
    ...(auth.hasScope("account:read")
      ? [{ to: "/accounts", label: "Accounts", icon: "user" }]
      : []),
  ];

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("app-theme", theme);
  }, [theme]);

  useEffect(() => {
    if (!hostOpen) return;
    const close = (event: MouseEvent) => {
      if (!hostRef.current?.contains(event.target as Node)) setHostOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [hostOpen]);

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">
            <Icon name="bot" size={16} />
          </span>
          <span className="brand-name">ACP</span>
        </div>

        <nav>
          {nav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/"}
              className={({ isActive }) => `nav-item${isActive ? " active" : ""}`}
              title={t(item.label)}
            >
              <Icon name={item.icon} size={15} />
              <span>{t(item.label)}</span>
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-foot" ref={hostRef}>
          {hostOpen && (
            <div className="host-menu" role="menu">
              {hosts.map((item) => (
                <button
                  key={item.id}
                  className={`host-menu-item${item.id === host?.id ? " active" : ""}`}
                  onClick={() => {
                    setHostId(item.id);
                    setHostOpen(false);
                    // The host scope changed, so leave host-specific pages (a builder/scheduler detail view may not
                    // exist on the new host) and return to the overview.
                    navigate("/");
                  }}
                >
                  <i className={`dot dot-${item.state === "ONLINE" ? "ok" : item.state === "REVOKED" ? "bad" : "idle"}`} />
                  <span>
                    <b>{item.name}</b>
                    <small>{transportLabel(item)}</small>
                  </span>
                  {item.id === host?.id && <Icon name="check" size={13} />}
                </button>
              ))}
              {hosts.length === 0 && <p className="host-menu-empty">{t("No hosts yet")}</p>}
              <NavLink className="host-menu-link" to="/hosts" onClick={() => setHostOpen(false)}>
                {t("Manage hosts")}
              </NavLink>
            </div>
          )}

          <div className="side-user">
            <Icon name="user" size={14} />
            <span className="side-user-name" title={auth.account?.username ?? t("CLI token")}>
              {auth.account?.display_name || auth.account?.username || t("CLI token")}
            </span>
            <button
              className="icon-btn"
              title={t("Sign out")}
              aria-label={t("Sign out")}
              onClick={() => void auth.logout()}
            >
              <Icon name="close" size={13} />
            </button>
          </div>

          <button className="host-switch" title={host?.name ?? t("Select host")} onClick={() => setHostOpen((v) => !v)}>
            <i className={`dot ${host?.state === "ONLINE" ? "dot-ok" : "dot-idle"}`} />
            <span className="host-switch-text">
              <b>{host?.name ?? t("Select host")}</b>
              <small>{host ? transportLabel(host) : t("Add host")}</small>
            </span>
            <Icon name="server" size={14} className="host-switch-mobile" />
            <Icon name="chevron" size={13} />
          </button>

          <div className="side-row">
            <button
              className="conn"
              onClick={() => void live.refresh()}
              disabled={live.syncing}
              title={
                !host
                  ? t("No host connected; click to resync")
                  : live.error || t("Resync live data")
              }
            >
              <i className={`dot ${!host ? "dot-idle" : live.error ? "dot-warn" : live.connected ? "dot-ok" : "dot-idle"}`} />
              <span>{!host ? t("Disconnected") : live.error ? t("Connection failed") : live.connected ? t("Live") : t("Connecting…")}</span>
              <Icon name="refresh" size={13} />
            </button>
            <button
              className="icon-btn lang-switch"
              title={lang === "zh" ? "English" : "Chinese"}
              aria-label={lang === "zh" ? "Switch to English" : "Switch to Chinese"}
              onClick={() => setLang(lang === "zh" ? "en" : "zh")}
            >
              <Icon name="globe" size={14} />
              <span className="lang-switch-label">{lang === "zh" ? "EN" : "ZH"}</span>
            </button>
            <button
              className="icon-btn"
              title={theme === "light" ? t("Dark") : t("Light")}
              onClick={() => setTheme(theme === "light" ? "dark" : "light")}
            >
              <Icon name={theme === "light" ? "moon" : "sun"} size={14} />
            </button>
          </div>
        </div>
      </aside>

      <main className="main">
        <div className="content">
          <Outlet />
        </div>
      </main>

    </div>
  );
}
