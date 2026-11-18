import { MEDIA, sleepAbortable, writeWorkspaceFile } from "./common.js";
import { baseEnv, runShell, tail } from "./shell.js";
import { positiveInt, resolveWorkdir } from "./workdir.js";
import { TaskAborted, TaskFailed, type ExecContext, type Executor } from "../exec-types.js";
import type { Assignment } from "../client.js";

/**
 * builder: the only execution role inside the builder.
 *
 * v4 has only the scheduler and the builder. task.build directly executes requirements.build.command:
 * run `/bin/sh -lc` in an isolated workspace, fully capture the exit code, stdout and stderr,
 * and upload the build log as an artifact. When there is no command, keep a deterministic manifest build for demos and
 * scheduler smoke tests.
 *
 * Deliberately no command allowlist here: the builder is a dedicated container, and a root shell is how it works;
 * isolation comes from the container boundary, resource limits, network policy and audit, not string filtering.
 */
export const taskBuild: Executor = async (task, ctx) => {
  const raw = (task.requirements?.build ?? {}) as Record<string, unknown>;
  const command = typeof raw.command === "string" ? raw.command.trim() : "";
  const workdir = typeof raw.workdir === "string" ? raw.workdir : "";
  const extraEnv =
    raw.env && typeof raw.env === "object"
      ? Object.fromEntries(
          Object.entries(raw.env as Record<string, unknown>)
            .filter(([, v]) => typeof v === "string")
            .map(([k, v]) => [k, String(v)]),
        )
      : {};

  // Natural-language tasks can only be executed by a builder with a bound Agent. This fails closed,
  // to avoid running "print Hello World in C++" directly as a shell command.
  const instruction = typeof raw.instruction === "string" ? raw.instruction.trim() : "";
  if (!command && instruction) {
    throw new TaskFailed(
      "AGENT_REQUIRED",
      "This is a natural-language task; bind an Agent that supports task.build to the builder before running it",
    );
  }
  if (!command) return legacyManifest(task, ctx);

  // Full SDK builds (kernel, rootfs, images) routinely exceed the old hard-coded 15 minutes.
  // The task may ask for more (`requirements.build.timeout_seconds`); the operator sets the
  // ceiling per instance with BUILD_TIMEOUT_SECONDS so a bad task cannot pin a builder forever.
  const maxTimeoutSeconds = positiveInt(process.env.BUILD_TIMEOUT_SECONDS, 12 * 60 * 60);
  const requestedTimeoutSeconds = positiveInt(raw.timeout_seconds, maxTimeoutSeconds);
  const timeoutMs = Math.min(requestedTimeoutSeconds, maxTimeoutSeconds) * 1000;

  ctx.progress(5, `Executing in the builder: ${command.slice(0, 80)}`);
  const cwd = resolveWorkdir(ctx.workspaceDir, workdir);
  const result = await runShell({
    command,
    cwd,
    env: baseEnv({
      ...extraEnv,
      PLATFORM_INSTANCE_ID: ctx.instanceId,
      PLATFORM_TASK_ID: task.task_id,
      PLATFORM_TASK_TYPE: task.task_type,
      PLATFORM_WORKSPACE: ctx.workspaceDir,
      // Role-based plan stages: review/test commands act on the artifact or
      // change package produced by the first task of the workflow.
      PLATFORM_ORIGIN_TASK_ID: String(task.requirements?.origin_task_id ?? task.task_id),
      PLATFORM_BUSINESS_ROLE: String(task.requirements?.business_role ?? ""),
      PLATFORM_PROJECT: String(task.requirements?.project ?? ""),
      PLATFORM_PLAN_ID: String(task.requirements?.plan_id ?? ""),
    }),
    signal: ctx.signal,
    timeoutMs,
  });

  if (ctx.signal.aborted) {
    throw new TaskAborted(taskAbortReason(ctx.signal));
  }

  ctx.progress(85, "Uploading build log");
  const log = [
    `# build log`,
    `task_id: ${task.task_id}`,
    `attempt_id: ${task.attempt_id}`,
    `instance: ${ctx.instanceId}`,
    `command: ${command}`,
    `workdir: ${cwd}`,
    `exit_code: ${result.exitCode}`,
    `duration_ms: ${result.durationMs}`,
    "",
    "## stdout",
    result.stdout,
    "",
    "## stderr",
    result.stderr,
    "",
  ].join("\n");
  const artifact = await ctx.uploadArtifact(log, MEDIA.log);

  if (result.timedOut) {
    throw new TaskFailed(
      "BUILD_TIMEOUT",
      `Build command exceeded ${Math.round(timeoutMs / 60_000)} minutes and was terminated`,
      {
        command,
        timeout_seconds: Math.round(timeoutMs / 1000),
        log_artifact_id: artifact.artifact_id,
      },
    );
  }
  if (result.exitCode !== 0) {
    throw new TaskFailed("BUILD_FAILED", `Build command exited with code ${result.exitCode}`, {
      exit_code: result.exitCode,
      command,
      stdout_tail: tail(result.stdout),
      stderr_tail: tail(result.stderr),
      log_artifact_id: artifact.artifact_id,
      log_sha256: artifact.sha256,
    });
  }

  ctx.progress(100, "Build completed");
  return {
    summary: `Build completed: exit 0 · ${Math.round(result.durationMs / 1000)}s`,
    outputs: {
      exit_code: 0,
      duration_ms: result.durationMs,
      command,
      workdir,
      stdout_tail: tail(result.stdout),
      stderr_tail: tail(result.stderr),
      log_artifact_id: artifact.artifact_id,
      log_sha256: artifact.sha256,
    },
  };
};

