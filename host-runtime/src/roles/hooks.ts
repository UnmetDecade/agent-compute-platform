import { runShell, baseEnv, tail } from "./shell.js";
import { TaskAborted, TaskFailed, type ExecContext } from "../exec-types.js";
import type { Assignment } from "../client.js";

/**
 * Deterministic stage hooks.
 *
 * A role stage is more than "run the agent in some directory": before the
 * developer agent starts, its work tree has to be brought up to date with the
 * project snapshot, and after it finishes its changes have to be collected into
 * a change package for the review stage. If either step depended on the model,
 * the hand-off would silently degrade whenever the model had a bad turn.
 *
 * Both hooks therefore live in `requirements.build` and run with `/bin/sh -lc`,
 * exactly like `build.command`:
 *
 *   "build": {
 *     "instruction": "...",
 *     "prepare_command": "bash /scripts/01-sync-worktree.sh",
 *     "post_command": "bash /scripts/02-collect-changes.sh",
 *     "workdir": "/work/ui-dev"
 *   }
 *
 * The hook runs in the same directory the agent will use, with the same
 * PLATFORM_* identifiers, so scripts can address the task without parsing the
 * plan. A non-zero exit fails the attempt; the scheduler's retry policy then
 * applies, which is the same guarantee as a failing build command.
 */

export type StageHookKind = "prepare" | "post";

function buildSpec(task: Assignment): Record<string, unknown> {
  const raw = task.requirements?.build;
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
}

/**
 * Hook command for a stage. `build.<kind>_command` is the documented place;
 * `requirements.<kind>_command` is accepted as well so an operator can add a
 * hook to one request without rewriting the plan.
 */
export function stageHookCommand(task: Assignment, kind: StageHookKind): string {
  const key = `${kind}_command`;
  const fromBuild = buildSpec(task)[key];
  if (typeof fromBuild === "string" && fromBuild.trim()) return fromBuild.trim();
  const fromRequirements = (task.requirements ?? {})[key];
  if (typeof fromRequirements === "string" && fromRequirements.trim()) return fromRequirements.trim();
  return "";
}

function hookTimeoutSeconds(task: Assignment, kind: StageHookKind): number {
  const cap = Number(process.env.PLATFORM_HOOK_TIMEOUT_SECONDS ?? 30 * 60);
  const ceiling = Number.isFinite(cap) && cap > 0 ? cap : 30 * 60;
  const spec = buildSpec(task);
  const requested = Number(spec[`${kind}_timeout_seconds`]);
  if (Number.isFinite(requested) && requested > 0) return Math.min(requested, ceiling);
  return ceiling;
}

function hookEnv(
  task: Assignment,
  ctx: ExecContext,
  workspace: string,
  extraEnv: Record<string, string>,
): NodeJS.ProcessEnv {
  const requirements = task.requirements ?? {};
  return baseEnv({
    ...extraEnv,
    PLATFORM_INSTANCE_ID: ctx.instanceId,
    PLATFORM_ATTEMPT_ID: task.attempt_id,
    PLATFORM_TASK_ID: task.task_id,
    PLATFORM_TASK_TYPE: task.task_type,
    PLATFORM_WORKSPACE: workspace,
    PLATFORM_PROJECT: String(requirements.project ?? ""),
    PLATFORM_BUSINESS_ROLE: String(requirements.business_role ?? ""),
    PLATFORM_ORIGIN_TASK_ID: String(requirements.origin_task_id ?? task.task_id),
    PLATFORM_PLAN_ID: String(requirements.plan_id ?? ""),
  });
}

/**
 * Run one stage hook. Returns false when the stage declares no hook, so the
 * caller can keep the fast path for plain agent tasks.
 */
export async function runStageHook(
  task: Assignment,
  ctx: ExecContext,
  kind: StageHookKind,
  workspace: string,
): Promise<boolean> {
  const command = stageHookCommand(task, kind);
  if (!command) return false;

  const spec = buildSpec(task);
  const extraEnv =
    spec.env && typeof spec.env === "object"
      ? Object.fromEntries(
          Object.entries(spec.env as Record<string, unknown>)
            .filter(([, v]) => typeof v === "string")
            .map(([k, v]) => [k, String(v)]),
        )
      : {};

  const timeoutSeconds = hookTimeoutSeconds(task, kind);
  const label = kind === "prepare" ? "prepare" : "post";
  ctx.log(`stage hook ${label}: ${command.slice(0, 200)} (cwd ${workspace})`);
  const result = await runShell({
    command,
    cwd: workspace,
    env: hookEnv(task, ctx, workspace, extraEnv),
    signal: ctx.signal,
    timeoutMs: timeoutSeconds * 1000,
  });

  if (ctx.signal.aborted) {
    throw new TaskAborted(ctx.signal.reason === "cancelled" || ctx.signal.reason === "shutdown" ? ctx.signal.reason : "lease_lost");
  }

  for (const line of result.stdout.split("\n").slice(-40)) {
    if (line.trim()) ctx.log(`  ${label}: ${line.slice(0, 500)}`);
  }
  for (const line of result.stderr.split("\n").slice(-40)) {
    if (line.trim()) ctx.log(`  ${label} (stderr): ${line.slice(0, 500)}`);
  }

  const code = kind === "prepare" ? "STAGE_PREPARE_FAILED" : "STAGE_POST_FAILED";
  if (result.timedOut) {
    throw new TaskFailed(code, `${label} hook exceeded ${timeoutSeconds}s and was terminated`, {
      command,
      timeout_seconds: timeoutSeconds,
      stdout_tail: tail(result.stdout),
      stderr_tail: tail(result.stderr),
    });
  }
  if (result.exitCode !== 0) {
    throw new TaskFailed(code, `${label} hook exited with code ${result.exitCode}`, {
      exit_code: result.exitCode,
      command,
      stdout_tail: tail(result.stdout),
      stderr_tail: tail(result.stderr),
    });
  }
  return true;
}
