import { t } from "../i18n";
import { useEffect, useState } from "react";
import { db } from "../store";
import { errorMessage } from "../live/client";
import { BUILDER_OS, type BuilderOs, type Instance } from "../types";
import { createBuilder, type BuilderDraft } from "../api";
import { Button, Callout, Field, Modal, Switch, Tag } from "./ui";
import { Icon } from "./Icon";

// Tier copy is translated at render time; module-level constants are evaluated once, so t() must not be called here.
const PRESETS = [
  { id: "small", label: "Light", cpus: 1, mem: 2048, disk: 16, note: "Small scripts / chat" },
  { id: "medium", label: "Standard", cpus: 2, mem: 4096, disk: 32, note: "Daily builds" },
  { id: "large", label: "Heavy", cpus: 4, mem: 8192, disk: 64, note: "Kernel / large projects" },
];

/**
 * Create builder: opened only from the AI Agent studio.
 * A builder must hang under a scheduler on the target host, by default the root scheduler.
 */
export function CreateBuilderModal({
  open,
  defaultHostId,
  defaultSchedulerId,
  onClose,
  onCreated,
}: {
  open: boolean;
  defaultHostId?: string;
  /** When opened from a node scheduler's "+", hang under it by default. */
  defaultSchedulerId?: string;
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  const builderAgents = db.agents.filter((a) => a.enabled !== false && a.role === "builder");
  const deployableHosts = db.hosts.filter((h) => h.state === "ONLINE" || h.state === "WARNING");
  const [hostId, setHostId] = useState(defaultHostId ?? "");
  const [os, setOs] = useState<BuilderOs>("ubuntu22.04");
  const [preset, setPreset] = useState("medium");
  const [customCpus, setCustomCpus] = useState(2);
  const [customMem, setCustomMem] = useState(4096);
  const [customDisk, setCustomDisk] = useState(32);
  const [count, setCount] = useState(1);
  const [name, setName] = useState("");
  const [agent, setAgent] = useState(builderAgents[0]?.id ?? "");
  const [apis, setApis] = useState<string[]>([]);
  // Capability toggles; editable afterwards from the builder detail page (container is recreated).
  const [sshEnabled, setSshEnabled] = useState(true);
  const [chatEnabled, setChatEnabled] = useState(true);
  // Prefer the Agent's model API over an arbitrary first Profile: a model bound through an API
  // Profile must be selected here or the control plane refuses the deployment.
  const agentModel = db.agents.find((a) => a.id === agent)?.model_api_profile_id;
  const selectedApi =
    apis[0] && db.apis.some((a) => a.id === apis[0])
      ? apis[0]
      : (db.apis.find((a) => a.id === agentModel)?.id ?? db.apis[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (open) {
      setError("");
      if (!db.agents.find((a) => a.id === agent && a.role === "builder")) {
        setAgent(db.agents.find((a) => a.role === "builder" && a.enabled !== false)?.id ?? "");
      }
      // The dialog is pinned to the current host in the workspace; users can no longer switch hosts here.
      if (defaultHostId) {
        setHostId(defaultHostId);
      } else if (!deployableHosts.some((h) => h.id === hostId)) {
        setHostId(deployableHosts[0]?.id ?? "");
      }
    }
    // deployableHosts is rebuilt on every sync; depend on the host id list to avoid repeatedly resetting when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, agent, defaultHostId, deployableHosts.map((h) => h.id).join(",")]);

  const targetHost = db.hosts.find((h) => h.id === hostId);
  const hostOnline = targetHost?.state === "ONLINE" || targetHost?.state === "WARNING";
  const availMb = targetHost?.mem_available_mb ?? 0;
  // The control plane admits based on available memory; when the dialog opens, fall back to the largest tier that fits so errors do not surface only after submit.
  useEffect(() => {
    if (!open || availMb <= 0) return;
    const fits = [...PRESETS].reverse().find((x) => x.mem * count <= availMb);
    if (fits) setPreset(fits.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, hostId, count, availMb]);

  // A builder must hang under a scheduler on this host. The parent is no longer user-selectable:
  // it hangs under whichever scheduler's "+" was used; when unspecified, the host entry point (root) is used.
  const hostSchedulers = db.instances
    .filter((i) => i.role === "scheduler" && i.host_id === hostId)
    .sort((a, b) =>
      (a.scheduler_role ?? "root") === (b.scheduler_role ?? "root")
        ? a.name.localeCompare(b.name)
        : (a.scheduler_role ?? "root") === "root" ? -1 : 1,
    );
  // The control plane references schedulers by deployment_id; the instance name is for display only.
  const refOf = (s: Instance | undefined) => s?.deployment_id ?? s?.id ?? "";
  const selectedScheduler =
    (defaultSchedulerId
      ? hostSchedulers.find((s) => refOf(s) === defaultSchedulerId)
      : undefined) ??
    hostSchedulers.find((s) => (s.scheduler_role ?? "root") === "root") ??
    hostSchedulers[0];

  const base = PRESETS.find((x) => x.id === preset) ?? PRESETS[1];
  const p = preset === "custom"
    ? { id: "custom", label: t("Custom"), cpus: customCpus, mem: customMem, disk: customDisk, note: t("Custom tier") }
    : base;
  async function submit() {
    setBusy(true);
    setError("");
    try {
      if (!Number.isFinite(p.cpus) || p.cpus < 0.5 || p.cpus > 16) {
        throw new Error(t("CPU must be between 0.5 and 16 cores"));
      }
      if (!Number.isInteger(p.mem) || p.mem < 512 || p.mem > 65536 || p.mem % 128 !== 0) {
        throw new Error(t("Memory must be a multiple of 128 MiB, 512–65536 MiB"));
      }
      if (!Number.isInteger(p.disk) || p.disk < 8 || p.disk > 1024) {
        throw new Error(t("Disk must be 8–1024 GiB"));
      }
      if (!hostId) throw new Error(t("Pick an online host, or add one on the Hosts page"));
      if (!selectedScheduler) throw new Error(t("Host {name} has no scheduler yet; deploy one first", { name: targetHost?.name ?? "" }));
      const draft: BuilderDraft = {
        host_id: hostId,
        name: name.trim() || undefined,
        os,
        count,
        tier: preset,
        cpus: p.cpus,
        mem_mb: p.mem,
        disk_gb: p.disk,
        agent_profile_id: agent,
        api_profile_ids: selectedApi ? [selectedApi] : [],
        scheduler_id: refOf(selectedScheduler),
        ssh_enabled: sshEnabled,
        chat_enabled: chatEnabled,
      };
      await createBuilder(draft, onCreated);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      title={t("New builder")}
      onClose={onClose}
      width={720}
      footer={
        <>
          <Button onClick={onClose}>{t("Cancel")}</Button>
          <Button
            variant="primary"
            onClick={submit}
            disabled={busy || !agent || !hostId || !selectedScheduler || !hostOnline}
          >
            {busy ? t("Creating…") : t("Create {count}", { count })}
          </Button>
        </>
      }
    >
      <div className="stack">
        {targetHost && !hostOnline && (
          <Callout tone="warn">{t("This host is not online; containers cannot be deployed.")}</Callout>
        )}
        {hostSchedulers.length === 0 && (
          <Callout tone="warn">{t("This host has no scheduler yet; deploy the root scheduler first.")}</Callout>
        )}

        <Field label={t("Base OS")}>
          <div className="os-grid">
            {BUILDER_OS.map((item) => {
              // Only built images with a fixed digest can actually be deployed; the rest are temporarily unselectable.
              const pinned = item.image.includes("@sha256:");
              return (
              <button
                key={item.id}
                className={`select-card${os === item.id ? " selected" : ""}`}
                disabled={!pinned}
                onClick={() => setOs(item.id)}
              >
                <span className="select-head">
                  <b>{t(item.label)}</b>
                  {!pinned ? (
                    <Tag tone="warn">{t("Pending build")}</Tag>
                  ) : item.preview ? (
                    <Tag tone="warn">preview</Tag>
                  ) : (
                    <Tag tone="ok">LTS</Tag>
                  )}
                </span>
                <code>{item.tag}</code>
                <small className="footnote">{t(item.note)}</small>
              </button>
              );
            })}
          </div>
        </Field>

        <Field
          label={t("Resource tier")}
          hint={availMb > 0 ? t("{tier} · {mem}G available", { tier: t(p.note), mem: (availMb / 1024).toFixed(1) }) : t(p.note)}
        >
          <div className="tier-grid">
            {PRESETS.map((item) => {
              const active = preset === item.id;
              const overflow = availMb > 0 && item.mem * count > availMb;
              return (
                <button
                  key={item.id}
                  type="button"
                  className={`tier-card${active ? " selected" : ""}`}
                  aria-pressed={active}
                  disabled={overflow}
                  title={overflow ? t("Not enough memory available ({mem}G)", { mem: (availMb / 1024).toFixed(1) }) : undefined}
                  onClick={() => setPreset(item.id)}
                >
                  <span className="tier-check"><Icon name="check" size={11} /></span>
                  <b>{t(item.label)}</b>
                  <span className="tier-spec">{item.cpus}C / {item.mem / 1024}G</span>
                  <small>{t(item.note)}</small>
                </button>
              );
            })}
            <button
              type="button"
              className={`tier-card${preset === "custom" ? " selected" : ""}`}
              aria-pressed={preset === "custom"}
              onClick={() => setPreset("custom")}
            >
              <span className="tier-check"><Icon name="check" size={11} /></span>
              <b>{t("Custom")}</b>
              <span className="tier-spec">{t("Set manually")}</span>
              <small>{t("CPU / Memory / Disk")}</small>
            </button>
          </div>
        </Field>

        {preset === "custom" && (
          <div className="row">
            <Field label={t("CPU (cores)")} hint={t("0.5–16, decimals allowed")}>
              <input
                className="input"
                type="number"
                min={0.5}
                max={16}
                step={0.5}
                value={customCpus}
                onChange={(e) => setCustomCpus(Number(e.target.value))}
              />
            </Field>
            <Field label={t("Memory (MiB)")} hint={t("512–65536, multiple of 128")}>
              <input
                className="input"
                type="number"
                min={512}
                max={65536}
                step={128}
                value={customMem}
                onChange={(e) => setCustomMem(Number(e.target.value))}
              />
            </Field>
            <Field label={t("Disk (GiB)")} hint="8–1024">
              <input
                className="input"
                type="number"
                min={8}
                max={1024}
                step={1}
                value={customDisk}
                onChange={(e) => setCustomDisk(Number(e.target.value))}
              />
            </Field>
          </div>
        )}

        <div className="row">
          <div className="shrink">
            <Field label={t("Count")}>
              <select className="input" value={count} onChange={(e) => setCount(Number(e.target.value))}>
                {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{t("{count} units", { count: n })}</option>)}
              </select>
            </Field>
          </div>
          <Field label={t("Name")}>
            <input
              className="input"
              value={name}
              maxLength={32}
              placeholder="builder-a"
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
        </div>

        <Field label="Agent">
          <select className="input" value={agent} onChange={(e) => setAgent(e.target.value)}>
            {builderAgents.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </Field>

        <Field label="API">
          <select
            className="input"
            value={selectedApi}
            onChange={(e) => setApis(e.target.value ? [e.target.value] : [])}
          >
            {db.apis.length === 0 && <option value="">—</option>}
            {db.apis.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </Field>

        <div className="row">
          <Switch
            checked={sshEnabled}
            onChange={() => setSshEnabled((v) => !v)}
            label={t("Enable SSH (sshd and port mapping)")}
          />
          <Switch
            checked={chatEnabled}
            onChange={() => setChatEnabled((v) => !v)}
            label={t("Enable chat (task.chat.builder)")}
          />
        </div>
        <div className="muted">
          {t("With SSH off, sshd is not started and no SSH port is mapped; with chat off, the builder no longer accepts chat tasks. Both can be changed later on the detail page, which recreates the container.")}
        </div>

        {error && <Callout tone="bad">{error}</Callout>}
      </div>
    </Modal>
  );
}
