import { t } from "../i18n";
import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { db } from "../store";
import { useHostScope } from "../host-context";
import { tasksForHost } from "../host-tasks";
import { useLive } from "../live/context";
import { errorMessage } from "../live/client";
import { getLiveConnection } from "../live/config";
import { createTaskThread, fetchFailureSignatures, fetchTaskDetail, fetchTaskEvents, fetchThread, postThreadMessage } from "../live/sync";
import type { FailureSignature, Task, TaskAttempt, TaskChild, TaskEvent, ThreadDetail } from "../types";
import { Character } from "../components/Character";
import { CreateTaskModal } from "../components/CreateTask";
import { Badge, Button, Callout, Card, CardTitle, Empty, KeyVal, PageHead, Tag } from "../components/ui";
import { Icon } from "../components/Icon";
import { answerTask, cancelBuild, retryBuild } from "../api";

const FILTERS = ["ALL", "ATTENTION", "QUEUED", "RUNNING", "NEEDS_INPUT", "WAITING_CHILDREN", "SUCCEEDED", "FAILED"] as const;

/** Derived human-attention stages; 'none' means no person is needed. */
const ATTENTION_LABELS: Record<string, string> = {
  answer: "Waiting for answer",
  review: "Awaiting review",
  blocked: "Blocked",
  waiting: "Waiting for children",
};

const ATTENTION_TONES: Record<string, "warn" | "bad" | "accent"> = {
  answer: "warn",
  review: "accent",
  blocked: "bad",
  waiting: "warn",
};

/** How a task relates to its thread. */
const TASK_RELATION_LABELS: Record<string, string> = {
  owner: "Initial task",
  followup: "Follow-up task",
  context: "Related task",
};

const OUTCOME_LABELS: Record<string, string> = {
  completed: "Completed",
  error: "Execution error",
  cancelled: "Cancelled",
  input_expired: "Timed out waiting for an answer",
  input_exhausted: "Answer rounds exhausted",
  children_exhausted: "Child rounds exhausted",
  interrupted_after_outward: "Interrupted after an outward action",
};

const FAILURE_CLASS_LABELS: Record<string, string> = {
  permanent: "Permanent failure",
  outward: "Interrupted after an outward action",
  rate_limit: "Rate limited",
  busy: "Resource busy",
  transient: "Transient error",
};

const APPROVAL_LABELS: Record<string, string> = {
  ask: "Read-only, asks questions",
  edits: "May edit files",
  auto: "May run commands",
  full: "Fully autonomous",
};

/** Internal payload keys mean nothing to an operator; show the platform wording instead. */
const PAYLOAD_LABELS: Record<string, string> = {
  payload_ref: "Payload ref",
  resource_profile_id: "Resource profile",
};

