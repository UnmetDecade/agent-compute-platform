import { t } from "../i18n";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { db } from "../store";
import { useLive } from "../live/context";
import { errorMessage } from "../live/client";
import { characterState } from "../characters";
import { Character } from "../components/Character";
import { InstanceProfilesModal } from "../components/InstanceProfiles";
import { Badge, Button, Callout, Card, CardTitle, Empty, KeyVal, PageHead, Switch, Tag } from "../components/ui";
import { Icon } from "../components/Icon";
import { builderAction, osLabel, sshCommand, updateDeploymentFeatures } from "../api";

export function BuilderShow() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const live = useLive();
  const builder = db.instances.find((i) => i.id === id && i.role === "builder");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [profilesOpen, setProfilesOpen] = useState(false);

  if (!builder) {
    return (
      <div className="page">
        <Card><Empty text={t("Builder does not exist or was deleted.")} /></Card>
        <p style={{ marginTop: 12 }}><Link className="link" to="/builders">{t("Back to builders")}</Link></p>
      </div>
    );
  }

  const running = db.tasks.find((t) => t.instance_id === builder.id && t.state === "RUNNING");
  const agent = db.agents.find((a) => a.id === builder.agent_profile_id);
  const recent = db.tasks.filter((t) => t.instance_id === builder.id).slice(0, 6);
  const ssh = sshCommand(builder.ssh_host, builder.ssh_port, builder.ssh_user);

  async function act(action: "start" | "stop" | "restart" | "remove") {
    // A bare-metal builder *is* the host's role: deleting it returns the host to a container host,
    // so the confirmation must not promise a container and its volumes that never existed.
    if (
      action === "remove" &&
      !window.confirm(
        builder!.execution === "native"
          ? t("Delete {name}? The host will return to a regular host.", { name: builder!.name })
          : t("Delete {name}? The container and its volumes will be deleted.", { name: builder!.name }),
      )
    )
      return;
    setBusy(action);
    setError("");
    try {
      await builderAction(builder!.id, action, live.refresh, builder!.host_id);
      if (action === "remove") navigate("/builders");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy("");
    }
  }

  async function copySsh() {
    try {
      await navigator.clipboard.writeText(ssh);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setError(t("Clipboard unavailable; please copy manually"));
    }
  }

  /** Toggling a capability recreates the container with the next generation; volumes survive. */
  async function toggleFeature(key: "ssh_enabled" | "chat_enabled", next: boolean) {
    setBusy(key);
    setError("");
    try {
      const features = key === "ssh_enabled" ? { ssh_enabled: next } : { chat_enabled: next };
      await updateDeploymentFeatures(builder!.id, features, live.refresh);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="page page-sched">
      <Link className="back" to="/builders"><Icon name="back" size={13} />{t("Builders")}</Link>
      <PageHead
        title={
          <>
            <Character role="builder" state={characterState(builder, running)} size={46} flat />
            {builder.name}
            <Badge value={builder.state} />
          </>
        }
        meta={
          <>
            <span>{osLabel(builder.os)}</span>
            <span className="sep" />
            <span>{builder.cpu_limit}C / {Math.round(builder.mem_limit_mb / 1024)} GiB / {builder.disk_gb}G</span>
            <span className="sep" />
            <span>{t("Config v{version}", { version: builder.config_version })}</span>
          </>
        }
        actions={
          <>
            {builder.ssh_enabled !== false && (
              <Link className="btn" to={`/terminal?instance=${encodeURIComponent(builder.key)}`}>
                <Icon name="terminal" size={14} />
                {t("Terminal")}
              </Link>
            )}
            {builder.chat_enabled !== false && (
              <Link className="btn" to={`/chat?instance=${encodeURIComponent(builder.key)}`}>
                <Icon name="chat" size={14} />
                {t("Chat")}
              </Link>
            )}
            <Link className="btn" to={`/builders/${builder.id}/files`}>
              <Icon name="folder" size={14} />
              {t("File")}
            </Link>
            <Button onClick={() => setProfilesOpen(true)}>
              <Icon name="agent" size={14} />
              {t("Configure Agent")}
            </Button>
            <Button onClick={() => act("restart")} disabled={busy === "restart"}>
              <Icon name="refresh" size={14} />
              {t("Restart")}
            </Button>
            <Button onClick={() => act(builder.state === "ONLINE" ? "stop" : "start")} disabled={busy === "stop" || busy === "start"}>
              <Icon name="stop" size={13} />
              {builder.state === "ONLINE" ? t("Stop") : t("Start")}
            </Button>
            <Button variant="danger" onClick={() => act("remove")} disabled={busy === "remove"}>
              <Icon name="trash" size={13} />
              {t("Delete")}
            </Button>
          </>
        }
      />

      {error && <Callout tone="bad">{error}</Callout>}

      {/* Same fixed-height layout as the scheduler page: runtime info and capability switches
          share the left card, the Agent/SSH card fills the right, and the bottom row takes the
          remaining height so the page itself never scrolls. */}
      <div className="sched-top">
        <Card>
          <CardTitle extra={<Tag tone="warn">{t("Changing rebuilds the container")}</Tag>}>{t("Runtime info")}</CardTitle>
          <div className="kv-list">
            <KeyVal label={t("Instance ID")}>{builder.id}</KeyVal>
            <KeyVal label={t("Base OS")}>{osLabel(builder.os)}</KeyVal>
            <KeyVal label={t("Image")}><code className="digest">{builder.image}</code></KeyVal>
            <KeyVal label={t("Resources")}>
              {builder.cpu_limit}C / {Math.round(builder.mem_limit_mb / 1024)} GiB / {builder.disk_gb}G
            </KeyVal>
            <KeyVal label={t("Working directory")}>
              <Link className="link" to={`/builders/${builder.id}/files`}>
                <code>{builder.workspace ?? "/opt/platform/workspace"}</code>
              </Link>
            </KeyVal>
            <KeyVal label={t("Last heartbeat")}>{new Date(builder.last_heartbeat).toLocaleString()}</KeyVal>
            <KeyVal label={t("Created")}>{new Date(builder.created_at).toLocaleString()}</KeyVal>
          </div>
          <div className="stack" style={{ marginTop: 12 }}>
            {builder.execution !== "native" && (
              <Switch
                checked={builder.ssh_enabled !== false}
                disabled={busy !== ""}
                onChange={() => void toggleFeature("ssh_enabled", builder.ssh_enabled === false)}
                label={t("SSH access (sshd and port mapping)")}
              />
            )}
            <Switch
              checked={builder.chat_enabled !== false}
              disabled={busy !== ""}
              onChange={() => void toggleFeature("chat_enabled", builder.chat_enabled === false)}
              label={t("Chat (task.chat.builder)")}
            />
            <div className="muted">
              {t("The control plane recreates this container after the change; workspace volumes survive and any running task is interrupted.")}
            </div>
          </div>
        </Card>

        <Card>
          <CardTitle
            extra={
              builder.execution !== "native" &&
              builder.ssh_enabled !== false && (
                <Button size="sm" onClick={copySsh}>
                  <Icon name={copied ? "check" : "copy"} size={13} />
                  {copied ? t("Copied") : t("Copy")}
                </Button>
              )
            }
          >
            {t("Builder agent and SSH")}
          </CardTitle>
          <div className="kv-list">
            <KeyVal label="Agent">{agent ? `${agent.name} · v${agent.version}` : t("Unbound")}</KeyVal>
            <KeyVal label={t("Adapter")}><code>{agent?.adapter ?? "-"}</code></KeyVal>
            <KeyVal label="API">
              {builder.api_profile_ids
                .map((id) => db.apis.find((a) => a.id === id)?.name ?? id)
                .join(" · ") || "-"}
            </KeyVal>
          </div>
          {builder.execution === "native" ? (
            <Callout tone="info">
              {t("A bare-metal builder runs directly on the host and has no SSH port of its own; the terminal enters the same shell through the host runtime.")}
            </Callout>
          ) : builder.ssh_enabled === false ? (
            <Callout tone="warn">{t("SSH is disabled in this deployment: no sshd runs in the container and no port is mapped. Enable it under Runtime info on the left; the container is recreated.")}</Callout>
          ) : (
            <>
              <pre className="code-block ssh-block" style={{ marginTop: 10 }}>{ssh}</pre>
              <div className="kv-list" style={{ marginTop: 10 }}>
                <KeyVal label={t("Host")}>{builder.ssh_host ?? "-"}</KeyVal>
                <KeyVal label={t("Port")}>{builder.ssh_port ?? "-"}</KeyVal>
                <KeyVal label={t("User")}>root</KeyVal>
                <KeyVal label={t("Auth")}>{builder.state === "OFFLINE" ? t("Container not running") : t("Key / password (issued by platform)")}</KeyVal>
              </div>
            </>
          )}
          {/* Load lives in this card so the top row has no empty column; the bottom row is
              reserved for the recent-task list and takes the remaining viewport height. */}
          <div className="muted small" style={{ margin: "14px 0 6px" }}>{t("Load")}</div>
          <div className="metric-row"><span>CPU</span><div className="meter"><div className="meter-fill meter-ok" style={{ width: `${running ? 62 : 7}%` }} /></div><em>{running ? "62%" : "7%"}</em></div>
          <div className="metric-row"><span>{t("Memory")}</span><div className="meter"><div className="meter-fill meter-ok" style={{ width: `${running ? 48 : 21}%` }} /></div><em>{running ? "48%" : "21%"}</em></div>
          <div className="metric-row"><span>{t("Disk")}</span><div className="meter"><div className="meter-fill meter-ok" style={{ width: "30%" }} /></div><em>30%</em></div>
          <div className="instance-now" style={{ marginTop: 10 }}>
            {running ? <><span className="dot dot-ok" />{running.title}</> : <span className="muted">{t("Idle")}</span>}
          </div>
        </Card>
      </div>

      <div className="sched-split sched-single" style={{ marginTop: 12 }}>
        <Card>
          <CardTitle extra={<Link className="link" to="/tasks">{t("All tasks")}</Link>}>{t("Recent tasks")}</CardTitle>
          <div className="rail-list">
            {recent.map((task) => (
              <Link className="rail-row" key={task.id} to={`/tasks/${task.id}`}>
                <div>
                  <b>{task.title}</b>
                  <small>{task.type} · {new Date(task.created_at).toLocaleString()}</small>
                </div>
                <Badge value={task.state} />
              </Link>
            ))}
            {recent.length === 0 && <div className="rail-empty">{t("No tasks yet")}</div>}
          </div>
        </Card>
      </div>

      {profilesOpen && (
        <InstanceProfilesModal
          instance={builder}
          role="builder"
          onClose={() => setProfilesOpen(false)}
        />
      )}
    </div>
  );
}
