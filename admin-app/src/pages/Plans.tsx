import { t } from "../i18n";
import { useCallback, useEffect, useState } from "react";
import { errorMessage } from "../live/client";
import {
  activatePlan,
  createPlan,
  deactivatePlan,
  deletePlan,
  fetchPlan,
  fetchPlans,
  summarizeRule,
  updatePlan,
  type AllocationPlan,
  type PlanDocument,
} from "../live/roles";
import {
  Badge,
  Button,
  Callout,
  Card,
  Empty,
  Field,
  Modal,
  PageHead,
  Tag,
} from "../components/ui";
import { Icon } from "../components/Icon";

/**
 * Allocation plans: the operator tells the scheduler how work should be
 * allocated in plain language, and the scheduler compiles that once into rules.
 *
 * Compilation happens on save, not per request: the rules are shown to the
 * operator, then activation publishes them. Editing a plan returns it to DRAFT,
 * so the running allocation never changes without a deliberate activation.
 */
export function PlansPage() {
  const [plans, setPlans] = useState<AllocationPlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [openPlan, setOpenPlan] = useState<AllocationPlan | "new" | null>(null);

  const refresh = useCallback(async () => {
    setError("");
    try {
      setPlans(await fetchPlans());
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const active = plans.find((p) => p.status === "ACTIVE");

  return (
    <div className="page">
      <PageHead
        title={t("Allocation plans")}
        meta={
          <>
            <span>{t("{count} plans", { count: plans.length })}</span>
            <span className="sep" />
            <span>
              {active ? t("Active: {name}", { name: active.name }) : t("No active plan")}
            </span>
          </>
        }
        actions={
          <Button variant="primary" onClick={() => setOpenPlan("new")}>
            <Icon name="plus" size={14} />
            {t("New plan")}
          </Button>
        }
      />

      <p className="muted small" style={{ marginTop: -4 }}>
        {t("Describe in a paragraph who should take which task and in what order; the scheduler compiles it into fixed rules.")}
      </p>

      {error && <Callout tone="bad">{error}</Callout>}
      {!loading && !active && plans.length > 0 && (
        <Callout tone="warn">
          {t("No plan is active: requests are rejected until one is activated.")}
        </Callout>
      )}

      <Card flush>
        {loading && plans.length === 0 ? (
          <Empty text={t("Loading…")} />
        ) : plans.length === 0 ? (
          <Empty text={t("No allocation plans yet. Create one, write the description, then activate it.")} />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t("Plans")}</th>
                <th>{t("Project")}</th>
                <th>{t("Version")}</th>
                <th>{t("Rules")}</th>
                <th>{t("Status")}</th>
                <th>{t("Updated")}</th>
              </tr>
            </thead>
            <tbody>
              {plans.map((plan) => (
                <tr
                  key={plan.plan_id}
                  onClick={() => setOpenPlan(plan)}
                  style={{ cursor: "pointer" }}
                  title={t("View and edit")}
                >
                  <td>
                    <b>{plan.name}</b>
                    <div className="small muted"><code>{plan.plan_id}</code></div>
                  </td>
                  <td>{plan.project}</td>
                  <td>v{plan.version}</td>
                  <td>{plan.rule_count ?? 0}</td>
                  <td><Badge value={plan.status} /></td>
                  <td className="small muted">
                    {plan.updated_at ? new Date(plan.updated_at).toLocaleString() : "-"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {openPlan && (
        <PlanModal
          planRef={openPlan}
          onClose={() => setOpenPlan(null)}
          onChanged={refresh}
          onOpen={(plan) => setOpenPlan(plan)}
        />
      )}
    </div>
  );
}

function RuleSummary({ document }: { document: PlanDocument }) {
  return (
    <div className="stack" style={{ gap: 6 }}>
      {document.rules.map((rule) => {
        const summary = summarizeRule(rule);
        return (
          <div
            key={rule.id}
            className="row"
            style={{ alignItems: "center", gap: 10, justifyContent: "space-between" }}
          >
            <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
              <Tag tone="accent">{rule.id}</Tag>
              <span className="small muted">{summary.match}</span>
              <Icon name="arrow" size={12} />
              {summary.chain.map((role, i) => (
                <Tag key={`${rule.id}-${i}-${role}`}>{role}</Tag>
              ))}
            </div>
            <span className="muted small">
              {t("Priority")} {rule.priority ?? 0}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function PlanModal({
  planRef,
  onClose,
  onChanged,
  onOpen,
}: {
  planRef: AllocationPlan | "new";
  onClose: () => void;
  onChanged: () => Promise<void>;
  onOpen: (plan: AllocationPlan) => void;
}) {
  const isNew = planRef === "new";
  const planId = isNew ? null : planRef.plan_id;
  const [plan, setPlan] = useState<AllocationPlan | null>(null);
  const [loading, setLoading] = useState(!isNew);
  const [project, setProject] = useState(isNew ? "" : (planRef as AllocationPlan).project);
  const [name, setName] = useState(isNew ? "" : (planRef as AllocationPlan).name);
  const [text, setText] = useState("");
  const [compiled, setCompiled] = useState<PlanDocument | null>(
    isNew ? null : ((planRef as AllocationPlan).document ?? null),
  );
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (!planId) return;
    let alive = true;
    setLoading(true);
    void fetchPlan(planId)
      .then((full) => {
        if (!alive) return;
        setPlan(full);
        setProject(full.project);
        setName(full.name);
        setText(full.document_text ?? "");
        setCompiled(full.document ?? null);
        setError("");
      })
      .catch((e) => alive && setError(errorMessage(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [planId]);

  async function save() {
    setBusy("save");
    setError("");
    setNotice("");
    try {
      if (isNew) {
        const created = await createPlan({
          project: project.trim(),
          name: name.trim(),
          document_text: text.trim(),
        });
        await onChanged();
        onOpen(created);
      } else if (plan) {
        const updated = await updatePlan(plan.plan_id, {
          name: name.trim(),
          document_text: text.trim(),
        });
        setPlan(updated);
        setText(updated.document_text ?? text);
        setCompiled(updated.document ?? null);
        setNotice(t("Saved as v{version} and returned to draft; the rules take effect after reactivation.", { version: updated.version }));
        await onChanged();
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy("");
    }
  }

  async function activate() {
    if (!plan) return;
    setBusy("activate");
    setError("");
    setNotice("");
    try {
      const out = await activatePlan(plan.plan_id);
      setPlan(out.plan);
      setCompiled(out.plan.document ?? compiled);
      setNotice(
        t("Activated: {count} rules compiled into workflow templates. The project's previous plan is now disabled.", {
          count: out.templates.length,
        }),
      );
      await onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy("");
    }
  }

  async function deactivate() {
    if (!plan) return;
    setBusy("deactivate");
    setError("");
    setNotice("");
    try {
      const out = await deactivatePlan(plan.plan_id);
      setPlan(out);
      setNotice(t("Deactivated: requests for this project have no rule to match."));
      await onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy("");
    }
  }

  async function remove() {
    if (!plan) return;
    setBusy("delete");
    setError("");
    try {
      await deletePlan(plan.plan_id);
      await onChanged();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
      setConfirmDelete(false);
    } finally {
      setBusy("");
    }
  }

  const canSave =
    !busy &&
    name.trim().length > 0 &&
    text.trim().length > 0 &&
    (isNew ? project.trim().length > 0 : true);

  return (
    <Modal
      open
      title={isNew ? t("New allocation plan") : t("Plan {name}", { name: plan?.name ?? name })}
      onClose={onClose}
      width={780}
      footer={
        <>
          {!isNew && plan && (
            <Button
              variant="danger"
              onClick={() => setConfirmDelete(true)}
              disabled={!!busy || plan.status === "ACTIVE"}
              title={plan.status === "ACTIVE" ? t("Deactivate before deleting") : undefined}
            >
              {t("Delete")}
            </Button>
          )}
          <Button onClick={onClose}>{t("Close")}</Button>
          {!isNew && plan && plan.status === "ACTIVE" && (
            <Button onClick={deactivate} disabled={!!busy}>
              {busy === "deactivate" ? t("Deactivating…") : t("Deactivate")}
            </Button>
          )}
          {!isNew && plan && plan.status !== "ACTIVE" && (
            <Button onClick={activate} disabled={!!busy}>
              {busy === "activate" ? t("Activating…") : t("Activate")}
            </Button>
          )}
          <Button variant="primary" onClick={save} disabled={!canSave}>
            {busy === "save" ? t("Saving…") : isNew ? t("Create") : t("Save")}
          </Button>
        </>
      }
    >
      {loading ? (
        <Empty text={t("Loading…")} />
      ) : (
        <div className="stack">
          <div className="row">
            <Field label={t("Name")}>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label={t("Project")} hint={isNew ? undefined : t("The project cannot change after creation")}>
              <input
                className="input"
                value={project}
                disabled={!isNew}
                onChange={(e) => setProject(e.target.value)}
                placeholder="demo"
              />
            </Field>
            {!isNew && (
              <Field label={t("Status")}>
                <div style={{ paddingTop: 7 }}>
                  <Badge value={plan?.status ?? "DRAFT"} />
                </div>
              </Field>
            )}
          </div>

          {!isNew && plan?.status === "ACTIVE" && (
            <Callout tone="warn">
              {t("Saving returns the plan to draft and disables the current rules; reactivate when ready.")}
            </Callout>
          )}

          <Field
            label={t("Plan description")}
            hint={t("Write in plain language: which task goes to whom, whether review/testing follows. Do not assume commands that are not written.")}
          >
            <textarea
              className="input"
              rows={10}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={t(
                "e.g. UI requests go to UI development; code review merges the change into the repository, then the test bench runs the board tests. Do not guess for anything else — reject it.",
              )}
            />
          </Field>

          {compiled && (
            <Card className="stack" style={{ gap: 8 }}>
              <div>
                <b>{t("Rules the scheduler will run")}</b>
                <p className="muted small" style={{ margin: "2px 0 0" }}>
                  {t("Every request is matched against these rules by priority, specificity and declaration order.")}
                </p>
              </div>
              <RuleSummary document={compiled} />
            </Card>
          )}

          {notice && <Callout tone="info">{notice}</Callout>}
          {error && <Callout tone="bad">{error}</Callout>}

          {confirmDelete && (
            <Callout tone="bad">
              <div className="stack" style={{ gap: 8 }}>
                <span>{t("Delete plan \"{name}\"? Its workflow templates are removed with it.", { name: plan?.name ?? "" })}</span>
                <div style={{ display: "flex", gap: 8 }}>
                  <Button variant="danger" onClick={() => void remove()} disabled={busy === "delete"}>
                    {busy === "delete" ? t("Deleting…") : t("Delete")}
                  </Button>
                  <Button onClick={() => setConfirmDelete(false)}>{t("Cancel")}</Button>
                </div>
              </div>
            </Callout>
          )}
        </div>
      )}
    </Modal>
  );
}
