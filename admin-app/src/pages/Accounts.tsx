import { useCallback, useEffect, useState } from "react";
import { t } from "../i18n";
import { getLiveConnection } from "../live/config";
import { errorMessage, pcs } from "../live/client";
import { useAuth, strongPassword, type Account, type AccountRole } from "../auth";
import { Badge, Button, Callout, Card, Empty, Field, Modal, PageHead, Tag } from "../components/ui";

/** Every permission an account can carry; keep in sync with pcs-issuer/src/jwt.ts. */
const SCOPE_INFO: Array<{ scope: string; label: string; desc: string }> = [
  { scope: "host:read", label: "View hosts", desc: "Read hosts, resources and the federation tree" },
  { scope: "host:admin", label: "Manage hosts", desc: "Onboard, probe, bootstrap and delete hosts" },
  { scope: "deployment:read", label: "View deployments", desc: "Read deployments, plans and instances" },
  { scope: "deployment:write", label: "Deploy and control", desc: "Create deployments; start, stop, restart or remove containers" },
  { scope: "profile:read", label: "View profiles", desc: "Read Agent / API profiles and bindings" },
  { scope: "profile:write", label: "Manage profiles", desc: "Create, edit and delete profiles and bindings" },
  { scope: "approval:issue", label: "Issue approvals", desc: "Issue one-time approval tokens" },
  { scope: "audit:read", label: "View audit log", desc: "Read the audit log (non-administrators only their own)" },
  { scope: "account:read", label: "View accounts", desc: "List accounts and their permissions" },
  { scope: "account:write", label: "Manage accounts", desc: "Create, approve and disable accounts; change permissions" },
];

const ROLE_PRESETS: Record<Exclude<AccountRole, "custom">, string[]> = {
  admin: SCOPE_INFO.map((s) => s.scope),
  operator: ["host:read", "deployment:read", "deployment:write", "profile:read", "profile:write", "audit:read"],
  viewer: ["host:read", "deployment:read", "profile:read", "audit:read"],
};

const ROLE_LABEL: Record<AccountRole, string> = {
  admin: "Admin",
  operator: "Operator",
  viewer: "Viewer",
  custom: "Custom",
};

type AuditRow = {
  audit_id?: number;
  action?: string;
  operator_id?: string;
  subject?: string;
  actor_ip?: string | null;
  detail?: Record<string, unknown>;
  created_at?: string;
};