export function TaskList() {
  const live = useLive();
  const { host } = useHostScope();
  const [params, setParams] = useSearchParams();
  const [submitOpen, setSubmitOpen] = useState(params.get("new") === "1");
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("ALL");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (params.get("new") === "1") setSubmitOpen(true);
  }, [params]);

  const tasks = tasksForHost(host);
  const needsAttention = (task: Task) => task.attention !== "none";
  const shown = tasks.filter((t) => {
    if (filter === "ATTENTION") {
      if (!needsAttention(t)) return false;
    } else if (filter !== "ALL" && t.state !== filter) {
      return false;
    }
    const q = query.trim().toLowerCase();
    return !q || t.title.toLowerCase().includes(q) || t.id.toLowerCase().includes(q) || t.type.includes(q);
  });
  const countOf = (f: (typeof FILTERS)[number]) =>
    f === "ALL"
      ? tasks.length
      : f === "ATTENTION"
        ? tasks.filter(needsAttention).length
        : tasks.filter((t) => t.state === f).length;

  function closeSubmit() {
    setSubmitOpen(false);
    if (params.get("new")) {
      params.delete("new");
      setParams(params, { replace: true });
    }
  }

  async function act(id: string, action: "retry" | "cancel", schedulerDeploymentId?: string | null) {
    setBusy(`${id}:${action}`);
    setError("");
    try {
      if (action === "retry") await retryBuild(id, live.refresh, schedulerDeploymentId);
      else await cancelBuild(id, live.refresh, schedulerDeploymentId);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="page">
      <PageHead
        title={t("Tasks")}
        meta={
          <>
            <span>{host?.name ?? t("No host selected")}</span>
            <span className="sep" />
            <span>{t("{count} entries", { count: tasks.length })}</span>
            <span className="sep" />
            <span>{t("{count} running", { count: tasks.filter((t) => t.state === "RUNNING").length })}</span>
            <span className="sep" />
            <span>{t("{count} queued", { count: tasks.filter((t) => t.state === "QUEUED").length })}</span>
          </>
        }
        actions={
          <Button variant="primary" onClick={() => setSubmitOpen(true)}>
            <Icon name="plus" size={14} />
            {t("Create task")}
          </Button>
        }
      />

      <div className="toolbar">
        <div className="search">
          <Icon name="search" size={14} />
          <input className="input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("Title / ID / type")} />
        </div>
        <div className="segmented">
          {FILTERS.map((f) => (
            <button key={f} className={`segment${filter === f ? " active" : ""}`} onClick={() => setFilter(f)}>
              {f === "ALL" ? t("All") : f === "ATTENTION" ? t("Needs attention") : f}
              <em>{countOf(f)}</em>
            </button>
          ))}
        </div>
      </div>

      {error && <Callout tone="bad">{error}</Callout>}

      <Card flush>
        {shown.length === 0 ? (
          <Empty text={t("No matching tasks.")} />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t("Tasks")}</th>
                <th>{t("Type")}</th>
                <th>{t("Status")}</th>
                <th>{t("Builders")}</th>
                <th>{t("Priority")}</th>
                <th>{t("Created")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.map((task) => {
                const inst = db.instances.find((i) => i.id === task.instance_id);
                return (
                  <tr key={task.id}>
                    <td>
                      <Link className="strong" to={`/tasks/${task.id}`}>{task.title}</Link>
                      <div className="small"><code>{task.id}</code></div>
                    </td>
                    <td><Tag>{task.type}</Tag></td>
                    <td>
                      <Badge value={task.state} />
                      {task.attention !== "none" && (
                        <Tag tone={ATTENTION_TONES[task.attention] ?? "warn"}>
                          {t(ATTENTION_LABELS[task.attention] ?? task.attention)}
                        </Tag>
                      )}
                      {/* A retrying task is QUEUED between attempts; the counter is the only hint in the list that it already failed. */}
                      {task.state === "QUEUED" && task.attempts > 0 && (
                        <div className="small muted">{t("Last attempt failed; waiting for an automatic retry")}</div>
                      )}
                    </td>
                    <td>{inst ? <Link className="link" to={`/builders/${inst.id}`}>{inst.name}</Link> : <span className="muted">{t("Auto-select")}</span>}</td>
                    <td>P{task.priority}</td>
                    <td className="muted small">{new Date(task.created_at).toLocaleString()}</td>
                    <td>
                      <div className="actions">
                        {(task.state === "FAILED" || task.state === "CANCELLED") && (
                          <Button size="sm" onClick={() => act(task.id, "retry", task.scheduler_deployment_id)} disabled={busy === `${task.id}-retry`}>{t("Retry")}</Button>
                        )}
                        {(task.state === "QUEUED" ||
                          task.state === "RUNNING" ||
                          task.state === "NEEDS_INPUT" ||
                          task.state === "WAITING_CHILDREN") && (
                          <Button size="sm" onClick={() => act(task.id, "cancel", task.scheduler_deployment_id)} disabled={busy === `${task.id}-cancel`}>{t("Cancel")}</Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      <CreateTaskModal open={submitOpen} onClose={closeSubmit} />
    </div>
  );
}

export function TaskShow() {
  const { id = "" } = useParams();
  const live = useLive();
  const task = db.tasks.find((t) => t.id === id);
  const [events, setEvents] = useState<TaskEvent[]>(task?.events ?? []);
  // The list projection has no failure text; the attempt history is the only place the agent's error message lives.
  const [attempts, setAttempts] = useState<TaskAttempt[]>([]);
  const [children, setChildren] = useState<TaskChild[]>([]);
  // How often this same normalized failure has been seen across the fleet; one row, not one per run.
  const [signatures, setSignatures] = useState<FailureSignature[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [answer, setAnswer] = useState("");
  const [thread, setThread] = useState<ThreadDetail | null>(null);
  const [threadBusy, setThreadBusy] = useState("");
  const [threadError, setThreadError] = useState("");
  const [followUp, setFollowUp] = useState("");
  // The detail page is split into tabs so it never scrolls: overview, thread and event log.
  const [tab, setTab] = useState<"overview" | "thread" | "events">("overview");

  useEffect(() => {
    setEvents(task?.events ?? []);
    const conn = getLiveConnection();
    if (!conn || !task) return;
    let alive = true;
    fetchTaskEvents(conn, task.id, task.scheduler_deployment_id)
      .then((items) => { if (alive) setEvents(items); })
      .catch(() => {});
    fetchTaskDetail(conn, task.id, task.scheduler_deployment_id)
      .then((detail) => {
        if (!alive) return;
        setAttempts(detail.attempts);
        setChildren(detail.children);
      })
      .catch(() => {});
    fetchFailureSignatures(conn, task.scheduler_deployment_id)
      .then((items) => { if (alive) setSignatures(items); })
      .catch(() => {});
    // A thread is optional; only load it when the task was grouped into one.
    if (task.thread_id) {
      fetchThread(conn, task.thread_id, task.scheduler_deployment_id)
        .then((detail) => { if (alive) setThread(detail); })
        .catch(() => { if (alive) setThread(null); });
    } else {
      setThread(null);
    }
    return () => { alive = false; };
  }, [task?.id, task?.events, task?.state, task?.attempts, task?.thread_id]);

  if (!task) {
    return (
      <div className="page">
        <Card><Empty text={t("Task does not exist or was cleaned up.")} /></Card>
        <p style={{ marginTop: 12 }}><Link className="link" to="/tasks">{t("Back to tasks")}</Link></p>
      </div>
    );
  }

  // The list projection only joins the current attempt, which is cleared once a task finishes; the attempt history
  // still records which builder ran it, and the attempt timestamps fill in start/finish that the task row lacks.
  const latestAttempt = attempts.length
    ? attempts.reduce((a, b) => (b.attempt_number >= a.attempt_number ? b : a))
    : undefined;
  const assignedInstanceId = task.instance_id ?? latestAttempt?.instance_id ?? null;
  const inst = db.instances.find((i) => i.id === assignedInstanceId);
  const startedAt = task.started_at ?? latestAttempt?.started_at ?? null;
  const finishedAt = task.finished_at ?? latestAttempt?.finished_at ?? null;
  // requirements is an object: reading it with String() printed "[object Object]" instead of the task body.
  const requirements = (task.payload.requirements ?? {}) as Record<string, unknown>;
  const build = (requirements.build ?? {}) as Record<string, unknown>;
  const chat = (requirements.chat ?? {}) as Record<string, unknown>;
  const instruction = String(
    task.payload.instruction ??
      build.instruction ??
      chat.message ??
      task.payload.command ??
      "",
  );
  // The mandate reference is attached by PCS at intake; it explains why the task
  // was authorized and which policy version covered it.
  const mandate = (
    task.payload.requirements as
      | { mandate?: { source?: string; actor?: string; policy_version?: string; strength?: string } }
      | undefined
  )?.mandate;
  // The newest failed attempt explains why the task is queued for a retry or dead-lettered; a later success supersedes it.
  const lastFailure =
    task.state === "QUEUED" || task.state === "FAILED"
      ? [...attempts].reverse().find((a) => a.status === "FAILED" && a.error)
      : undefined;
  // The fleet-wide row for this exact failure: occurrence count, not another message.
  const sameFailure = lastFailure?.failure_signature
    ? signatures.find((s) => s.signature === lastFailure.failure_signature)
    : undefined;

  async function act(action: "retry" | "cancel") {
    setBusy(action);
    setError("");
    try {
      if (action === "retry") await retryBuild(task!.id, live.refresh, task!.scheduler_deployment_id);
      else await cancelBuild(task!.id, live.refresh, task!.scheduler_deployment_id);
      if (live.connected) await live.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy("");
    }
  }

  async function submitAnswer() {
    const text = answer.trim();
    if (!text) return;
    setBusy("answer");
    setError("");
    try {
      await answerTask(task!.id, text, live.refresh, task!.scheduler_deployment_id);
      setAnswer("");
      if (live.connected) await live.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy("");
    }
  }

  async function startThread() {
    const conn = getLiveConnection();
    if (!conn) return;
    setThreadBusy("create");
    setThreadError("");
    try {
      const threadId = await createTaskThread(conn, task!.id, task!.title, task!.scheduler_deployment_id);
      setThread(await fetchThread(conn, threadId, task!.scheduler_deployment_id));
      await live.refresh();
    } catch (e) {
      setThreadError(errorMessage(e));
    } finally {
      setThreadBusy("");
    }
  }

  /** A follow-up message becomes a new task in the same thread; the scheduler copies the target and profile. */
  async function sendFollowUp() {
    const conn = getLiveConnection();
    const threadId = thread?.thread_id;
    const text = followUp.trim();
    if (!conn || !threadId || !text) return;
    setThreadBusy("send");
    setThreadError("");
    try {
      await postThreadMessage(conn, threadId, text, task!.scheduler_deployment_id);
      setFollowUp("");
      setThread(await fetchThread(conn, threadId, task!.scheduler_deployment_id));
      await live.refresh();
    } catch (e) {
      setThreadError(errorMessage(e));
    } finally {
      setThreadBusy("");
    }
  }

  return (
    <div className="page page-task">
      <Link className="back" to="/tasks"><Icon name="back" size={13} />{t("Tasks")}</Link>
      <PageHead
        title={
          <>
            <Character role="builder" state={task.state === "RUNNING" ? "working" : task.state === "FAILED" ? "alert" : "idle"} size={44} flat />
            {task.title}
            <Badge value={task.state} />
            {task.attention !== "none" && (
              <Tag tone={ATTENTION_TONES[task.attention] ?? "warn"}>
                {t(ATTENTION_LABELS[task.attention] ?? task.attention)}
              </Tag>
            )}
          </>
        }
        meta={
          <>
            <code>{task.id}</code>
            <span className="sep" />
            <span>{task.type}</span>
            <span className="sep" />
            <span>P{task.priority}</span>
            <span className="sep" />
            <span>{t("Attempt {n}", { n: task.attempts })}</span>
          </>
        }
        actions={
          <>
            {(task.state === "FAILED" || task.state === "CANCELLED" || task.state === "BLOCKED") && (
              <Button onClick={() => act("retry")} disabled={busy === "retry"}>
                <Icon name="refresh" size={14} />
                {busy === "retry" ? t("Retrying…") : t("Retry")}
              </Button>
            )}
            {(task.state === "QUEUED" || task.state === "RUNNING" || task.state === "WAITING_CHILDREN") && (
              <Button onClick={() => act("cancel")} disabled={busy === "cancel"}>
                <Icon name="stop" size={13} />
                {t("Cancel")}
              </Button>
            )}
            {inst && (
              <Link className="btn" to={`/terminal?instance=${encodeURIComponent(inst.key)}`}>
                <Icon name="terminal" size={14} />
                {t("Open builder")}
              </Link>
            )}
          </>
        }
      />

      {error && <Callout tone="bad">{error}</Callout>}
      {task.attention === "review" && (
        <Callout tone="info">
          {t("Awaiting human approval: this task's workflow is WAITING_APPROVAL; complete the approval flow before it continues.")}
        </Callout>
      )}
      {task.block_reason && <Callout tone="bad">{task.block_reason}</Callout>}
      {/* The agent stopped and is waiting for a person. Answering requeues the task and hands the
          answer to the next attempt; it is not a failure and does not consume the retry budget. */}
      {task.state === "NEEDS_INPUT" && (
        <Card style={{ marginBottom: 16 }}>
          <CardTitle>{t("Waiting for answer")}</CardTitle>
          <div className="question-box">{task.pending_question?.question ?? t("(No question text was recorded)")}</div>
          <textarea
            className="input"
            rows={4}
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder={t("The task resumes with your answer")}
            style={{ width: "100%", marginTop: 10, resize: "vertical" }}
          />
          <div className="actions" style={{ marginTop: 10 }}>
            <Button variant="primary" onClick={() => void submitAnswer()} disabled={busy === "answer" || !answer.trim()}>
              {busy === "answer" ? t("Submitting…") : t("Submit answer and continue")}
            </Button>
            <Button onClick={() => act("cancel")} disabled={busy === "cancel"}>{t("Abandon task")}</Button>
          </div>
        </Card>
      )}

      {/* One tab per concern: the page itself stays fixed height and only the tab content changes. */}
      <div className="segmented task-tabs">
        <button className={`segment${tab === "overview" ? " active" : ""}`} onClick={() => setTab("overview")}>
          {t("Overview")}
        </button>
        <button className={`segment${tab === "thread" ? " active" : ""}`} onClick={() => setTab("thread")}>
          {t("Thread")}{thread ? <em>{thread.tasks.length}</em> : null}
        </button>
        <button className={`segment${tab === "events" ? " active" : ""}`} onClick={() => setTab("events")}>
          {t("Events")}<em>{events.length}</em>
        </button>
      </div>

      {/* A thread groups the task with follow-up messages; each message becomes a new task
          in the same thread, so a conversation does not require resubmitting the configuration. */}
      {tab === "thread" && (
      <Card className={`thread-card${thread ? " is-thread" : ""}`}>
        <CardTitle extra={thread ? <Tag>{thread.thread_id}</Tag> : undefined}>{t("Thread")}</CardTitle>
        {threadError && <Callout tone="bad">{threadError}</Callout>}
        {!thread ? (
          <div className="row" style={{ gap: 10, alignItems: "center", justifyContent: "space-between" }}>
            <span className="muted">{t("Group this task into a thread; later messages create follow-up tasks.")}</span>
            <Button onClick={() => void startThread()} disabled={threadBusy === "create"}>
              {threadBusy === "create" ? t("Creating…") : t("Start thread")}
            </Button>
          </div>
        ) : (
          <div className="stack thread-body">
            <div className="muted small">{t("Tasks and messages in this thread; sending a message creates a follow-up task automatically.")}</div>
            {thread.tasks.map((tt) => (
              <div key={tt.task_id} className="thread-task-row">
                <Badge value={tt.status} />
                <Link className="link" to={`/tasks/${tt.task_id}`}>{tt.title ?? tt.task_id}</Link>
                <Tag>{t(TASK_RELATION_LABELS[tt.relation] ?? tt.relation)}</Tag>
                {tt.attention && tt.attention !== "none" && (
                  <Tag tone={ATTENTION_TONES[tt.attention] ?? "warn"}>
                    {t(ATTENTION_LABELS[tt.attention] ?? tt.attention)}
                  </Tag>
                )}
              </div>
            ))}
            {thread.messages.map((m) => (
              <div key={m.message_id} className="question-box thread-message">
                <div className="muted small">
                  {m.actor ?? m.role} · {new Date(m.created_at).toLocaleString()}
                </div>
                <div style={{ whiteSpace: "pre-wrap" }}>{m.body}</div>
              </div>
            ))}
            <textarea
              className="input"
              rows={4}
              value={followUp}
              onChange={(e) => setFollowUp(e.target.value)}
              placeholder={t("Continue this thread: the message creates a new follow-up task")}
              style={{ width: "100%", minHeight: 96, resize: "vertical", marginTop: 6 }}
            />
            <div className="actions">
              <Button
                variant="primary"
                onClick={() => void sendFollowUp()}
                disabled={threadBusy === "send" || !followUp.trim()}
              >
                {threadBusy === "send" ? t("Submitting…") : t("Send and create follow-up task")}
              </Button>
            </div>
          </div>
        )}
      </Card>
      )}

      {lastFailure && (
        <Callout tone="bad">
          {t("Attempt {n} failed ({code}): {message}", {
            n: lastFailure.attempt_number,
            code: lastFailure.error?.code ?? "UNKNOWN",
            message: lastFailure.error?.message ?? "",
          })}
          {lastFailure.failure_class
            ? ` ${t("Class: {label}.", {
                label: t(FAILURE_CLASS_LABELS[lastFailure.failure_class] ?? lastFailure.failure_class),
              })}`
            : ""}
          {sameFailure ? ` ${t("The same failure has occurred {count} times.", { count: sameFailure.occurrences })}` : ""}
          {task.state === "QUEUED"
            ? ` ${
                lastFailure.failure_class === "rate_limit"
                  ? t("Waiting for the external limit to reset; it retries automatically afterwards.")
                  : t("The scheduler will retry automatically after a backoff.")
              }`
            : ""}
          {lastFailure.failure_signature && (
            <div className="muted small" style={{ marginTop: 6 }}>
              {t("Failure signature: {signature}", { signature: lastFailure.failure_signature })}
            </div>
          )}
        </Callout>
      )}

      {tab === "overview" && (
        <>
      <div className="detail-grid">
        <Card>
          <CardTitle>{t("Execution info")}</CardTitle>
          <div className="kv-list">
            <KeyVal label={t("Workflow")}>{task.workflow}</KeyVal>
            <KeyVal label={t("Stage")}>{task.stage}</KeyVal>
            <KeyVal label={t("Target role")}>{task.target_role}</KeyVal>
            {task.approval_mode && (
              <KeyVal label={t("Autonomy")}>
                {t(APPROVAL_LABELS[task.approval_mode] ?? task.approval_mode)}
              </KeyVal>
            )}
            {task.outcome && (
              <KeyVal label={t("Result")}>{t(OUTCOME_LABELS[task.outcome] ?? task.outcome)}</KeyVal>
            )}
            {mandate && (
              <KeyVal label={t("Authorization")}>
                {`${mandate.source ?? "-"} · ${mandate.actor ?? "-"} · ${t("policy v{version}", {
                  version: mandate.policy_version ?? "-",
                })}`}
              </KeyVal>
            )}
            {task.parent_task_id && (
              <KeyVal label={t("Parent task")}>
                <Link className="link" to={`/tasks/${task.parent_task_id}`}>{task.parent_task_id}</Link>
              </KeyVal>
            )}
            <KeyVal label={t("Builders")}>{inst ? <Link className="link" to={`/builders/${inst.id}`}>{inst.name}</Link> : t("Waiting for dispatch")}</KeyVal>
            <KeyVal label={t("Created")}>{new Date(task.created_at).toLocaleString()}</KeyVal>
            <KeyVal label={t("Started")}>{startedAt ? new Date(startedAt).toLocaleString() : "-"}</KeyVal>
            <KeyVal label={t("Finished")}>{finishedAt ? new Date(finishedAt).toLocaleString() : "-"}</KeyVal>
          </div>
        </Card>

        <Card>
          <CardTitle>{t("Task & parameters")}</CardTitle>
          <pre className="code-block command-block">{instruction || t("(no task description)")}</pre>
          <div className="kv-list" style={{ marginTop: 10 }}>
            {Object.entries(task.payload)
              .filter(([k]) => k !== "instruction" && k !== "command" && k !== "requirements")
              .map(([k, v]) => (
                <KeyVal key={k} label={PAYLOAD_LABELS[k] ? t(PAYLOAD_LABELS[k]) : k}>
                  {typeof v === "object" ? JSON.stringify(v) : String(v)}
                </KeyVal>
              ))}
          </div>
        </Card>
      </div>

      {/* Fan-out: the parent waits here until every child is terminal, then resumes with their results. */}
      {(children.length || task.children?.length || task.parent_task_id) && (
        <Card style={{ marginTop: 16 }}>
          <CardTitle>{t("Child tasks")}</CardTitle>
          {(children.length ? children : task.children ?? []).length ? (
            <table className="table">
              <thead>
                <tr>
                  <th>{t("Tasks")}</th>
                  <th>{t("Type")}</th>
                  <th>{t("Status")}</th>
                  <th>{t("Result")}</th>
                </tr>
              </thead>
              <tbody>
                {(children.length ? children : task.children ?? []).map((c) => (
                  <tr key={c.task_id}>
                    <td>
                      <Link className="strong" to={`/tasks/${c.task_id}`}>{c.title || c.task_id}</Link>
                    </td>
                    <td><Tag>{c.task_type}</Tag></td>
                    <td><Badge value={c.status} /></td>
                    <td className="muted small">{c.outcome ? t(OUTCOME_LABELS[c.outcome] ?? c.outcome) : "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty text={t("This task was split off by a parent task and waits for the parent to collect the results.")} />
          )}
        </Card>
      )}
        </>
      )}

      {tab === "events" && (
      <Card className="events-card" style={{ marginTop: 16 }}>
        <CardTitle extra={<span className="muted small">{t("{count} events", { count: events.length })}</span>}>
          {t("Events")}
        </CardTitle>
        {events.length ? (
          // The event trail grows for the whole task lifetime; scroll it inside the card instead of stretching the page.
          <div className="events-scroll">
            <ul className="timeline">
              {/* Newest first: the latest state is what an operator opens the page for. */}
              {[...events].reverse().map((e, i) => (
                <li key={`${e.at}-${i}`}>
                  <span className={`tl-dot tl-${e.type.toLowerCase()}`} />
                  <div>
                    <b>{e.type}</b>
                    <p>{e.message}</p>
                    <small>{new Date(e.at).toLocaleString()}</small>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <Empty text={t("No events yet. They are pulled from the scheduler in live mode.")} />
        )}
      </Card>
      )}
    </div>
  );
}

export function taskById(id: string): Task | undefined {
  return db.tasks.find((t) => t.id === id);
}
