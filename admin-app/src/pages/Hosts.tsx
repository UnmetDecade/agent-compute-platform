import { t } from "../i18n";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { db } from "../store";
import { useLive } from "../live/context";
import { ApiError, errorMessage } from "../live/client";
import {
  addHost,
  bootstrapHost,
  editHost,
  mergeHost,
  removeHostContainers,
  removeHostFromList,
  type HostDraft,
} from "../api";
import type { Host, HostProbe, HostRoleMode } from "../types";
import { Badge, Button, Callout, Card, Empty, Field, Modal, PageHead, Tag } from "../components/ui";
import { Icon } from "../components/Icon";

/**
 * Hosts page: one host = one machine running Docker; schedulers and builders are containers on it.
 * The local host is the machine running the admin app; remote hosts are onboarded over SSH and the private key is stored encrypted by PCS.
 *
 * The list stays a summary (state, address, hardware, components). Everything that acts on a host
 * lives on its detail page, the same split the builder list uses.
 */

/** On probe failure, give an actionable reason instead of dumping raw ssh output on the user. */
export function probeHint(error?: string): string {
  if (!error) return t("Unknown error");
  if (/Permission denied \(publickey/i.test(error)) {
    return t("The remote host rejected this key: its public key is not in ~/.ssh/authorized_keys, or the key is passphrase-protected or incomplete.");
  }
  if (/Host key verification failed/i.test(error)) {
    return t("The remote SSH fingerprint differs from the recorded one; confirm the machine has not been replaced.");
  }
  if (/timed out|ETIMEDOUT/i.test(error)) {
    return t("Connection timed out: check address, port, and firewall.");
  }
  if (/Connection refused|ECONNREFUSED/i.test(error)) {
    return t("Connection refused: make sure sshd is listening on this port.");
  }
  return error;
}

/** Deployments without host-runtime (the one-command demo) reject host creation. */
function hostErrorText(e: unknown): string {
  if (e instanceof ApiError && e.code === "DEMO_MODE") return t("Demo mode does not support adding hosts");
  return errorMessage(e);
}
export function HostsPage() {
  const live = useLive();
  const [params, setParams] = useSearchParams();
  // The studio sends operators here with ?add=1 when no host exists yet, so the
  // dialog opens immediately instead of making them find the button. Deriving it
  // from the URL also covers navigating from /hosts to /hosts?add=1.
  const addRequested = params.get("add") === "1";
  // Snapshot the arrival mode: the page fade would blink underneath a dialog that
  // is already open, so this arrival skips it. Keeping it in state prevents the
  // animation from restarting when the parameter is cleared on close.
  const [skipEnter] = useState(addRequested);
  const [addOpen, setAddOpen] = useState(false);
  const showAdd = addOpen || addRequested;
  const hosts = db.hosts;
  const local = hosts.filter((h) => h.transport === "local").length;
  const online = hosts.filter((h) => h.state === "ONLINE").length;

  function closeAdd() {
    setAddOpen(false);
    if (params.get("add")) {
      params.delete("add");
      setParams(params, { replace: true });
    }
  }

  return (
    <div className={`page${skipEnter ? " page-static" : ""}`}>
      <PageHead
        title={t("Host")}
        meta={
          <>
            <span>{t("{count} units", { count: hosts.length })}</span>
            <span className="sep" />
            <span>{t("{count} online", { count: online })}</span>
            <span className="sep" />
            <span>{t("Local {count}", { count: local })}</span>
            {db.fleet.total_score > 0 && (
              <>
                <span className="sep" />
                <span>ΣW {db.fleet.total_score}</span>
              </>
            )}
          </>
        }
        actions={
          <Button variant="primary" onClick={() => setAddOpen(true)}>
            <Icon name="plus" size={14} />
            {t("Add host")}
          </Button>
        }
      />

      {hosts.length === 0 ? (
        <Card>
          <Empty text={t("No hosts yet. Add the local host running the admin UI, or join a remote machine over SSH.")} />
        </Card>
      ) : (
        <Card flush>
          <div className="list">
            {hosts.map((h) => (
              <HostRow key={h.id} host={h} />
            ))}
          </div>
        </Card>
      )}

      <AddHostModal
        open={showAdd}
        onClose={closeAdd}
        onDone={async () => {
          if (live.connected) await live.refresh();
        }}
      />
    </div>
  );
}

function HostRow({ host }: { host: Host }) {
  const components = db.instances.filter((i) => i.host_id === host.id);
  const parent = host.parent_host_id ? db.hosts.find((h) => h.id === host.parent_host_id) : undefined;
  const subtreeScore = host.subtree_score ?? 0;
  const roleMode = host.role_mode ?? "containers";
  const probe = host.last_probe;
  const probeOk = probe?.ok === true;
  const address = host.address || host.name;

  return (
    <div className="list-row">
      <div className="list-main">
        <div className="list-title">
          <Link className="strong" to={`/hosts/${host.id}`}>{host.name}</Link>
          <Badge value={host.state} />
          <Tag tone={host.transport === "local" ? "accent" : undefined}>
            {host.transport === "local" ? t("Local") : host.transport === "ssh" ? "SSH" : t("Manual")}
          </Tag>
          {roleMode !== "containers" && (
            <Tag tone="warn">{roleMode === "builder" ? t("Bare-metal builder") : t("Bare-metal scheduler")}</Tag>
          )}
          {parent && <Tag title={t("Parent host to merge into")}>{t("Merged into {host}", { host: parent.name })}</Tag>}
          {subtreeScore > 0 && (
            <Tag tone="accent" title={t("ΣW of this host and all descendant builders")}>
              ΣW {subtreeScore}
            </Tag>
          )}
          {probe && (
            <Tag tone={probeOk ? "ok" : "bad"} title={probeOk ? undefined : probeHint(probe.error)}>
              {probeOk ? t("Reachable") : t("Unreachable")}
            </Tag>
          )}
        </div>
        <div className="list-meta">
          <span>{host.os} {host.arch}</span>
          <span>{t("Runtime {version}", { version: host.runtime_version })}</span>
          {host.transport === "ssh" && (
            <code>{host.ssh_user ?? "root"}@{address}:{host.ssh_port ?? 22}</code>
          )}
          <span className="sep" />
          <span>{host.cpu_total}C / {Math.round(host.mem_total_mb / 1024)}G</span>
          {host.local_score ? <span>{t("Local W {score}", { score: host.local_score })}</span> : null}
          <span>CPU {host.cpu}%</span>
          <span>{t("Memory {pct}%", { pct: host.mem })}</span>
          <span>{t("Disk {pct}%", { pct: host.disk })}</span>
        </div>
        <div className="list-meta">
          {components.length === 0 ? (
            <span>{t("No components")}</span>
          ) : (
            <span>{t("{count} components", { count: components.length })}</span>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Delete host: remove checked containers one by one, or delete the whole host.
 *
 * Single deletion removes only containers and data volumes; "Delete all" waits for the host to confirm every container is removed
 * before deleting the host record, after which the host disappears from the list. A mid-way failure preserves the state and shows the reason.
 */
export function DeleteHostModal({
  host,
  onClose,
  onDone,
  onDeleted,
}: {
  host: Host | null;
  onClose: () => void;
  onDone: () => Promise<void>;
  /** Called after the host record itself is gone, so the detail page can leave before it renders "not found". */
  onDeleted?: () => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [clearData, setClearData] = useState(false);
  const [busy, setBusy] = useState<"" | "all" | "list">("");
  const [error, setError] = useState("");
  const containers = host ? db.instances.filter((i) => i.host_id === host.id) : [];
  const allSelected = containers.length > 0 && selected.length === containers.length;

  useEffect(() => {
    setSelected([]);
    setClearData(false);
    setBusy("");
    setError("");
  }, [host?.id]);

  if (!host) return null;

  function toggle(id: string) {
    setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  }

  async function remove(ids: string[], purge: boolean, kind: "all" | "list") {
    const ask = purge
      ? ids.length
        ? t("Delete all {count} containers and volumes on {host} and clear the host data? This cannot be undone.", { host: host!.name, count: ids.length })
        : t("Clear {host}'s host data and remove it from the list?", { host: host!.name })
      : ids.length
        ? t("Remove {host} from the list? The {count} checked containers and their volumes will be deleted; other containers and data are kept.", { host: host!.name, count: ids.length })
        : t("Remove {host} from the list? Containers and data are kept; connecting the same host again will pick up where it left off.", { host: host!.name });
    if (!window.confirm(ask)) return;
    setBusy(kind);
    setError("");
    try {
      if (kind === "list") await removeHostFromList(host!.id, ids, onDone);
      else await removeHostContainers(host!.id, ids, purge, onDone);
      onClose();
      onDeleted?.();
    } catch (e) {
      setError(errorMessage(e));
      setBusy("");
    }
  }

  return (
    <Modal
      open
      title={t("Delete host · {name}", { name: host.name })}
      onClose={onClose}
      width={560}
      footer={
        <>
          <Button onClick={onClose} disabled={Boolean(busy)}>{t("Cancel")}</Button>
          <Button
            variant={clearData ? "danger" : "primary"}
            onClick={() =>
              clearData
                ? remove(containers.map((c) => c.id), true, "all")
                : remove(selected, false, "list")
            }
            disabled={Boolean(busy)}
          >
            {busy === "all" || busy === "list"
              ? t("Working…")
              : clearData
                ? t("Delete all and clear data")
                : t("Remove from list")}
          </Button>
        </>
      }
    >
      <div className="stack">
        <Callout tone="warn">
          {t("Removing from the list keeps unchecked containers and their data, and the same host can be reused when connected again. Checking the option below deletes all containers and clears the host record.")}
        </Callout>

        <div className="list-title">
          <b>{t("Containers")} · {containers.length}</b>
          {containers.length > 0 && (
            <button
              type="button"
              className="link"
              onClick={() => setSelected(allSelected ? [] : containers.map((c) => c.id))}
              disabled={Boolean(busy) || clearData}
            >
              {allSelected ? t("Clear selection") : t("Select all")}
            </button>
          )}
        </div>

        {containers.length === 0 ? (
          <Empty text={t("No containers on this host yet.")} />
        ) : (
          <div className="stack" style={{ gap: 6, maxHeight: 320, overflowY: "auto" }}>
            {containers.map((c) => {
              const checked = selected.includes(c.id);
              return (
                <label key={c.key} className={`check-row${checked ? " checked" : ""}`}>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={Boolean(busy) || clearData}
                    onChange={() => toggle(c.id)}
                  />
                  <div>
                    <b>{c.name}</b>
                    <span className="small">
                      {" · "}{c.role === "scheduler" ? t("Scheduler container") : t("Builder container")} · {c.state}
                    </span>
                  </div>
                </label>
              );
            })}
          </div>
        )}

        <label className={`check-row${clearData ? " checked" : ""}`}>
          <input
            type="checkbox"
            checked={clearData}
            disabled={Boolean(busy)}
            onChange={() => setClearData((v) => !v)}
          />
          <div>
            <b>{t("Also delete containers and clear data")}</b>
            <span className="small">
              {" · "}{t("Containers, volumes, and the host record will be deleted. This cannot be undone.")}
            </span>
          </div>
        </label>

        {error && <Callout tone="bad">{error}</Callout>}
      </div>
    </Modal>
  );
}

/** Host settings: change the name, address, port, user, or replace the private key; re-probe immediately after saving. */
export function HostSettingsModal({
  host,
  onClose,
  onDone,
}: {
  host: Host | null;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [port, setPort] = useState(22);
  const [user, setUser] = useState("root");
  const [password, setPassword] = useState("");
  const [key, setKey] = useState("");
  const [roleMode, setRoleMode] = useState<HostRoleMode>("containers");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [probe, setProbe] = useState<HostProbe | null>(null);
  const [saved, setSaved] = useState(false);
  // After switching to a bare-metal builder, the control plane also starts a builder process; the result is reported separately.
  const [roleNotice, setRoleNotice] = useState<{ tone: "info" | "warn"; text: string } | null>(null);

  useEffect(() => {
    if (!host) return;
    setName(host.name);
    setAddress(host.address ?? "");
    setPort(host.ssh_port ?? 22);
    setUser(host.ssh_user ?? "root");
    setRoleMode(host.role_mode ?? "containers");
    setPassword("");
    setKey("");
    setError("");
    setProbe(null);
    setSaved(false);
    setRoleNotice(null);
    setBusy(false);
  }, [host?.id]);

  if (!host) return null;

  const ssh = host.transport === "ssh";

  async function submit() {
    setBusy(true);
    setError("");
    try {
      const out = await editHost(
        host!.id,
        ssh
          ? {
              name: name.trim() || undefined,
              address: address.trim(),
              port,
              user: user.trim() || "root",
              role_mode: roleMode,
              // Leaving it empty keeps the existing credential; filling in a private key switches to key auth.
              ...(key.trim() ? { private_key: key } : password ? { password } : {}),
            }
          : { name: name.trim() || undefined, role_mode: roleMode },
        onDone,
      );
      setProbe(out.probe ?? null);
      setRoleNotice(
        out.warning
          ? { tone: "warn", text: t("Role switched, but the bare-metal builder did not start: {reason}", { reason: out.warning }) }
          : out.native_builder
            ? {
                tone: "info",
                // Saving again is idempotent: the existing builder is reused, so "created" would be wrong.
                text: out.native_builder.created
                  ? t("Bare-metal builder created ({status}); it can take tasks after the host reports in.", {
                      status: out.native_builder.status,
                    })
                  : t("Bare-metal builder is already running ({status}).", {
                      status: out.native_builder.status,
                    }),
              }
            : null,
      );
      setSaved(true);
      // The credential is submitted only this once; clear it from memory right after saving.
      setPassword("");
      setKey("");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  function close() {
    setPassword("");
    setKey("");
    onClose();
  }

  return (
    <Modal
      open
      title={t("Host settings")}
      onClose={close}
      width={620}
      footer={
        saved ? (
          <Button variant="primary" onClick={close}>{t("Done")}</Button>
        ) : (
          <>
            <Button onClick={close}>{t("Cancel")}</Button>
            <Button
              variant="primary"
              onClick={submit}
              disabled={busy || (ssh && !address.trim())}
            >
              {busy ? t("Saving…") : t("Save & probe")}
            </Button>
          </>
        )
      }
    >
      <div className="stack">
        <Field label={t("Display name")}>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={ssh ? address || t("Host") : t("Local host")} />
        </Field>

        <Field label={t("Host role")} hint={t("Bare-metal role or containers — a host cannot be both a builder and a scheduler")}>
          <select
            className="input"
            value={roleMode}
            onChange={(e) => setRoleMode(e.target.value as HostRoleMode)}
          >
            <option value="containers">{t("Container host")}</option>
            <option value="builder">{t("Bare-metal builder")}</option>
            <option value="scheduler">{t("Bare-metal scheduler")}</option>
          </select>
        </Field>

        {ssh && (
          <>
            <div className="row">
              <Field label={t("Address")}>
                <input className="input" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="192.0.2.10" />
              </Field>
              <div className="shrink">
                <Field label={t("Port")}>
                  <input className="input" type="number" min={1} max={65535} value={port} onChange={(e) => setPort(Number(e.target.value))} />
                </Field>
              </div>
              <div className="shrink">
                <Field label={t("User")}>
                  <input className="input" value={user} onChange={(e) => setUser(e.target.value)} placeholder="root" />
                </Field>
              </div>
            </div>
            <Field
              label={t("Password")}
              hint={
                host.auth_type === "password"
                  ? t("Blank keeps the existing password.")
                  : t("Entering a password switches to password login; it is stored encrypted and never shown.")
              }
            >
              <input
                className="input"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={t("Blank = unchanged")}
              />
            </Field>
            <Field
              label={t("SSH private key")}
              hint={
                host.auth_type === "key"
                  ? host.key_fingerprint ? t("Leave blank to keep the existing private key ({fp}).", { fp: host.key_fingerprint }) : t("Leave blank to keep the existing private key.")
                  : t("Entering a private key switches to key login.")
              }
            >
              <textarea
                className="input code-editor"
                rows={7}
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder={t("Leave blank to keep the current key, or paste a new private key\n-----BEGIN OPENSSH PRIVATE KEY-----\n…")}
                spellCheck={false}
              />
            </Field>
          </>
        )}

        {saved && (
          <Callout tone={probe?.ok ? "info" : "warn"}>
            {probe?.ok
              ? t("Saved: {host}, Docker {docker}.", { host: probe.hostname ?? address, docker: probe.docker_version ?? t("Installed") })
              : t("Saved, but probing failed: {reason}.", { reason: probeHint(probe?.error) })}
          </Callout>
        )}
        {saved && roleNotice && <Callout tone={roleNotice.tone}>{roleNotice.text}</Callout>}
        {error && <Callout tone="bad">{error}</Callout>}
      </div>
    </Modal>
  );
}

/**
 * Host fold: attach this host's root scheduler into another host's federation tree.
 * Only the control plane's parent_host_id changes; the local scheduling chain, containers and internal identity stay the same.
 */
export function MergeHostModal({
  host,
  onClose,
  onDone,
}: {
  host: Host | null;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [parentId, setParentId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!host) return;
    setParentId(host.parent_host_id ?? "");
    setBusy(false);
    setError("");
  }, [host?.id]);

  if (!host) return null;

  // Cannot fold into itself or its own descendants: the server blocks it too, but obviously invalid options are filtered out here.
  const descendants = new Set<string>();
  const collect = (id: string) => {
    for (const h of db.hosts) {
      if (h.parent_host_id === id) {
        descendants.add(h.id);
        collect(h.id);
      }
    }
  };
  collect(host.id);
  const candidates = db.hosts.filter((h) => h.id !== host.id && !descendants.has(h.id));

  async function submit() {
    if (!parentId) {
      setError(t("Choose a parent host"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      await mergeHost(host!.id, parentId, onDone);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      title={t("Merge into host")}
      onClose={onClose}
      width={560}
      footer={
        <>
          <Button onClick={onClose}>{t("Cancel")}</Button>
          <Button variant="primary" onClick={submit} disabled={busy || !parentId}>
            {busy ? t("Merging…") : t("Merge")}
          </Button>
        </>
      }
    >
      <div className="stack">
        <Field label={t("Host")}>
          <div className="list-title">
            <b>{host.name}</b>
            <Tag>{host.role_mode === "containers" ? t("Container host") : host.role_mode === "builder" ? t("Bare-metal builder") : t("Bare-metal scheduler")}</Tag>
          </div>
        </Field>
        <Field label={t("Parent host")} hint={t("The parent must already have a root scheduler")}>
          {candidates.length === 0 ? (
            <Callout tone="warn">{t("No hosts available to merge.")}</Callout>
          ) : (
            <select className="input" value={parentId} onChange={(e) => setParentId(e.target.value)}>
              <option value="">{t("Choose parent host…")}</option>
              {candidates.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name} · {h.state} · ΣW {h.subtree_score ?? 0}
                </option>
              ))}
            </select>
          )}
        </Field>
        {error && <Callout tone="bad">{error}</Callout>}
      </div>
    </Modal>
  );
}

function AddHostModal({
  open,
  onClose,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [transport, setTransport] = useState<"local" | "ssh">("local");
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [port, setPort] = useState(22);
  const [user, setUser] = useState("root");
  const [password, setPassword] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [probe, setProbe] = useState<HostProbe | null>(null);
  const [created, setCreated] = useState(false);
  const [authKind, setAuthKind] = useState<"password" | "key" | null>(null);
  const [booting, setBooting] = useState(false);
  const [boot, setBoot] = useState<{ online: boolean; status: string; error?: string; log?: string } | null>(null);

  function reset() {
    setName("");
    setAddress("");
    setPort(22);
    setUser("root");
    setPassword("");
    setKey("");
    setError("");
    setProbe(null);
    setCreated(false);
    setAuthKind(null);
    setBooting(false);
    setBoot(null);
    setBusy(false);
  }

  async function submit() {
    setBusy(true);
    setError("");
    try {
      const input: HostDraft =
        transport === "local"
          ? { transport: "local", name: name.trim() || undefined }
          : {
              transport: "ssh",
              name: name.trim() || undefined,
              address: address.trim(),
              port,
              user: user.trim() || "root",
              // Private key wins; when both are filled, use the key and do not send the password.
              ...(key.trim()
                ? { private_key: key }
                : { password }),
            };
      if (transport === "ssh" && !address.trim()) throw new Error(t("Enter the host address"));
      if (transport === "ssh" && !key.trim() && !password) {
        throw new Error(t("Enter a password or private key"));
      }
      setAuthKind(transport === "ssh" && !key.trim() && password ? "password" : transport === "ssh" ? "key" : null);
      const out = await addHost(input, onDone);
      setProbe(out.probe ?? null);
      setCreated(true);
      // The credential is submitted once; clear it from memory immediately regardless of the probe result.
      setPassword("");
      setKey("");
      // On a successful probe, start the runtime at the same time to save a click; if that fails it can still be retried from the host row.
      if (out.probe?.ok) {
        setBooting(true);
        try {
          const b = await bootstrapHost(out.host_id, onDone);
          setBoot({ online: b.online, status: b.status, log: b.log });
        } catch (e) {
          setBoot({ online: false, status: "FAILED", error: hostErrorText(e) });
        } finally {
          setBooting(false);
        }
      }
    } catch (e) {
      setError(hostErrorText(e));
    } finally {
      setBusy(false);
    }
  }

  function close() {
    reset();
    onClose();
  }

  return (
    <Modal
      open={open}
      title={t("Add host")}
      onClose={close}
      width={620}
      footer={
        created ? (
          <Button variant="primary" onClick={close} disabled={booting}>
            {booting ? t("Installing environment…") : t("Done")}
          </Button>
        ) : (
          <>
            <Button onClick={close}>{t("Cancel")}</Button>
            <Button
              variant="primary"
              onClick={submit}
              disabled={
                busy ||
                (transport === "ssh" && (!address.trim() || (!key.trim() && !password)))
              }
            >
              {busy ? (booting ? t("Installing environment…") : t("Joining…")) : t("Join & start")}
            </Button>
          </>
        )
      }
    >
      <div className="stack">
        {!created && (
          <Field label={t("Enrollment")}>
            <div className="host-grid">
              <button
                type="button"
                className={`select-card${transport === "local" ? " selected" : ""}`}
                onClick={() => setTransport("local")}
              >
                <span className="select-head"><b>{t("Local host")}</b><Tag tone="ok">{t("This host")}</Tag></span>
                <small className="footnote">{t("The machine running the admin UI / PCS; runs Docker locally.")}</small>
              </button>
              <button
                type="button"
                className={`select-card${transport === "ssh" ? " selected" : ""}`}
                onClick={() => setTransport("ssh")}
              >
                <span className="select-head"><b>{t("SSH remote host")}</b><Tag>ssh</Tag></span>
                <small className="footnote">{t("Connect with a private key; Docker must be installed and accessible to the current user.")}</small>
              </button>
            </div>
          </Field>
        )}

        {!created && (
          <>
            <Field label={t("Display name")}>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={transport === "local" ? t("Local host") : t("e.g. builder-02")} />
            </Field>

            {transport === "ssh" && (
              <>
                <div className="row">
                  <Field label={t("Address")}>
                    <input className="input" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="192.0.2.10" />
                  </Field>
                  <div className="shrink">
                    <Field label={t("Port")}>
                      <input className="input" type="number" min={1} max={65535} value={port} onChange={(e) => setPort(Number(e.target.value))} />
                    </Field>
                  </div>
                  <div className="shrink">
                    <Field label={t("User")}>
                      <input className="input" value={user} onChange={(e) => setUser(e.target.value)} placeholder="root" />
                    </Field>
                  </div>
                </div>
                <Field label={t("Password")} hint={t("Stored encrypted, never shown. A private key below takes precedence.")}>
                  <input
                    className="input"
                    type="password"
                    autoComplete="new-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={t("SSH password")}
                  />
                </Field>
                <Field
                  label={t("SSH private key")}
                  hint={t("Optional: paste the full private key; blank uses the password above.")}
                >
                  <textarea
                    className="input code-editor"
                    rows={7}
                    value={key}
                    onChange={(e) => setKey(e.target.value)}
                    placeholder={t("Blank uses password login, or paste the full private key\n-----BEGIN OPENSSH PRIVATE KEY-----\n…")}
                    spellCheck={false}
                  />
                </Field>
              </>
            )}

            {error && <Callout tone="bad">{error}</Callout>}
          </>
        )}

        {created && (
          <>
            <Callout tone={booting || boot?.online ? "info" : boot || !probe?.ok ? "warn" : "info"}>
              {booting
                ? authKind === "key" && probe?.ok && probe.docker === false
                  ? t("Joined. Preparing the environment: the remote host lacks Docker and key login has no password, so passwordless sudo is required…")
                  : t("Joined. Installing the environment and starting runtime…")
                : boot
                  ? boot.online
                    ? t("Joined; runtime started and the host is online.")
                    : t("Connected, but the runtime failed to start: {reason}. Click “Start runtime” on the host row to retry.", { reason: boot.error ?? t("Host not online ({status})", { status: boot.status }) })
                  : probe?.ok
                    ? t("Connected: {host}, Docker {docker}.", { host: probe.hostname ?? (address || t("Local host")), docker: probe.docker_version ?? t("Installed") })
                    : t("Host saved, but probing failed: {reason}.", { reason: probeHint(probe?.error) })}
            </Callout>
            {boot?.log && (
              <pre className="payload" style={{ marginTop: 0 }}>{boot.log}</pre>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
