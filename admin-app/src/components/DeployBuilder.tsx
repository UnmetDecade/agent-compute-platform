import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { t } from "../i18n";
import { db } from "../store";
import { editHost, fetchHostDeployments } from "../api";
import { errorMessage } from "../live/client";
import { useLive } from "../live/context";
import type { ObservationRow } from "../live/rows";
import type { Host } from "../types";
import { Button, Callout, Field, Modal } from "./ui";

/**
 * Deploy builder: first explain the trade-off between container and bare-metal builders, then pick one.
 *
 * A container builder uses the existing CreateBuilderModal; a bare-metal builder switches the host role to builder,
 * and the control plane automatically creates and starts a native builder process on the host. The native path has
 * its own form (name, Agent, API) so the instance is not created with hidden defaults.
 */
export function DeployBuilderModal({
  host,
  onClose,
  onDone,
}: {
  host: Host;
  onClose: () => void;
  onDone: () => Promise<void> | void;
}) {
  const live = useLive();
  const navigate = useNavigate();
  const builderAgents = db.agents.filter((a) => a.enabled !== false && a.role === "builder");
  /**
   * A builder needs an Agent either way (container or bare metal), so the empty state hands the
   * operator to the Config page with the new-Agent dialog already open, same as the scheduler.
   * Navigate without closing first, for the same reason as the scheduler dialog: the close would
   * otherwise re-render the dashboard before the route transition commits.
   */
  const goCreateAgent = () => {
    navigate("/profiles", { state: { createAgent: true } });
  };
  const [step, setStep] = useState<"choice" | "native">("choice");
  const [name, setName] = useState("");
  const [agent, setAgent] = useState("");
  const [apiProfile, setApiProfile] = useState("");
  const [busy, setBusy] = useState<"container" | "native" | null>(null);
  const [notice, setNotice] = useState<{ tone: "info" | "warn" | "bad"; text: string } | null>(null);
  const [done, setDone] = useState<string | null>(null);

  // Fall back to the first enabled builder Agent / the empty API option when the stored choice disappears.
  const selectedAgent = builderAgents.some((a) => a.id === agent)
    ? agent
    : builderAgents[0]?.id ?? "";
  // Prefer the Agent's model API: a model bound through an API Profile must be selected here or the
  // control plane refuses the deployment (the Agent would reference an unbound API).
  const agentModel = db.agents.find((a) => a.id === selectedAgent)?.model_api_profile_id;
  const selectedApi = db.apis.some((a) => a.id === apiProfile)
    ? apiProfile
    : (db.apis.find((a) => a.id === agentModel)?.id ?? "");

  /** Turn the host's failed command acknowledgement into an operator-readable reason. */
  function deploymentError(observed: ObservationRow | null | undefined): string {
    const err = observed?.error;
    if (!err || typeof err !== "object") return t("The host did not run the deploy command; retry from the host page.");
    const detail = err as { code?: unknown; message?: unknown };
    const code = String(detail.code ?? "DEPLOY_FAILED");
    const message = String(detail.message ?? "");
    return message ? `${code}: ${message}` : code;
  }

  /**
   * Wait until the builder actually registers, or the host reports why it could not start.
   * Returns as soon as either answer is known; a timeout is reported as "not online yet", never as success.
   */
  async function waitForBuilder(deploymentId: string): Promise<{ ok: boolean; text: string }> {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      const deps = await fetchHostDeployments(host.id).catch(() => []);
      const dep = deps.find((d) => d.deployment_id === deploymentId);
      if (dep?.status === "FAILED") {
        return {
          ok: false,
          text: t("Builder deployment failed: {reason}", { reason: deploymentError(dep.observed) }),
        };
      }
      if (live.connected) await live.refresh().catch(() => undefined);
      const inst = db.instances.find(
        (i) => i.host_id === host.id && i.deployment_id === deploymentId,
      );
      if (inst?.state === "ONLINE") {
        return { ok: true, text: t("Bare-metal builder is online ({name}) and can take tasks.", { name: inst.name }) };
      }
    }
    return {
      ok: false,
      text: t("The builder was created but did not come online within 60 seconds; check the host status and logs in the studio."),
    };
  }

  async function deployNative() {
    setBusy("native");
    setNotice(null);
    try {
      const displayName = name.trim();
      const out = await editHost(
        host.id,
        {
          role_mode: "builder",
          native_builder: {
            ...(displayName ? { display_name: displayName } : {}),
            ...(selectedAgent ? { agent_profile_id: selectedAgent } : {}),
            api_profile_ids: selectedApi ? [selectedApi] : [],
          },
        },
        async () => {
          if (live.connected) await live.refresh();
        },
      );
      if (out.warning) {
        // No scheduler yet is not a failure: the host is already a bare-metal builder, and the control plane
        // starts the instance by itself once a scheduler (on any host) becomes reachable.
        setNotice(
          out.warning_code === "SCHEDULER_URL_MISSING"
            ? {
                tone: "info",
                text: t("This host is now a bare-metal builder. No scheduler is reachable yet; once you deploy one, the builder attaches and starts on its own."),
              }
            : {
                tone: "warn",
                text: t("Host role switched, but the bare-metal builder did not start: {reason}", { reason: out.warning }),
              },
        );
        return;
      }
      if (out.native_builder) {
        // Creating the deployment only records desired state; wait for the host to apply it and the builder to register,
        // otherwise the dialog reports success for a builder that silently never started.
        setDone(t("Bare-metal builder created; waiting for the host to report in…"));
        const outcome = await waitForBuilder(out.native_builder.deployment_id);
        setDone(outcome.ok ? outcome.text : null);
        if (!outcome.ok) setNotice({ tone: "bad", text: outcome.text });
        return;
      }
      setDone(t("This host is already a bare-metal builder."));
    } catch (e) {
      setNotice({ tone: "bad", text: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  }

  const footer = done ? (
    <Button
      variant="primary"
      onClick={() => {
        void onDone();
        onClose();
      }}
    >
      {t("Done")}
    </Button>
  ) : builderAgents.length === 0 ? (
    <>
      <Button onClick={onClose} disabled={busy !== null}>
        {t("Cancel")}
      </Button>
      <Button variant="primary" onClick={goCreateAgent}>
        {t("Create an Agent")}
      </Button>
    </>
  ) : step === "choice" ? (
    <>
      <Button onClick={onClose} disabled={busy !== null}>
        {t("Cancel")}
      </Button>
      <Button variant="primary" onClick={() => setStep("native")} disabled={busy !== null}>
        {t("Deploy bare-metal builder")}
      </Button>
    </>
  ) : (
    <>
      <Button onClick={onClose} disabled={busy !== null}>
        {t("Cancel")}
      </Button>
      <Button variant="primary" onClick={() => void deployNative()} disabled={busy !== null}>
        {busy === "native" ? t("Deploying…") : t("Deploy bare-metal builder")}
      </Button>
    </>
  );

  return (
    <Modal open title={t("Deploy builder")} onClose={onClose} width={720} footer={footer}>
      {builderAgents.length === 0 ? (
        <Callout tone="warn">
          {t("No builder Agent yet. Create an Agent Profile on the Config page, then come back to deploy.")}
        </Callout>
      ) : step === "choice" ? (
        <div className="builder-choice">
          <section className="builder-choice-card">
            <header>
              <b>{t("Container builder")}</b>
            </header>
            <p>{t("The Agent runs in a Docker container, isolated from the host.")}</p>
            <ul className="builder-points">
              <li className="is-pro">{t("Run several on one host and allocate capacity as needed")}</li>
              <li className="is-pro">{t("Pinned images and clean dependencies; delete and recreate if broken")}</li>
              <li className="is-pro">{t("Tasks stay isolated from each other — good for standard builds")}</li>
              <li className="is-con">{t("Requires Docker; host kernel and device access are limited")}</li>
              <li className="is-con">{t("Extra startup time and disk overhead")}</li>
              <li className="is-con">{t("The container cannot see host processes or devices")}</li>
            </ul>
          </section>

          <section className="builder-choice-card">
            <header>
              <b>{t("Bare-metal builder")}</b>
            </header>
            <p>{t("The Agent runs directly on the host, without Docker.")}</p>
            <ul className="builder-points">
              <li className="is-pro">{t("Uses the host's CPU, GPU, network, and devices directly")}</li>
              <li className="is-pro">{t("No container overhead; runs commands Docker cannot")}</li>
              <li className="is-pro">{t("The terminal logs straight into the host for easier debugging")}</li>
              <li className="is-con">{t("The host can only be a builder, not run container roles")}</li>
              <li className="is-con">{t("No CPU/memory isolation; tasks compete for resources")}</li>
              <li className="is-con">{t("Depends on the host environment; migration and rollback are heavier")}</li>
            </ul>
          </section>
        </div>
      ) : (
        <div className="stack">
          <Callout tone="info">
            {t("A bare-metal builder switches the host role to builder; the host can no longer run container roles.")}
          </Callout>
          <Field label={t("Name")} hint={t("Leave empty to derive a unique name per host")}>
            <input
              className="input"
              value={name}
              maxLength={32}
              placeholder={host.name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label="Agent">
            <select className="input" value={selectedAgent} onChange={(e) => setAgent(e.target.value)}>
              {builderAgents.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </Field>
          <Field label={t("API (optional)")}>
            <select className="input" value={selectedApi} onChange={(e) => setApiProfile(e.target.value)}>
              <option value="">—</option>
              {db.apis.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </Field>
        </div>
      )}

      {notice && <Callout tone={notice.tone}>{notice.text}</Callout>}
      {done && <Callout tone="info">{done}</Callout>}
    </Modal>
  );
}
