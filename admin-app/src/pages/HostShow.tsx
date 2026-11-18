import { t } from "../i18n";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { db } from "../store";
import { useHostScope } from "../host-context";
import { useLive } from "../live/context";
import { ApiError, errorMessage } from "../live/client";
import { bootstrapHost, probeHost, unmergeHost } from "../api";
import { Badge, Button, Callout, Card, CardTitle, Empty, KeyVal, PageHead, Tag } from "../components/ui";
import { Icon } from "../components/Icon";
import { DeleteHostModal, HostSettingsModal, MergeHostModal, probeHint } from "./Hosts";

/**
 * Host detail: everything that acts on a machine lives here (settings, probe, bootstrap, federation,
 * deletion), so the host list stays a readable summary instead of a wall of buttons.
 */
export function HostShow() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const live = useLive();
  const { host: current, setHostId } = useHostScope();
  const host = db.hosts.find((h) => h.id === id);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<{ tone: "info" | "warn" | "bad"; text: string; log?: string } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  if (!host) {
    return (
      <div className="page">
        <Card><Empty text={t("Host does not exist or was deleted.")} /></Card>
        <p style={{ marginTop: 12 }}><Link className="link" to="/hosts">{t("Back to hosts")}</Link></p>
      </div>
    );
  }

  const components = db.instances.filter((i) => i.host_id === host.id);
  const parent = host.parent_host_id ? db.hosts.find((h) => h.id === host.parent_host_id) : undefined;
  const children = db.hosts.filter((h) => h.parent_host_id === host.id);
  const subtreeScore = host.subtree_score ?? 0;
  const roleMode = host.role_mode ?? "containers";
  const probe = host.last_probe;
  const probeOk = probe?.ok === true;
  const address = host.address || host.name;
  const isCurrent = current?.id === host.id;
  const canManage = host.transport === "local" || host.transport === "ssh";

  async function probeNow() {
    setBusy("probe");
    setError("");
    try {
      await probeHost(host!.id, live.refresh);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy("");
    }
  }

  async function bootstrap() {
    setBusy("bootstrap");
    setError("");
    setNotice(null);
    try {
      const out = await bootstrapHost(host!.id, live.refresh);
      setNotice(
        out.online
          ? { tone: "info", text: t("host-runtime started; the host is online and components can be deployed.") }
          : {
              tone: "warn",
              text: t("host-runtime started, but the host is not online yet ({status}). Check the log below.", { status: out.status }),
              log: out.log,
            },
      );
    } catch (e) {
      setNotice({
        tone: "bad",
        text:
          e instanceof ApiError && e.code === "DEMO_MODE"
            ? t("Demo mode does not support adding hosts")
            : errorMessage(e),
      });
    } finally {
      setBusy("");
    }
  }

  async function unmerge() {
    if (!parent) return;
    if (!window.confirm(t("Unlink {host} from {parent}? {host} becomes the root of its own federation tree again and stops reporting capacity upward. No containers restart.", { host: host!.name, parent: parent.name }))) return;
    setBusy("unmerge");
    setError("");
    try {
      await unmergeHost(host!.id, live.refresh);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="page page-host">
      <Link className="back" to="/hosts"><Icon name="back" size={13} />{t("Host")}</Link>
      <PageHead
        title={
          <>
            {host.name}
            <Badge value={host.state} />
            {isCurrent && <Tag tone="accent">{t("Current")}</Tag>}
          </>
        }
        meta={
          <>
            <span>{host.os} {host.arch}</span>
            <span className="sep" />
            <span>{t("Runtime {version}", { version: host.runtime_version })}</span>
            <span className="sep" />
            <span>{host.cpu_total}C / {Math.round(host.mem_total_mb / 1024)} GiB</span>
          </>
        }
        actions={
          <>
            {!isCurrent && (
              <Button onClick={() => setHostId(host.id)}>
                <Icon name="check" size={14} />
                {t("Set as current host")}
              </Button>
            )}
            {canManage && (
              <>
                <Button onClick={() => setSettingsOpen(true)}>
                  <Icon name="settings" size={14} />
                  {t("Settings")}
                </Button>
                <Button onClick={probeNow} disabled={busy === "probe"}>
                  <Icon name="refresh" size={14} />
                  {busy === "probe" ? t("Probing…") : t("Probe")}
                </Button>
                <Button onClick={bootstrap} disabled={busy === "bootstrap"}>
                  <Icon name="play" size={14} />
                  {busy === "bootstrap"
                    ? t("Preparing environment…")
                    : host.state === "ONLINE"
                      ? t("Re-bootstrap")
                      : t("Start runtime")}
                </Button>
              </>
            )}
            {/* A folded host keeps only "Unfold"; to change parents, unfold and fold it again. */}
            {parent ? (
              <Button onClick={unmerge} disabled={busy === "unmerge"}>
                <Icon name="unlink" size={14} />
                {t("Detach from parent")}
              </Button>
            ) : (
              <Button onClick={() => setMergeOpen(true)}>
                <Icon name="layers" size={14} />
                {t("Merge")}
              </Button>
            )}
            <Button variant="danger" onClick={() => setDeleteOpen(true)}>
              <Icon name="trash" size={13} />
              {t("Delete")}
            </Button>
          </>
        }
      />

      {error && <Callout tone="bad">{error}</Callout>}
      {notice && (
        <Callout tone={notice.tone}>
          {notice.text}
          {notice.log && <pre className="payload" style={{ marginTop: 10, marginBottom: 0 }}>{notice.log}</pre>}
        </Callout>
      )}

      {/*
        This page fits the viewport instead of scrolling: reachability, identity and capacity stack in
        the left column, while the federation tree and the component list share the right one, where
        the list takes every pixel left over. Only card interiors scroll, and only when the window is
        too short for their content.
      */}
      <div className="host-detail-grid">
        <div className="host-cell">
          {/* The access card is a status strip: its values are short, and stacking them as rows cost the
              component list the height it now owns. */}
          {host.transport === "ssh" ? (
            <Card>
              <CardTitle>{t("SSH access")}</CardTitle>
              <pre className="code-block ssh-block">
                {`ssh -p ${host.ssh_port ?? 22} ${host.ssh_user ?? "root"}@${address}`}
              </pre>
              <div className="host-strip">
                <span><em>{t("Auth")}</em>{host.auth_type === "key" ? t("Private key") : host.auth_type === "password" ? t("Password") : "-"}</span>
                <span className="sep" />
                <span><em>{t("Fingerprint")}</em><code>{host.key_fingerprint ?? "-"}</code></span>
              </div>
            </Card>
          ) : (
            <Card>
              <CardTitle>{t("Probe results")}</CardTitle>
              <div className="host-strip">
                {probe ? (
                  <Tag tone={probeOk ? "ok" : "bad"}>{probeOk ? t("Reachable") : t("Unreachable")}</Tag>
                ) : (
                  <span className="muted">{t("Not probed yet")}</span>
                )}
                <span className="sep" />
                <span>{probe ? (probe.docker_version ?? (probe.docker ? t("Installed") : t("Not installed"))) : "-"}</span>
                <span className="sep" />
                <span className="muted">{probe ? new Date(probe.checked_at).toLocaleString() : "-"}</span>
              </div>
              {probe && !probeOk && (
                <div className="inline-note text-bad">{t("Failure reason")}: {probeHint(probe.error)}</div>
              )}
            </Card>
          )}

          <Card>
            <CardTitle>{t("Host info")}</CardTitle>
            <div className="kv-list">
              <KeyVal label={t("Host ID")}>{host.id}</KeyVal>
              <KeyVal label={t("Base OS")}>{host.os} · {host.arch}</KeyVal>
              <KeyVal label={t("Runtime")}>{host.runtime_version}</KeyVal>
              <KeyVal label="Docker">
                {(host.last_probe?.docker_version ?? "-").replace(/^Docker version\s+/i, "")}
              </KeyVal>
              <KeyVal label={t("Host role")}>
                {roleMode === "containers"
                  ? t("Container host")
                  : roleMode === "builder"
                    ? t("Bare-metal builder")
                    : t("Bare-metal scheduler")}
              </KeyVal>
              <KeyVal label={t("Enrollment")}>
                {host.transport === "local" ? t("Local") : host.transport === "ssh" ? "SSH" : t("Manual")}
              </KeyVal>
              <KeyVal label={t("Registered")}>{new Date(host.registered_at).toLocaleString()}</KeyVal>
              <KeyVal label={t("Last reported")}>
                {host.last_report_at ? new Date(host.last_report_at).toLocaleString() : "-"}
              </KeyVal>
            </div>
          </Card>

          <Card>
            <CardTitle>{t("Resources")}</CardTitle>
            <div className="metric-row"><span>CPU</span><div className="meter"><div className="meter-fill meter-ok" style={{ width: `${host.cpu}%` }} /></div><em>{host.cpu}%</em></div>
            <div className="metric-row"><span>{t("Memory")}</span><div className="meter"><div className="meter-fill meter-ok" style={{ width: `${host.mem}%` }} /></div><em>{host.mem}%</em></div>
            <div className="metric-row"><span>{t("Disk")}</span><div className="meter"><div className="meter-fill meter-ok" style={{ width: `${host.disk}%` }} /></div><em>{host.disk}%</em></div>
            <div className="kv-list" style={{ marginTop: 12 }}>
              <KeyVal label={t("CPU")}>{host.cpu_total}C</KeyVal>
              <KeyVal label={t("Total memory")}>{Math.round(host.mem_total_mb / 1024)} GiB</KeyVal>
              <KeyVal label={t("Available memory")}>{Math.round(host.mem_available_mb / 1024)} GiB</KeyVal>
            </div>
          </Card>
        </div>

        <div className="host-cell host-cell-list">
          <Card>
            <CardTitle>{t("Federation tree")}</CardTitle>
            <div className="kv-list">
              <KeyVal label={t("Parent host")}>{parent ? parent.name : t("None (this host is the root)")}</KeyVal>
              <KeyVal label={t("Child hosts")}>
                {children.length === 0 ? "-" : children.map((c) => c.name).join(" · ")}
              </KeyVal>
              <KeyVal label={t("Local ΣW")}>{host.local_score ?? 0}</KeyVal>
              <KeyVal label={t("Local + child ΣW")}>{subtreeScore}</KeyVal>
            </div>
          </Card>

          <Card>
            <CardTitle extra={<Link className="link" to="/builders">{t("View builders")}</Link>}>
              {t("Components")} · {components.length}
            </CardTitle>
            {components.length === 0 ? (
              <Empty text={t("No components on this host yet.")} />
            ) : (
              <div className="rail-list">
                {components.map((c) => (
                  <Link
                    className="rail-row"
                    key={c.id}
                    to={c.role === "scheduler" ? `/scheduler/${c.id}` : `/builders/${c.id}`}
                  >
                    <div>
                      <b>{c.name}</b>
                      <small>{c.role === "scheduler" ? t("Schedulers") : t("Builders")} · {c.state}</small>
                    </div>
                    <Badge value={c.state} />
                  </Link>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>

      <HostSettingsModal
        host={settingsOpen ? host : null}
        onClose={() => setSettingsOpen(false)}
        onDone={async () => {
          if (live.connected) await live.refresh();
        }}
      />
      <MergeHostModal
        host={mergeOpen ? host : null}
        onClose={() => setMergeOpen(false)}
        onDone={async () => {
          if (live.connected) await live.refresh();
          setMergeOpen(false);
        }}
      />
      <DeleteHostModal
        host={deleteOpen ? host : null}
        onClose={() => setDeleteOpen(false)}
        onDone={async () => {
          if (live.connected) await live.refresh();
        }}
        onDeleted={() => navigate("/hosts")}
      />
    </div>
  );
}