export function AccountsPage() {
  const auth = useAuth();
  const canWrite = auth.hasScope("account:write");
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<Account | "new" | null>(null);
  const [historyOf, setHistoryOf] = useState<Account | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const out = await pcs<{ accounts: Account[] }>(getLiveConnection(), "/api/v1/platform/accounts");
      setAccounts(out.accounts ?? []);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function setStatus(account: Account, status: "ACTIVE" | "DISABLED") {
    setError("");
    try {
      await pcs(getLiveConnection(), `/api/v1/platform/accounts/${encodeURIComponent(account.account_id)}`, {
        method: "PATCH",
        body: { status },
      });
      await load();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  if (!auth.hasScope("account:read")) {
    return (
      <div className="page">
        <PageHead title={t("Accounts")} />
        <Callout tone="warn">{t("This account cannot view accounts.")}</Callout>
      </div>
    );
  }

  return (
    <div className="page">
      <PageHead
        title={t("Accounts")}
        meta={
          <>
            <span>{t("{count} accounts", { count: accounts.length })}</span>
            <span className="sep" />
            <span>{t("Registration: later accounts need administrator approval")}</span>
          </>
        }
        actions={
          canWrite ? (
            <Button variant="primary" onClick={() => setEditing("new")}>
              {t("New account")}
            </Button>
          ) : undefined
        }
      />

      {error && <Callout tone="bad">{error}</Callout>}

      <Card flush>
        {loading ? (
          <Empty text={t("Loading…")} />
        ) : accounts.length === 0 ? (
          <Empty text={t("No accounts yet.")} />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t("Username")}</th>
                  <th>{t("Display name")}</th>
                  <th>{t("Role")}</th>
                  <th>{t("Status")}</th>
                  <th>{t("Permissions")}</th>
                  <th>{t("Last sign-in")}</th>
                  <th>{t("Action")}</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((a) => (
                  <tr key={a.account_id}>
                    <td><code>{a.username}</code></td>
                    <td>{a.display_name}</td>
                    <td><Tag tone={a.role === "admin" ? "accent" : "neutral"}>{t(ROLE_LABEL[a.role])}</Tag></td>
                    <td><Badge value={a.status} /></td>
                    <td>{t("{count} permissions", { count: a.scopes.length })}</td>
                    <td>{a.last_login_at ? new Date(a.last_login_at).toLocaleString() : "-"}</td>
                    <td>
                      <div className="row" style={{ gap: 6 }}>
                        <Button size="sm" onClick={() => setHistoryOf(a)}>{t("History")}</Button>
                        {canWrite && (
                          <Button size="sm" onClick={() => setEditing(a)}>{t("Edit")}</Button>
                        )}
                        {canWrite && a.status === "PENDING" && (
                          <Button size="sm" variant="primary" onClick={() => void setStatus(a, "ACTIVE")}>
                            {t("Approve")}
                          </Button>
                        )}
                        {canWrite && a.status === "ACTIVE" && a.account_id !== auth.account?.account_id && (
                          <Button size="sm" variant="danger" onClick={() => void setStatus(a, "DISABLED")}>
                            {t("Disable")}
                          </Button>
                        )}
                        {canWrite && a.status === "DISABLED" && (
                          <Button size="sm" onClick={() => void setStatus(a, "ACTIVE")}>{t("Enabled")}</Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {editing && (
        <AccountModal
          value={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await load();
          }}
        />
      )}

      {historyOf && <AccountHistoryModal account={historyOf} onClose={() => setHistoryOf(null)} />}
    </div>
  );
}

function AccountModal({
  value,
  onClose,
  onSaved,
}: {
  value: Account | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [username, setUsername] = useState(value?.username ?? "");
  const [displayName, setDisplayName] = useState(value?.display_name ?? "");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<AccountRole>(value?.role ?? "viewer");
  const [scopes, setScopes] = useState<string[]>(value?.scopes ?? ROLE_PRESETS.viewer);
  const [status, setStatus] = useState<"PENDING" | "ACTIVE" | "DISABLED">(value?.status ?? "ACTIVE");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function chooseRole(next: AccountRole) {
    setRole(next);
    if (next !== "custom") setScopes([...ROLE_PRESETS[next]]);
  }

  function toggleScope(scope: string) {
    setRole("custom");
    setScopes((prev) => (prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope]));
  }

  async function submit() {
    setBusy(true);
    setError("");
    try {
      if (value) {
        await pcs(getLiveConnection(), `/api/v1/platform/accounts/${encodeURIComponent(value.account_id)}`, {
          method: "PATCH",
          body: {
            display_name: displayName.trim() || value.username,
            role,
            scopes,
            status,
            ...(password ? { password } : {}),
          },
        });
      } else {
        await pcs(getLiveConnection(), "/api/v1/platform/accounts", {
          method: "POST",
          body: {
            username: username.trim(),
            password,
            display_name: displayName.trim() || undefined,
            role,
            scopes,
          },
        });
      }
      await onSaved();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const valid = value
    ? displayName.trim().length <= 64 && (!password || strongPassword(password))
    : /^[a-zA-Z0-9._-]{3,32}$/.test(username.trim()) && strongPassword(password);

  return (
    <Modal
      open
      title={value ? t("Edit account") : t("New account")}
      onClose={onClose}
      width={640}
      footer={
        <>
          <Button onClick={onClose}>{t("Cancel")}</Button>
          <Button variant="primary" onClick={submit} disabled={busy || !valid}>
            {busy ? t("Saving…") : t("Save")}
          </Button>
        </>
      }
    >
      <div className="stack">
        {!value && (
          <Field label={t("Username")} hint={t("3–32 characters: letters, digits, dot, underscore or dash")}>
            <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} />
          </Field>
        )}
        <Field label={t("Display name")}>
          <input className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </Field>
        <Field
          label={value ? t("Reset password") : t("Initial password")}
          hint={
            value
              ? t("Leave blank to keep it; a reset signs out every session and must meet the password policy")
              : t("Longer than 8 characters, with uppercase, lowercase and a symbol")
          }
        >
          <input
            className="input"
            type="password"
            value={password}
            autoComplete="new-password"
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <Field label={t("Role")}>
          <select className="input" value={role} onChange={(e) => chooseRole(e.target.value as AccountRole)}>
            {(["admin", "operator", "viewer", "custom"] as const).map((r) => (
              <option key={r} value={r}>{t(ROLE_LABEL[r])}</option>
            ))}
          </select>
        </Field>
        {value && (
          <Field label={t("Status")}>
            <select
              className="input"
              value={status}
              onChange={(e) => setStatus(e.target.value as "PENDING" | "ACTIVE" | "DISABLED")}
            >
              <option value="PENDING">{t("Pending")}</option>
              <option value="ACTIVE">{t("Enabled")}</option>
              <option value="DISABLED">{t("Disable")}</option>
            </select>
          </Field>
        )}
        <Field label={t("Permissions")} hint={t("Checking a box switches to a custom role; administrators have every permission")}>
          <div className="stack">
            {SCOPE_INFO.map((info) => (
              <label className="check-row" key={info.scope}>
                <input
                  type="checkbox"
                  checked={scopes.includes(info.scope)}
                  onChange={() => toggleScope(info.scope)}
                />
                <span>
                  <b>{t(info.label)}</b>
                  <small>{t(info.desc)}</small>
                </span>
                <Tag>{info.scope}</Tag>
              </label>
            ))}
          </div>
        </Field>
        {error && <Callout tone="bad">{error}</Callout>}
      </div>
    </Modal>
  );
}

function AccountHistoryModal({ account, onClose }: { account: Account; onClose: () => void }) {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const out = await pcs<{ audit_logs: AuditRow[] }>(
          getLiveConnection(),
          `/api/v1/platform/audit-logs?account_id=${encodeURIComponent(account.account_id)}&limit=200`,
        );
        if (!cancelled) setRows(out.audit_logs ?? []);
      } catch (e) {
        if (!cancelled) setError(errorMessage(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [account.account_id]);

  return (
    <Modal open title={t("Operations by {name}", { name: account.username })} onClose={onClose} width={760}>
      {error && <Callout tone="bad">{error}</Callout>}
      {loading ? (
        <Empty text={t("Loading…")} />
      ) : rows.length === 0 ? (
        <Empty text={t("No operations recorded yet.")} />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t("Time")}</th>
                <th>{t("Action")}</th>
                <th>{t("Object")}</th>
                <th>IP</th>
                <th>{t("Details")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={String(r.audit_id)}>
                  <td>{r.created_at ? new Date(r.created_at).toLocaleString() : "-"}</td>
                  <td><code>{r.action ?? "-"}</code></td>
                  <td>{r.subject ?? "-"}</td>
                  <td>{r.actor_ip ?? "-"}</td>
                  <td>
                    <span className="muted">
                      {r.detail && Object.keys(r.detail).length ? JSON.stringify(r.detail) : "-"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}
