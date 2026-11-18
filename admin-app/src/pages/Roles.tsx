import { t } from "../i18n";
import { useCallback, useEffect, useState } from "react";
import { db } from "../store";
import { errorMessage } from "../live/client";
import {
  createBusinessRole,
  deleteBusinessRole,
  fetchBusinessRoles,
  fetchInstanceRoles,
  setInstanceRoles,
  updateBusinessRole,
  type BusinessRole,
  type InstanceRole,
} from "../live/roles";
import type { Instance } from "../types";
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
 * Business roles and who serves them.
 *
 * The operator only names a role and describes what it does in their own words.
 * Everything the scheduler needs (workdir, capabilities) follows from that or
 * has a safe default: every builder mounts the same project tree, and the
 * scheduler serializes work by folder rather than by per-role paths.
 */
export function RolesPage() {
  const builders = db.instances.filter((i) => i.role === "builder");
  const [roles, setRoles] = useState<BusinessRole[]>([]);
  const [assignments, setAssignments] = useState<Record<string, InstanceRole[]>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [edit, setEdit] = useState<BusinessRole | "new" | null>(null);
  const [assignTo, setAssignTo] = useState<Instance | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<BusinessRole | null>(null);
  const [deleteError, setDeleteError] = useState("");
  const [busy, setBusy] = useState("");

  const refresh = useCallback(async () => {
    setError("");
    try {
      const list = await fetchBusinessRoles();
      setRoles(list);
      // Assignments live per instance; a builder that is not registered yet simply
      // has none, which must not hide the rest of the page.
      const roster = db.instances.filter((i) => i.role === "builder");
      const pairs = await Promise.all(
        roster.map(async (b) => {
          try {
            return [b.id, await fetchInstanceRoles(b.id)] as const;
          } catch {
            return [b.id, [] as InstanceRole[]] as const;
          }
        }),
      );
      setAssignments(Object.fromEntries(pairs));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function remove(role: BusinessRole) {
    setBusy(role.role_key);
    setDeleteError("");
    try {
      await deleteBusinessRole(role.role_key);
      setConfirmDelete(null);
      await refresh();
    } catch (e) {
      setDeleteError(errorMessage(e));
    } finally {
      setBusy("");
    }
  }

  const online = roles.filter((r) => (r.instances_online ?? 0) > 0).length;
  const missing = roles.filter((r) => (r.instances_online ?? 0) === 0);
  const nameOf = (roleKey: string) =>
    roles.find((r) => r.role_key === roleKey)?.name ?? roleKey;

  return (
    <div className="page">
      <PageHead
        title={t("Business roles")}
        meta={
          <>
            <span>{t("{count} roles", { count: roles.length })}</span>
            <span className="sep" />
            <span>{t("{count} with online machines", { count: online })}</span>
            <span className="sep" />
            <span>{t("{count} builders", { count: builders.length })}</span>
          </>
        }
        actions={
          <Button variant="primary" onClick={() => setEdit("new")}>
            <Icon name="plus" size={14} />
            {t("New role")}
          </Button>
        }
      />

      <p className="muted small" style={{ marginTop: -4 }}>
        {t("Builders start without a business role; describe what each role does in plain language here, then assign it.")}
      </p>

      {error && <Callout tone="bad">{error}</Callout>}
      {!loading && missing.length > 0 && (
        <Callout tone="warn">
          {t("These roles have no online machine; their tasks will stay queued: {roles}", {
            roles: missing.map((r) => r.name).join(", "),
          })}
        </Callout>
      )}

      <Card flush>
        <div className="card-title" style={{ padding: "14px 16px 0" }}>
          <div>
            <h2>{t("Role definitions")}</h2>
            <p className="card-sub">
              {t("The role description is sent to the agent with every task it runs.")}
            </p>
          </div>
        </div>
        {loading && roles.length === 0 ? (
          <Empty text={t("Loading…")} />
        ) : roles.length === 0 ? (
          <Empty text={t("No business roles yet. Create one, then assign it to a builder.")} />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t("Display name")}</th>
                <th>{t("Description")}</th>
                <th>{t("Project")}</th>
                <th>{t("Operation notes")}</th>
                <th>{t("Online machines")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {roles.map((role) => (
                <tr key={role.role_key} onClick={() => setEdit(role)} style={{ cursor: "pointer" }} title={t("Edit")}>
                  <td>
                    <b>{role.name}</b>
                    {!role.enabled && <span className="text-warn small"> · {t("Disabled")}</span>}
                  </td>
                  <td className="small">{role.description || <span className="muted">{t("None")}</span>}</td>
                  <td>{role.project}</td>
                  <td className="small muted" style={{ maxWidth: 360 }}>
                    <div
                      style={{
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        display: "-webkit-box",
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: "vertical",
                      }}
                      title={role.operation_prompt ?? ""}
                    >
                      {role.operation_prompt || t("Not filled in")}
                    </div>
                  </td>
                  <td>
                    <span className={(role.instances_online ?? 0) > 0 ? "" : "text-warn"}>
                      {role.instances_online ?? 0}/{role.instances_total ?? 0}
                    </span>
                  </td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <Button
                      variant="ghost"
                      disabled={busy === role.role_key}
                      onClick={() => {
                        setDeleteError("");
                        setConfirmDelete(role);
                      }}
                    >
                      {t("Delete")}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card flush>
        <div className="card-title" style={{ padding: "14px 16px 0" }}>
          <div>
            <h2>{t("Assigned builders")}</h2>
            <p className="card-sub">
              {t("A builder can serve several roles; a higher weight claims that role's tasks first.")}
            </p>
          </div>
        </div>
        {builders.length === 0 ? (
          <Empty text={t("No builders yet. Deploy one from the Builders page first.")} />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t("Builders")}</th>
                <th>{t("Host")}</th>
                <th>{t("Status")}</th>
                <th>{t("Assigned roles")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {builders.map((builder) => {
                const assigned = assignments[builder.id] ?? [];
                return (
                  <tr key={builder.id}>
                    <td><b>{builder.name}</b></td>
                    <td className="small muted">
                      {db.hosts.find((h) => h.id === builder.host_id)?.name ?? builder.host_id}
                    </td>
                    <td><Badge value={builder.state} /></td>
                    <td>
                      {assigned.length ? (
                        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                          {assigned.map((r) => (
                            <Tag key={r.role_key} tone="accent" title={`${t("Weight")} ${r.weight}`}>
                              {nameOf(r.role_key)}
                              <span className="muted small"> · {r.weight}</span>
                            </Tag>
                          ))}
                        </div>
                      ) : (
                        <span className="muted small">{t("Unassigned")}</span>
                      )}
                    </td>
                    <td>
                      <Button size="sm" onClick={() => setAssignTo(builder)} disabled={roles.length === 0}>
                        {t("Assign")}
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      {edit && (
        <RoleModal
          value={edit === "new" ? null : edit}
          onClose={() => setEdit(null)}
          onSaved={refresh}
        />
      )}
      {assignTo && (
        <AssignModal
          instance={assignTo}
          roles={roles}
          current={assignments[assignTo.id] ?? []}
          onClose={() => setAssignTo(null)}
          onSaved={refresh}
        />
      )}
      {confirmDelete && (
        <Modal
          open
          title={t("Delete role")}
          onClose={() => setConfirmDelete(null)}
          width={420}
          footer={
            <>
              <Button onClick={() => setConfirmDelete(null)}>{t("Cancel")}</Button>
              <Button
                variant="danger"
                disabled={busy === confirmDelete.role_key}
                onClick={() => void remove(confirmDelete)}
              >
                {busy === confirmDelete.role_key ? t("Deleting…") : t("Delete")}
              </Button>
            </>
          }
        >
          <p>{t("Delete role \"{name}\"? Its machine assignments are removed with it.", { name: confirmDelete.name })}</p>
          <p className="muted small">
            {t("A role still referenced by a plan cannot be deleted; edit or disable those plans first.")}
          </p>
          {deleteError && <Callout tone="bad">{deleteError}</Callout>}
        </Modal>
      )}
    </div>
  );
}

/**
 * Three fields and one textarea. The role key and workdir are derived by the
 * scheduler; the operator writes what the role does in plain language.
 */
function RoleModal({
  value,
  onClose,
  onSaved,
}: {
  value: BusinessRole | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [project, setProject] = useState(value?.project && value.project !== "*" ? value.project : "");
  const [name, setName] = useState(value?.name ?? "");
  const [description, setDescription] = useState(value?.description ?? "");
  const [operation, setOperation] = useState(value?.operation_prompt ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    setBusy(true);
    setError("");
    const body = {
      project: project.trim() || "*",
      name: name.trim(),
      description: description.trim(),
      operation_prompt: operation.trim(),
    };
    try {
      if (value) {
        await updateBusinessRole(value.role_key, body);
      } else {
        await createBusinessRole(body);
      }
      await onSaved();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      title={value ? t("Edit role {name}", { name: value.name }) : t("New role")}
      onClose={onClose}
      width={620}
      footer={
        <>
          <Button onClick={onClose}>{t("Cancel")}</Button>
          <Button variant="primary" onClick={submit} disabled={busy || !name.trim()}>
            {busy ? t("Saving…") : t("Save")}
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="row">
          <Field label={t("Project")} hint={t("Leave empty for *, available to every project")}>
            <input
              className="input"
              value={project}
              onChange={(e) => setProject(e.target.value)}
              placeholder="demo"
            />
          </Field>
          <Field label={t("Display name")}>
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("e.g. UI development")}
              autoFocus
            />
          </Field>
        </div>

        <Field label={t("Description")}>
          <input
            className="input"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t("One line on what this role owns")}
          />
        </Field>

        <Field
          label={t("Operation notes")}
          hint={t("Describe how it should work in plain language; the text is sent to the agent with the task.")}
        >
          <textarea
            className="input"
            rows={6}
            value={operation}
            onChange={(e) => setOperation(e.target.value)}
            placeholder={t("e.g. only edit files under ui/, run repo/smoke.sh when done, and write the result in the summary.")}
          />
        </Field>

        {error && <Callout tone="bad">{error}</Callout>}
      </div>
    </Modal>
  );
}

function AssignModal({
  instance,
  roles,
  current,
  onClose,
  onSaved,
}: {
  instance: Instance;
  roles: BusinessRole[];
  current: InstanceRole[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [picked, setPicked] = useState<Record<string, number>>(() =>
    Object.fromEntries(current.map((r) => [r.role_key, r.weight])),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function toggle(roleKey: string) {
    setPicked((prev) => {
      const next = { ...prev };
      if (roleKey in next) delete next[roleKey];
      else next[roleKey] = 100;
      return next;
    });
  }

  async function submit() {
    setBusy(true);
    setError("");
    try {
      await setInstanceRoles(
        instance.id,
        Object.entries(picked).map(([role_key, weight]) => ({ role_key, weight })),
        "operator",
      );
      await onSaved();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      title={t("Assign roles — {name}", { name: instance.name })}
      onClose={onClose}
      width={560}
      footer={
        <>
          <Button onClick={onClose}>{t("Cancel")}</Button>
          <Button variant="primary" onClick={submit} disabled={busy}>
            {busy ? t("Saving…") : t("Save")}
          </Button>
        </>
      }
    >
      <div className="stack">
        <p className="muted small" style={{ margin: 0 }}>
          {t("Tick the roles this builder may serve.")}
        </p>
        {roles.length === 0 ? (
          <Empty text={t("No business roles yet.")} />
        ) : (
          roles.map((role) => {
            const active = role.role_key in picked;
            return (
              <div
                key={role.role_key}
                className="row"
                style={{ alignItems: "center", justifyContent: "space-between", gap: 12 }}
              >
                <label style={{ display: "flex", gap: 8, alignItems: "center", flex: 1 }}>
                  <input
                    type="checkbox"
                    checked={active}
                    disabled={!role.enabled && !active}
                    onChange={() => toggle(role.role_key)}
                  />
                  <span>
                    <b>{role.name}</b>
                    {role.description && <span className="muted small"> · {role.description}</span>}
                    {!role.enabled && <span className="text-warn small"> · {t("Disabled")}</span>}
                  </span>
                </label>
                {active && (
                  <label style={{ display: "flex", gap: 6, alignItems: "center", width: 150 }}>
                    <span className="small muted">{t("Weight")}</span>
                    <input
                      className="input"
                      type="number"
                      min={0}
                      max={1000}
                      value={picked[role.role_key]}
                      onChange={(e) =>
                        setPicked((prev) => ({
                          ...prev,
                          [role.role_key]: Math.max(0, Math.min(1000, Number(e.target.value) || 0)),
                        }))
                      }
                    />
                  </label>
                )}
              </div>
            );
          })
        )}
        {error && <Callout tone="bad">{error}</Callout>}
      </div>
    </Modal>
  );
}
