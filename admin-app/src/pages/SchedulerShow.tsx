import { t } from "../i18n";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { db } from "../store";
import { useHostScope } from "../host-context";
import { tasksForHost } from "../host-tasks";
import { useLive } from "../live/context";
import { errorMessage } from "../live/client";
import { Character } from "../components/Character";
import { InstanceProfilesModal } from "../components/InstanceProfiles";
import { Badge, Button, Callout, Card, CardTitle, Empty, KeyVal, PageHead, Switch, Tag } from "../components/ui";
import { Icon } from "../components/Icon";
import { builderAction, sshCommand, updateDeploymentFeatures } from "../api";
import type { Instance } from "../types";

/** Single scheduler details: queue, running tasks, bound Agents and configuration. */
export function SchedulerShow() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const live = useLive();
  const { host: scopeHost } = useHostScope();
  const scheduler = db.instances.find((i) => i.id === id && i.role === "scheduler");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [profilesOpen, setProfilesOpen] = useState(false);

  if (!scheduler) {
    return (
      <div className="page">
        <Card><Empty text={t("Scheduler does not exist or was deleted.")} /></Card>
        <p style={{ marginTop: 12 }}><Link className="link" to="/scheduler">{t("Back to schedulers")}</Link></p>
      </div>
    );
  }

  const s = scheduler;
  const host = db.hosts.find((h) => h.id === s.host_id);
  const internalRole = s.scheduler_role ?? "root";
  // From the current host's view: a folded host's root is not this host's root, but a node under the parent host's root.
  const merged = internalRole === "root" && scopeHost?.id !== s.host_id;
  const externalRole = internalRole === "node" || merged ? "node" : "root";
  // Resolve parent references by instance name first: a scheduler restart changes the deployment_id, but the instance name stays.
  const parent = s.parent_scheduler_id
    ? db.instances.find(
        (i) =>
          i.role === "scheduler" &&
          (s.parent_scheduler_instance_id
            ? i.id === s.parent_scheduler_instance_id
            : (i.deployment_id ?? i.id) === s.parent_scheduler_id),
      )
    : merged && host?.parent_host_id
      ? db.instances.find(
          (i) =>
            i.role === "scheduler" &&
            i.host_id === host.parent_host_id &&
            (i.scheduler_role ?? "root") === "root",
        )
      : undefined;
  const parentHost = merged && host?.parent_host_id
    ? db.hosts.find((h) => h.id === host.parent_host_id)
    : undefined;
  // All schedulers on the same host, used to show the parent scheduler's name and port.
  const hostSchedulers = db.instances.filter((i) => i.role === "scheduler" && i.host_id === s.host_id);
  const hostRoot = hostSchedulers.find(
    (i) => (i.scheduler_role ?? "root") === "root",
  );
  // Attribute by instance name; legacy data without scheduler_instance_id falls back to the local root scheduler.
  const owned = db.instances.filter(
    (b) =>
      b.role === "builder" &&
      b.host_id === s.host_id &&
      (b.scheduler_instance_id ?? hostRoot?.id) === s.id,
  );
  const ownedIds = new Set(owned.map((b) => b.id));
  // Tasks without an assigned builder land on the host entry point, i.e. the local root scheduler.
  const tasks = host
    ? tasksForHost(host).filter((t) =>
        t.instance_id ? ownedIds.has(t.instance_id) : internalRole === "root",
      )
    : [];
  const stats = {
    queued: tasks.filter((t) => t.state === "QUEUED").length,
    running: tasks.filter((t) => t.state === "RUNNING").length,
    succeeded: tasks.filter((t) => t.state === "SUCCEEDED").length,
    failed: tasks.filter((t) => t.state === "FAILED").length,
  };
  const queued = tasks
    .filter((t) => t.state === "QUEUED")
    .sort((a, b) => a.priority - b.priority || a.created_at.localeCompare(b.created_at));
  const running = tasks.filter((t) => t.state === "RUNNING");
  const agent = db.agents.find((a) => a.id === s.agent_profile_id);
  const agentModel =
    db.apis.find((a) => a.id === agent?.model_api_profile_id) ??
    db.apis.find((a) => a.kind === "llm" && (s.api_profile_ids ?? []).includes(a.id));
  const w = owned
    .filter((b) => b.state === "ONLINE")
    .reduce((sum, b) => sum + (b.capability_score ?? 0), 0);
  const offline = s.state !== "ONLINE";

  async function act(action: "start" | "stop" | "restart" | "remove") {
    if (action === "remove" && !window.confirm(t("Delete {name}? The container and its volumes will be deleted.", { name: s.name }))) return;
    setBusy(action);
    setError("");
    try {
      await builderAction(s.id, action, live.refresh, s.host_id);
      if (action === "remove") navigate("/scheduler");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy("");
    }
  }

  function builderOfTask(t: { instance_id?: string }): Instance | undefined {
    return db.instances.find((i) => i.key === t.instance_id || i.id === t.instance_id);
  }

  /** Toggling a capability recreates the container with the next generation; volumes survive. */
  async function toggleFeature(key: "ssh_enabled" | "chat_enabled", next: boolean) {
    setBusy(key);
    setError("");
    try {
      const features = key === "ssh_enabled" ? { ssh_enabled: next } : { chat_enabled: next };
      await updateDeploymentFeatures(s.id, features, live.refresh);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="page page-sched">
      <Link className="back" to="/scheduler"><Icon name="back" size={13} />{t("Schedulers")}</Link>
      <PageHead
        title={
          <>
            <Character role="scheduler" state={offline ? "offline" : stats.queued ? "working" : "idle"} size={46} flat />
            {s.name}
            <Badge value={s.state} />
            <Tag tone={externalRole === "root" ? "ok" : "accent"}>
              {externalRole === "root" ? t("Root") : t("Node")}
            </Tag>
          </>
        }
        meta={
          <>
            <span>{host?.name ?? s.host_id}</span>
            <span className="sep" />
            <span>{s.cpu_limit}C / {Math.round(s.mem_limit_mb / 1024)} GiB</span>
            <span className="sep" />
            <span>{t("{count} builders · ΣW {w}", { count: owned.length, w })}</span>
            <span className="sep" />
            <span>{t("Config v{version}", { version: s.config_version })}</span>
          </>
        }
        actions={
          <>
            {s.ssh_enabled !== false && (
              <Link className="btn" to={`/terminal?instance=${encodeURIComponent(s.key)}`}>
                <Icon name="terminal" size={14} />
                {t("Terminal")}
              </Link>
            )}
            {s.chat_enabled !== false && (
              <Link className="btn" to={`/chat?instance=${encodeURIComponent(s.key)}`}>
                <Icon name="chat" size={14} />
                {t("Ask Relay")}
              </Link>
            )}
            <Button onClick={() => setProfilesOpen(true)}>
              <Icon name="agent" size={14} />
              {t("Configure Agent")}
            </Button>
            <Button onClick={() => act("restart")} disabled={busy !== ""}>
              <Icon name="refresh" size={13} />
              {t("Restart")}
            </Button>
            <Button onClick={() => act(offline ? "start" : "stop")} disabled={busy !== ""}>
              <Icon name={offline ? "play" : "stop"} size={13} />
              {offline ? t("Start") : t("Stop")}
            </Button>
            <Button variant="danger" onClick={() => act("remove")} disabled={busy !== ""}>
              <Icon name="trash" size={13} />
              {t("Delete")}
            </Button>
          </>
        }
      />

      {error && <Callout tone="bad">{error}</Callout>}

      {/* Two blocks side by side at the top: overview on the left, scheduling Agent config on the right. The page has a fixed height;
          when space runs out the cards scroll themselves and the page does not. */}
      <div className="sched-top">
        <Card>
          <CardTitle>{t("Runtime info")}</CardTitle>
          <div className="kv-list">
            <KeyVal label={t("Status")}><Badge value={s.state} /></KeyVal>
            <KeyVal label={t("Host")}>{host?.name ?? s.host_id}</KeyVal>
            <KeyVal label={t("Queued")}>{stats.queued}</KeyVal>
            <KeyVal label={t("Running")}>{stats.running}</KeyVal>
            <KeyVal label={t("Succeeded today")}>{stats.succeeded}</KeyVal>
            <KeyVal label={t("Failed")}>
              <span className={stats.failed ? "text-bad" : undefined}>{stats.failed}</span>
            </KeyVal>
            <KeyVal label={t("Builders")}>{t("{count} builders · ΣW {w}", { count: owned.length, w })}</KeyVal>
            <KeyVal label="SSH">
              {s.ssh_enabled === false
                ? t("Disabled at deploy time")
                : s.ssh_port
                  ? sshCommand(s.ssh_host, s.ssh_port, s.ssh_user)
                  : "-"}
            </KeyVal>
            <KeyVal label={t("Image")}><code className="digest">{s.image}</code></KeyVal>
          </div>
          <div className="stack" style={{ marginTop: 12 }}>
            <Switch
              checked={s.ssh_enabled !== false}
              disabled={busy !== ""}
              onChange={() => void toggleFeature("ssh_enabled", s.ssh_enabled === false)}
              label={t("SSH access (sshd and port mapping)")}
            />
            <Switch
              checked={s.chat_enabled !== false}
              disabled={busy !== ""}
              onChange={() => void toggleFeature("chat_enabled", s.chat_enabled === false)}
              label={t("Chat (task.chat.scheduler)")}
            />
            <div className="muted">
              {t("The control plane recreates this container after the change; workspace volumes survive and any running task is interrupted.")}
            </div>
          </div>
        </Card>

        <Card>
          <CardTitle>{t("Scheduler Agent")}</CardTitle>
          <div className="kv-list">
            <KeyVal label={t("Instance ID")}>{s.id}</KeyVal>
            <KeyVal label={t("Role")}>
              {externalRole === "node"
                ? merged
                  ? t("Node scheduler (merged into {host})", { host: parentHost?.name ?? t("Parent host") })
                  : t("Node scheduler")
                : t("Root scheduler")}
            </KeyVal>
            <KeyVal label={t("Parent scheduler")}>
              {externalRole === "node" ? parent?.name ?? "-" : "—"}
            </KeyVal>
            <KeyVal label={t("API port")}>{s.port ? `:${s.port}` : "-"}</KeyVal>
            <KeyVal label="Agent">{agent ? `${agent.name} · v${agent.version}` : t("Unbound")}</KeyVal>
            <KeyVal label={t("Adapter")}><code>{agent?.adapter ?? "-"}</code></KeyVal>
            <KeyVal label={t("Model")}>{agentModel ? `${agentModel.name} · ${agentModel.base_url}` : t("No model")}</KeyVal>
            <KeyVal label="API">
              {(s.api_profile_ids ?? [])
                .map((pid) => db.apis.find((a) => a.id === pid)?.name ?? pid)
                .join(" · ") || "-"}
            </KeyVal>
            <KeyVal label={t("Capabilities")}>
              <div className="chips">
                {(agent?.capabilities ?? []).map((c) => <Tag key={c}>{c}</Tag>)}
              </div>
            </KeyVal>
          </div>
        </Card>
      </div>

      <div className="grid-2 sched-split" style={{ marginTop: 16 }}>
        <Card>
          <CardTitle extra={<Link className="link" to="/tasks">{t("All tasks")}</Link>}>
            {t("Dispatch queue")}
          </CardTitle>
          <div className="rail-list">
            {queued.map((task, i) => (
              <Link className="rail-row" key={task.id} to={`/tasks/${task.id}`}>
                <span className="queue-index">{i + 1}</span>
                <div>
                  <b>{task.title}</b>
                  <small>P{task.priority} · {task.type} · {t("waiting {min} min", { min: Math.max(1, Math.round((Date.now() - new Date(task.created_at).getTime()) / 60000)) })}</small>
                </div>
                <Badge value={task.state} />
              </Link>
            ))}
            {queued.length === 0 && <Empty text={t("Queue is empty; the scheduler is waiting.")} />}
          </div>
        </Card>

        <Card>
          <CardTitle>{t("Running")}</CardTitle>
          <div className="rail-list">
            {running.map((task) => {
              const inst = builderOfTask(task);
              return (
                <Link className="rail-row" key={task.id} to={`/tasks/${task.id}`}>
                  <div>
                    <b>{task.title}</b>
                    <small>{inst?.name ?? task.instance_id ?? "-"} · {task.type}</small>
                  </div>
                  <Badge value={task.state} />
                </Link>
              );
            })}
            {running.length === 0 && <Empty text={t("No running tasks.")} />}
          </div>
        </Card>
      </div>

      {profilesOpen && (
        <InstanceProfilesModal
          instance={s}
          role="scheduler"
          onClose={() => setProfilesOpen(false)}
        />
      )}
    </div>
  );
}
