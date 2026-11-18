import { t } from "../i18n";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { deployScheduler, type SchedulerDraft } from "../api";
import { errorMessage } from "../live/client";
import { db } from "../store";
import type { Host, Instance } from "../types";
import { Button, Callout, Field, Modal, Switch } from "./ui";

/** Keep digits only and strip leading zeros ("01" → "1"); keep the empty string so typing can continue. */
function intText(raw: string): string {
  return raw.replace(/[^\d]/g, "").replace(/^0+(?=\d)/, "");
}

/** Convert to a number on submit, fall back to the default when empty, and clamp to the allowed range. */
function intValue(raw: string, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Deploy a scheduler on a host.
 *
 * Each host has at most one root scheduler (the external entry point), and multiple node scheduler containers can hang under it;
 * a node selects only a parent scheduler on the same host, and the parent's address and database are injected by the control plane.
 */
export function DeploySchedulerModal({
  host,
  schedulers,
  initialRole,
  initialParentId,
  onClose,
  onDone,
}: {
  host: Host;
  /** Existing schedulers on this host (root + nodes). */
  schedulers: Instance[];
  initialRole?: "root" | "node";
  initialParentId?: string;
  onClose: () => void;
  onDone: () => Promise<void> | void;
}) {
  const navigate = useNavigate();
  const agents = db.agents.filter((a) => a.enabled !== false && a.role === "scheduler");
  const apis = db.apis.filter((a) => a.enabled !== false);
  /**
   * A scheduler cannot be deployed without an Agent, so the empty state hands the operator to the
   * Config page with the new-Agent dialog already open instead of leaving a dead-end modal.
   *
   * Navigate without closing first: router navigation is a transition, so the close would commit a
   * dashboard re-render (scene measurement) before the new route paints, which reads as a hitch.
   * The dashboard unmounts together with this dialog when the route changes.
   */
  const goCreateAgent = () => {
    navigate("/profiles", { state: { createAgent: true } });
  };
  const root = schedulers.find((s) => (s.scheduler_role ?? "root") === "root");
  const online = host.state === "ONLINE" || host.state === "WARNING";

  const [role, setRole] = useState<"root" | "node">(
    initialRole ?? (root ? "node" : "root"),
  );
  // The parent scheduler is referenced by deployment_id in the control plane, while the id shown in the UI is the instance name; do not mix them.
  const refOf = (s: Instance | undefined) => s?.deployment_id ?? s?.id ?? "";
  // The parent is determined by the entry point (whichever scheduler's "+" was used); without an entry point, it hangs under the root.
  const parent =
    (initialParentId
      ? schedulers.find((s) => refOf(s) === initialParentId)
      : undefined) ??
    root ??
    schedulers[0];
  const [name, setName] = useState(role === "root" ? "root-scheduler" : "node-scheduler");
  const [nameTouched, setNameTouched] = useState(false);
  const [agent, setAgent] = useState("");
  const [api, setApi] = useState("");
  // Numeric inputs are stored as strings so they can be cleared before retyping; convert them on submit.
  // Otherwise the field is written as 0 the moment it is cleared, and the next input becomes "01".
  // Multiple schedulers on one host each take a host port, continuing after the existing instances.
  const [port, setPort] = useState(() => {
    const used = schedulers.map((s) => s.port ?? 0).filter((n) => n > 0);
    return String(Math.max(8443, ...used) + (used.length ? 1 : 0));
  });
  const [sshPort, setSshPort] = useState(() => {
    const used = db.instances.filter((i) => i.host_id === host.id).map((i) => i.ssh_port ?? 0);
    return String(Math.max(2200, ...used) + 1);
  });
  // Capability toggles; both editable later from the scheduler detail page (which recreates the container).
  const [sshEnabled, setSshEnabled] = useState(true);
  const [chatEnabled, setChatEnabled] = useState(true);
  const [cpus, setCpus] = useState("2");
  const [mem, setMem] = useState("2048");
  // Only the root picks a mode; node schedulers and builders inherit it through the control plane.
  const [mode, setMode] = useState<"static" | "dynamic">(root?.scheduling_mode ?? "static");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const selectedAgent =
    agent && agents.some((a) => a.id === agent) ? agent : agents[0]?.id ?? "";
  const agentModel = db.agents.find((a) => a.id === selectedAgent)?.model_api_profile_id;
  const preferredApi =
    apis.find((a) => a.id === agentModel)?.id ?? apis[0]?.id ?? "";
  const selectedApi = api && apis.some((a) => a.id === api) ? api : preferredApi;

  // A host has exactly one role: a bare-metal builder/scheduler cannot also run containers. Check this before the
  // submit button so the operator is not left with a raw HOST_ROLE_CONFLICT from the control plane.
  const roleConflict =
    host.role_mode && host.role_mode !== "containers"
      ? t("This host is currently a {role}, so it cannot run container roles. Switch its role back to container host on the Hosts page first.", {
          role: host.role_mode === "builder" ? t("Bare-metal builder") : t("Bare-metal scheduler"),
        })
      : "";
  const blockedReason = roleConflict
    ? roleConflict
    : !online
      ? t("This host is not online yet")
      : role === "root" && root
        ? t("This host already has root scheduler {root}", { root: root.name })
        : role === "node" && !root
          ? t("Deploy the root scheduler before adding node schedulers")
          : "";
  const blocked = blockedReason !== "";

  function switchRole(next: "root" | "node") {
    setRole(next);
    if (!nameTouched) setName(next === "root" ? "root-scheduler" : "node-scheduler");
    setError("");
  }

  async function submit() {
    if (blocked) {
      setError(blockedReason);
      return;
    }
    if (!selectedAgent) {
      setError(t("No scheduler Agent available"));
      return;
    }
    if (!selectedApi) {
      setError(t("No API available"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      const input: SchedulerDraft = {
        host_id: host.id,
        role,
        ...(role === "node" && parent ? { parent_scheduler_id: refOf(parent) } : {}),
        name: name.trim(),
        agent_profile_id: selectedAgent,
        api_profile_ids: [selectedApi],
        port: intValue(port, 8443, 1, 65535),
        ssh_port: intValue(sshPort, 2201, 1, 65535),
        cpus: intValue(cpus, 2, 1, 16),
        mem_mb: intValue(mem, 2048, 1024, 16384),
        ssh_enabled: sshEnabled,
        chat_enabled: chatEnabled,
        ...(role === "root" ? { scheduling_mode: mode } : {}),
      };
      await deployScheduler(input, async () => {
        await onDone();
      });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      title={t("Deploy scheduler · {host}", { host: host.name })}
      onClose={onClose}
      width={620}
      footer={
        <>
          <Button onClick={onClose}>{t("Cancel")}</Button>
          <Button
            variant="primary"
            onClick={agents.length === 0 ? goCreateAgent : submit}
            disabled={busy || (agents.length > 0 && blocked)}
          >
            {agents.length === 0
              ? t("Create an Agent")
              : busy
                ? t("Deploying…")
                : role === "root"
                  ? t("Deploy root scheduler")
                  : t("Deploy node scheduler")}
          </Button>
        </>
      }
    >
      <div className="stack">
        {roleConflict && <Callout tone="warn">{roleConflict}</Callout>}
        {!roleConflict && !online && (
          <Callout tone="warn">{t("This host is not online; containers cannot be deployed.")}</Callout>
        )}
        {!roleConflict && online && blocked && role === "root" && root && (
          <Callout tone="warn">{t("This host already has a root scheduler; add node schedulers under it.")}</Callout>
        )}
        {!roleConflict && online && role === "node" && !root && (
          <Callout tone="warn">{t("This host has no root scheduler yet. The root is the host entry point and must be deployed first.")}</Callout>
        )}
        {agents.length === 0 ? (
          <Callout tone="warn">
            {t("No scheduler Agent yet. Create an Agent Profile on the Config page, then come back to deploy.")}
          </Callout>
        ) : (
          <>
            <Field label={t("Role")} hint={t("One root per host; add as many nodes as needed under a parent scheduler")}>
              <div className="role-toggle">
                <button
                  type="button"
                  className={`role-option${role === "root" ? " selected" : ""}`}
                  disabled={Boolean(root)}
                  onClick={() => switchRole("root")}
                >
                  <b>{t("Root scheduler")}</b>
                  <small>{root ? t("Already running: {root}", { root: root.name }) : t("Host entry point; receives tasks")}</small>
                </button>
                <button
                  type="button"
                  className={`role-option${role === "node" ? " selected" : ""}`}
                  disabled={!root}
                  onClick={() => switchRole("node")}
                >
                  <b>{t("Node scheduler")}</b>
                  <small>
                    {root
                      ? t("Under {name}", { name: parent?.name ?? root.name })
                      : t("Deploy the root scheduler first")}
                  </small>
                </button>
              </div>
            </Field>

            <Field label={t("Name")}>
              <input
                className="input"
                value={name}
                maxLength={32}
                placeholder={role === "root" ? t("root scheduler / root-scheduler") : t("node scheduler / node-scheduler")}
                onChange={(e) => {
                  setName(e.target.value);
                  setNameTouched(true);
                }}
              />
            </Field>

            <Field
              label={t("Scheduling mode")}
              hint={
                role === "root"
                  ? t("Static allocates from the CPU / memory budget set at deploy time; dynamic uses the host resource pool and grants quotas live based on runtime pressure.")
                  : t("A node scheduler inherits the root scheduler's mode")
              }
            >
              {role === "root" ? (
                <div className="role-toggle">
                  <button
                    type="button"
                    className={`role-option${mode === "static" ? " selected" : ""}`}
                    onClick={() => setMode("static")}
                  >
                    <b>{t("Static")}</b>
                    <small>{t("Fixed budget, overcommit off")}</small>
                  </button>
                  <button
                    type="button"
                    className={`role-option${mode === "dynamic" ? " selected" : ""}`}
                    onClick={() => setMode("dynamic")}
                  >
                    <b>{t("Dynamic")}</b>
                    <small>{t("Resource pool + cgroup quotas, overcommit on")}</small>
                  </button>
                </div>
              ) : (
                <div className="muted">
                  {t("Inherited from the root scheduler: {mode}", { mode: root?.scheduling_mode === "dynamic" ? t("Dynamic") : t("Static") })}
                </div>
              )}
            </Field>

            <Field label="Agent">
              <select className="input" value={selectedAgent} onChange={(e) => setAgent(e.target.value)}>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </Field>

            <Field label="API">
              <select className="input" value={selectedApi} onChange={(e) => setApi(e.target.value)}>
                {apis.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </Field>

            <div className="row">
              <Field label={t("API port")}>
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={65535}
                  step={1}
                  value={port}
                  onChange={(e) => setPort(intText(e.target.value))}
                />
              </Field>
              <Field label={t("SSH port")}>
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={65535}
                  step={1}
                  value={sshPort}
                  disabled={!sshEnabled}
                  onChange={(e) => setSshPort(intText(e.target.value))}
                />
              </Field>
              <Field label="CPU">
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={16}
                  step={1}
                  value={cpus}
                  onChange={(e) => setCpus(intText(e.target.value))}
                />
              </Field>
              <Field label={t("Memory (MiB)")}>
                <input
                  className="input"
                  type="number"
                  min={1024}
                  max={16384}
                  step={1024}
                  value={mem}
                  onChange={(e) => setMem(intText(e.target.value))}
                />
              </Field>
            </div>

            <div className="row">
              <Switch
                checked={sshEnabled}
                onChange={() => setSshEnabled((v) => !v)}
                label={t("Enable SSH (sshd and port mapping)")}
              />
              <Switch
                checked={chatEnabled}
                onChange={() => setChatEnabled((v) => !v)}
                label={t("Enable chat (task.chat.scheduler)")}
              />
            </div>
            <div className="muted">
              {t("With SSH off, sshd is not started and no SSH port is mapped; with chat off, the scheduler no longer accepts chat tasks. Both can be changed later on the detail page, which recreates the container.")}
            </div>
          </>
        )}

        {error && <Callout tone="bad">{error}</Callout>}
      </div>
    </Modal>
  );
}
