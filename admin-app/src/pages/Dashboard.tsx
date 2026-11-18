import { t } from "../i18n";
import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { db } from "../store";
import { useHostScope } from "../host-context";
import { useLive } from "../live/context";
import { studioScheduler, tasksForHost } from "../host-tasks";
import { Character } from "../components/Character";
import { Badge, Button, Callout, Card, CardTitle, Empty, Field, Modal, PageHead, Stat, Tag } from "../components/ui";
import { Icon } from "../components/Icon";
import { CreateBuilderModal } from "../components/CreateBuilder";
import { DeployBuilderModal } from "../components/DeployBuilder";
import { DeploySchedulerModal } from "../components/DeployScheduler";
import { StudioScene } from "../components/StudioScene";
import { CreateTaskModal } from "../components/CreateTask";
import { CreateSideloadModal, SideloadDetailModal } from "../components/Sideload";
import { mergeHost } from "../api";
import { errorMessage } from "../live/client";
import type { Sideload } from "../types";

/**
 * Overview: one host's "AI Agent studio".
 * Schedulers on top, builders below, getting-started steps and recent activity on the right; all data is filtered by the current host.
 */
export function Dashboard() {
  const live = useLive();
  const { host } = useHostScope();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [addOpen, setAddOpen] = useState(false);
  // Third entry point: attach a host already onboarded to the control plane under the current host.
  const [attachOpen, setAttachOpen] = useState(false);
  const [attachId, setAttachId] = useState("");
  const [attachBusy, setAttachBusy] = useState(false);
  const [attachError, setAttachError] = useState("");
  // Create tasks in a dialog in place, without navigating to the tasks page, so current-host work is not interrupted.
  const [createOpen, setCreateOpen] = useState(false);
  // Sideload dialog and detail; both are scoped to the current host.
  const [sideloadOpen, setSideloadOpen] = useState(false);
  const [sideloadDetail, setSideloadDetail] = useState<Sideload | null>(null);
  // Deploying a builder first shows a trade-off comparison: container builder or bare-metal builder.
  const [builderChoiceOpen, setBuilderChoiceOpen] = useState(false);
  // Adding a builder / scheduler is entered only from the AI Agent studio; ?add= lets other pages jump back to it.
  const [addRole, setAddRole] = useState<"builder" | "scheduler" | null>(() => {
    const add = params.get("add");
    return add === "builder" || add === "scheduler" ? add : null;
  });
  // When opened from a node scheduler's "+", remember the parent scheduler (deployment_id); new characters hang under it by default.
  const [addUnder, setAddUnder] = useState<string | null>(null);
  function closeAdd() {
    setAddRole(null);
    setAddUnder(null);
    if (params.get("add")) {
      params.delete("add");
      setParams(params, { replace: true });
    }
  }
  // Whichever character type is chosen in the dialog, keep the parent scheduler carried in from the "+".
  function chooseRole(kind: "builder" | "scheduler") {
    setAddOpen(false);
    setAddRole(kind);
  }
  // With no host there is nothing to deploy onto: send the operator to the host
  // page with its add-host dialog already open, instead of a deploy modal that
  // cannot proceed.
  function startDeploy(kind: "builder" | "scheduler") {
    if (db.hosts.length === 0) {
      navigate("/hosts?add=1");
      return;
    }
    if (kind === "scheduler") setAddRole("scheduler");
    else setBuilderChoiceOpen(true);
  }
  // "Onboard host" lists only hosts already onboarded to the control plane; exclude the current host itself and its ancestors/descendants to avoid cycles in the federation tree.
  const attachCandidates = (() => {
    if (!host) return [];
    const blocked = new Set<string>([host.id]);
    const collectDown = (id: string) => {
      for (const h of db.hosts) {
        if (h.parent_host_id === id && !blocked.has(h.id)) {
          blocked.add(h.id);
          collectDown(h.id);
        }
      }
    };
    collectDown(host.id);
    let cursor = db.hosts.find((h) => h.id === host.parent_host_id);
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor.id)) {
      blocked.add(cursor.id);
      seen.add(cursor.id);
      cursor = db.hosts.find((h) => h.id === cursor!.parent_host_id);
    }
    return db.hosts.filter((h) => !blocked.has(h.id));
  })();
  function closeAttach() {
    setAttachOpen(false);
    setAttachId("");
    setAttachError("");
    setAttachBusy(false);
  }
  async function attachHost() {
    if (!host || !attachId) return;
    setAttachBusy(true);
    setAttachError("");
    try {
      await mergeHost(attachId, host.id, async () => {
        if (live.connected) await live.refresh();
      });
      closeAttach();
    } catch (e) {
      setAttachError(errorMessage(e));
    } finally {
      setAttachBusy(false);
    }
  }
  // The studio tree expands hosts folded into this one, and builder counts cover the whole subtree,
  // otherwise the canvas shows 3 while the header reports only this host's 2.
  const studioHostIds = (() => {
    const ids = new Set<string>();
    if (!host) return ids;
    const add = (id: string) => {
      if (ids.has(id)) return;
      ids.add(id);
      for (const h of db.hosts) if (h.parent_host_id === id) add(h.id);
    };
    add(host.id);
    return ids;
  })();
  const builders = db.instances.filter(
    (i) => i.role === "builder" && (!host || studioHostIds.has(i.host_id)),
  );
  // The overview recognizes only the local root scheduler: node schedulers are viewed on the scheduler page, and the entry point is always the root.
  const hostSchedulers = db.instances.filter(
    (i) => i.role === "scheduler" && (!host || i.host_id === host.id),
  );
  // A builder-only host has no scheduler of its own; the one that dispatches to its builders serves the
  // studio, so task creation is available without deploying a second scheduler here.
  const scheduler = studioScheduler(host);
  const remoteScheduler = Boolean(scheduler && host && scheduler.host_id !== host.id);
  // A host sees only its own sideloads; another host's devices never appear in this studio.
  const hostSideloads = host ? db.sideloads.filter((s) => s.host_id === host.id) : [];
  const hostTasks = tasksForHost(host);
  const s = {
    onlineBuilders: builders.filter((b) => b.state === "ONLINE").length,
    totalBuilders: builders.length,
    running: hostTasks.filter((t) => t.state === "RUNNING").length,
    queued: hostTasks.filter((t) => t.state === "QUEUED").length,
    failed: hostTasks.filter((t) => t.state === "FAILED").length,
  };
  const schedulerReady = Boolean(scheduler);
  // Count builders in the same scope as the studio and the header: hosts merged into this one are part of it.
  // Checking only this host's own rows made the checklist say "deploy a builder" while the canvas showed two online.
  const buildersReady = builders.length > 0;
  // A bare-metal builder is attached by the reconciler once a scheduler exists; there is no instance to create.
  const bareBuilder = host?.role_mode === "builder";
  const steps: {
    title: string;
    desc: string;
    done: boolean;
    to?: string;
    run?: () => void;
    action: string;
    blocked: string;
  }[] = [
    {
      title: remoteScheduler ? t("Scheduler attached") : t("Deploy scheduler"),
      desc: remoteScheduler
        ? t("Tasks are queued and dispatched by {name}; this host does not need a scheduler of its own.", { name: scheduler?.name ?? "" })
        : t("Platform control center: receives, queues, and dispatches tasks."),
      done: schedulerReady,
      run: remoteScheduler ? undefined : () => startDeploy("scheduler"),
      action: t("Deploy now →"),
      blocked: "",
    },
    {
      title: t("Deploy builder"),
      // A host switched to a bare-metal builder has already made the choice; only a scheduler is missing,
      // so offering the builder dialog here would reopen a decision that is settled.
      desc: bareBuilder
        ? t("This host is a bare-metal builder; it attaches on its own once a scheduler is deployed.")
        : t("Runs the builder Agent in a Docker container on the host."),
      done: buildersReady,
      // The steps lead straight into creating a builder; the container/bare-metal choice appears only at the studio's empty-state entry.
      run: bareBuilder ? undefined : () => startDeploy("builder"),
      action: t("Deploy now →"),
      blocked: bareBuilder ? t("Waiting for a scheduler") : "",
    },
    {
      title: t("Submit your first task"),
      desc: t("Choose an Agent and builder to start automated R&D."),
      done: buildersReady && hostTasks.length > 0,
      run: () => setCreateOpen(true),
      action: t("Submit task →"),
      blocked: buildersReady ? "" : t("Waiting for builder deployment"),
    },
  ];
  const guide = !schedulerReady
    ? { text: t("Waiting to initialize"), tone: "warn" as const }
    : !buildersReady
      ? { text: t("Waiting for builders"), tone: "warn" as const }
      : hostTasks.length === 0
        ? { text: t("Waiting for tasks"), tone: "warn" as const }
        : { text: t("Completed"), tone: "ok" as const };

  return (
    <div className="page page-dashboard">
      <PageHead
        title={t("Overview")}
        meta={
          <>
            <span>{host?.name ?? t("No host selected")}</span>
            <span className="sep" />
            <span>{t("{online}/{total} builders online", { online: s.onlineBuilders, total: s.totalBuilders })}</span>
          </>
        }
        actions={
          <>
            <Button variant="primary" onClick={() => setCreateOpen(true)} disabled={!schedulerReady}>
              <Icon name="play" size={13} />
              {t("Create task")}
            </Button>
          </>
        }
      />

      <Card flush className="stat-bar">
        <Stat label={t("Online builders")} value={<>{s.onlineBuilders}<em>/{s.totalBuilders}</em></>} tone={s.onlineBuilders ? "ok" : "bad"} />
        <Stat label={t("Running tasks")} value={s.running} />
        <Stat label={t("Queued tasks")} value={s.queued} tone={s.queued > 3 ? "warn" : undefined} />
        <Stat label={t("Failed, needs attention")} value={s.failed} tone={s.failed ? "bad" : undefined} />
      </Card>

      <div className="studio-layout">
        <Card flush className="studio-panel">
          <div className="studio-head">
            <h2>{t("AI Agent Studio")}</h2>
          </div>
          <StudioScene
            host={host}
            sideloads={hostSideloads}
            onAdd={(parent) => {
              setAddUnder(parent ? parent.deployment_id ?? parent.id : null);
              setAddOpen(true);
            }}
            onAddSideload={() => setSideloadOpen(true)}
            onOpenSideload={(sideload) => setSideloadDetail(sideload)}
            onDeployScheduler={() => startDeploy("scheduler")}
            onDeployBuilder={() => startDeploy("builder")}
          />
        </Card>

        <aside className="studio-right">
          <Card className="guide-card">
            <div className="guide-head">
              <h2>{t("Get started")}</h2>
              <Tag tone={guide.tone}>{guide.text}</Tag>
            </div>
            <p className="guide-intro">{t("Finish these steps to start your AI R&D studio.")}</p>
            <div className="guide-list">
              {steps.map((step, i) => {
                const active = !step.done && !step.blocked;
                return (
                  <div
                    key={step.title}
                    className={`guide-item${step.done ? " done" : active ? " active" : ""}`}
                  >
                    <span className="guide-num">{step.done ? "✓" : i + 1}</span>
                    <div className="guide-body">
                      <b>{step.title}</b>
                      <p>{step.desc}</p>
                      {!step.done && (step.blocked
                        ? <span className="guide-hint">{step.blocked}</span>
                        : step.run
                          ? <button type="button" className="link" onClick={step.run}>{step.action}</button>
                          : step.to
                            ? <Link to={step.to}>{step.action}</Link>
                            : null)}
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>

          {/* An operator on the overview cares what work is running, not which control-plane audit entries were written;
              every row links straight to the task detail. */}
          <Card className="activity">
            <CardTitle extra={<Link className="link" to="/tasks">{t("All")}</Link>}>{t("Recent tasks")}</CardTitle>
            <div className="rail-list">
              {hostTasks.slice(0, 5).map((task) => (
                <Link className="rail-row" key={task.id} to={`/tasks/${task.id}`}>
                  <div>
                    <b>{task.title}</b>
                    <small>{new Date(task.created_at).toLocaleTimeString()} · P{task.priority}</small>
                  </div>
                  <Badge value={task.state} />
                </Link>
              ))}
              {hostTasks.length === 0 && <Empty text={t("No tasks yet.")} />}
            </div>
          </Card>
        </aside>
      </div>

      <CreateTaskModal open={createOpen} onClose={() => setCreateOpen(false)} />

      {sideloadOpen && host && (
        <CreateSideloadModal
          host={host}
          onClose={() => setSideloadOpen(false)}
          onCreated={async () => {
            if (live.connected) await live.refresh();
          }}
        />
      )}

      {sideloadDetail && host && (
        <SideloadDetailModal
          sideload={
            db.sideloads.find((s) => s.sideload_id === sideloadDetail.sideload_id) ?? sideloadDetail
          }
          hostName={host.name}
          onClose={() => setSideloadDetail(null)}
          onDeleted={async () => {
            if (live.connected) await live.refresh();
          }}
        />
      )}

      <Modal
        open={attachOpen}
        title={t("Attach host")}
        onClose={closeAttach}
        width={520}
        footer={
          <>
            <Button onClick={closeAttach}>{t("Cancel")}</Button>
            <Button variant="primary" onClick={attachHost} disabled={attachBusy || !attachId}>
              {attachBusy ? t("Joining…") : t("Attach")}
            </Button>
          </>
        }
      >
        <div className="stack">
          <Field
            label={t("Host")}
            hint={t("Only hosts already enrolled in the control plane; the selected host joins this host's tree.")}
          >
            {attachCandidates.length === 0 ? (
              <Callout tone="warn">{t("No hosts available to attach.")}</Callout>
            ) : (
              <select className="input" value={attachId} onChange={(e) => setAttachId(e.target.value)}>
                <option value="">{t("Choose a host…")}</option>
                {attachCandidates.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name} · {h.state} · ΣW {h.subtree_score ?? 0}
                  </option>
                ))}
              </select>
            )}
          </Field>
          {attachError && <Callout tone="bad">{attachError}</Callout>}
        </div>
      </Modal>

      {addOpen && (
        <Modal
          open
          title={t("Add")}
          onClose={() => {
            setAddOpen(false);
            setAddUnder(null);
          }}
          width={520}
        >
          <div className="add-role-grid">
            <button
              type="button"
              className="add-role-card"
              disabled={!host}
              onClick={() => chooseRole("builder")}
            >
              <Character role="builder" state="idle" size={56} flat />
              <b>{t("Builders")}</b>
              <small>{t("Run task")}</small>
            </button>
            <button
              type="button"
              className="add-role-card"
              disabled={!host}
              onClick={() => chooseRole("scheduler")}
            >
              <Character role="scheduler" state="idle" size={56} flat />
              <b>{t("Schedulers")}</b>
              <small>{t("Receive & dispatch")}</small>
            </button>
            <button
              type="button"
              className="add-role-card"
              onClick={() => {
                setAddOpen(false);
                setAddUnder(null);
                setAttachOpen(true);
              }}
            >
              <span className="add-role-icon"><Icon name="server" size={28} /></span>
              <b>{t("Attach host")}</b>
              <small>{t("Already connected")}</small>
            </button>
          </div>
        </Modal>
      )}

      {builderChoiceOpen && host && (
        <DeployBuilderModal
          host={host}
          onClose={() => setBuilderChoiceOpen(false)}
          onDone={async () => {
            if (live.connected) await live.refresh();
          }}
        />
      )}

      {addRole === "builder" && host && (
        <CreateBuilderModal
          open
          defaultHostId={host.id}
          defaultSchedulerId={addUnder ?? undefined}
          onClose={closeAdd}
          onCreated={async () => {
            await live.refresh();
            closeAdd();
          }}
        />
      )}

      {addRole === "scheduler" && host && (
        <DeploySchedulerModal
          host={host}
          schedulers={hostSchedulers.filter((i) => i.host_id === host.id)}
          {...(addUnder ? { initialRole: "node" as const, initialParentId: addUnder } : {})}
          onClose={closeAdd}
          onDone={async () => {
            await live.refresh();
            closeAdd();
          }}
        />
      )}
    </div>
  );
}