function taskAbortReason(signal: AbortSignal): "cancelled" | "lease_lost" | "shutdown" {
  const r = signal.reason;
  return r === "cancelled" || r === "shutdown" ? r : "lease_lost";
}

/**
 * Generate a deterministic build manifest when there is no command.
 * This path is kept so demo mode, scheduler smoke tests and old task envelopes still run.
 */
async function legacyManifest(task: Assignment, ctx: ExecContext) {
  ctx.progress(10, "Preparing workspace");
  const mainJs = [
    `// generated by builder agent for ${task.task_id}`,
    `export const taskId = ${JSON.stringify(task.task_id)};`,
    `export const payloadRef = ${JSON.stringify(task.payload_ref ?? null)};`,
    "",
  ].join("\n");
  await sleepAbortable(300, ctx.signal);

  ctx.progress(40, "Compiling");
  const workload = task.payload_ref ?? "(none)";
  const files = [
    writeWorkspaceFile(
      ctx.workspaceDir,
      "package.json",
      JSON.stringify({ name: `pkg-${task.task_id}`, version: "0.0.0", private: true }, null, 2) + "\n",
    ),
    writeWorkspaceFile(ctx.workspaceDir, "src/main.js", mainJs),
    writeWorkspaceFile(ctx.workspaceDir, "README.md", `# ${task.task_id}\n\npayload: ${workload}\n`),
  ];

  await sleepAbortable(300, ctx.signal);

  ctx.progress(70, "Collecting artifacts");
  const manifest = {
    schema: "build-manifest/1",
    task_id: task.task_id,
    attempt_id: task.attempt_id,
    payload_ref: task.payload_ref,
    built_by: ctx.instanceId,
    files,
    toolchain: {
      runtime: "node",
      version: process.version,
      platform: process.platform,
      arch: process.arch,
    },
  };
  const artifact = await ctx.uploadArtifact(JSON.stringify(manifest, null, 2), MEDIA.build);

  return {
    summary: `Build completed ${task.task_id} (${files.length} files)`,
    outputs: {
      artifact_id: artifact.artifact_id,
      sha256: artifact.sha256,
      files: files.map((f) => f.path),
    },
  };
}
