import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { roleExecutors } from "../src/roles/index.js";
import { TaskFailed, type ExecContext, type UploadedArtifact } from "../src/exec-types.js";
import { MEDIA, sha256Of } from "../src/roles/common.js";
import { runStageHook } from "../src/roles/hooks.js";
import { resolveWorkdir } from "../src/roles/workdir.js";
import type { Assignment } from "../src/client.js";

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "builder-test-"));
after(() => fs.rmSync(BASE, { recursive: true, force: true }));

function assignment(partial: Partial<Assignment> = {}): Assignment {
  return {
    task_id: "task_1",
    task_type: "task.build",
    attempt_id: "att_1",
    attempt_number: 1,
    lease_token: "lease-1",
    fencing_token: 1,
    lease_expires_at: "",
    grant_id: "rgr_1",
    payload_ref: null,
    payload_schema: "1.0",
    resource_profile_id: "rp_builder_medium",
    deadline_at: null,
    requirements: {},
    agent: { profile_id: null, version: null },
    api_profiles: [],
    ...partial,
  };
}

interface StoredArtifact {
  data: Buffer;
  sha256: string;
  media_type: string;
}

function makeCtx(instanceId = "builder-ubuntu22-a") {
  const store = new Map<string, StoredArtifact>();
  const uploads: UploadedArtifact[] = [];
  let seq = 0;
  const ctx: ExecContext = {
    signal: new AbortController().signal,
    instanceId,
    workspaceDir: fs.mkdtempSync(path.join(BASE, "ws-")),
    log: () => {},
    progress: () => {},
    async uploadArtifact(content, mediaType = "application/octet-stream") {
      const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
      const artifact: UploadedArtifact = {
        artifact_id: `art_${++seq}`,
        sha256: sha256Of(data),
        size_bytes: data.length,
      };
      store.set(artifact.artifact_id, { data, sha256: artifact.sha256, media_type: mediaType });
      uploads.push(artifact);
      return artifact;
    },
    async downloadArtifact(artifactId) {
      const v = store.get(artifactId);
      if (!v) throw new Error(`unknown artifact ${artifactId}`);
      return v;
    },
  };
  return { ctx, store, uploads };
}

async function expectTaskFailed(fn: () => Promise<unknown>, code: string) {
  try {
    await fn();
    assert.fail(`expected ${code} to be thrown, but the call succeeded`);
  } catch (e) {
    assert.ok(e instanceof TaskFailed, `expected TaskFailed, got ${e}`);
    assert.equal(e.code, code, `error code mismatch: ${e.code} / ${JSON.stringify(e.detail)}`);
    return e;
  }
}

describe("v4 builder executor", () => {
  it("runs requirements.build.command and persists the full log as an artifact", async () => {
    const { ctx, store, uploads } = makeCtx();
    const task = assignment({
      task_id: "task_build",
      requirements: {
        build: {
          command: "printf 'hello-build'; echo 'warn' >&2",
          workdir: ".",
          env: { CC: "gcc-13" },
        },
      },
    });

    const out = await roleExecutors["task.build"](task, ctx);
    assert.equal(uploads.length, 1);
    assert.equal(store.get(uploads[0].artifact_id)!.media_type, MEDIA.log);
    const log = store.get(uploads[0].artifact_id)!.data.toString("utf8");
    assert.match(log, /hello-build/);
    assert.match(log, /warn/);
    assert.match(log, /command: printf 'hello-build'/);
    assert.equal(out.outputs?.exit_code, 0);
    assert.equal(out.outputs?.stdout_tail, "hello-build");
    assert.match(String(out.summary), /Build completed/);
  });

  it("the working directory is pinned inside the workspace and the command uses it as cwd", async () => {
    const { ctx } = makeCtx();
    const out = await roleExecutors["task.build"](
      assignment({ requirements: { build: { command: "pwd", workdir: "." } } }),
      ctx,
    );
    assert.equal(String(out.outputs?.stdout_tail).trim(), fs.realpathSync(ctx.workspaceDir));
  });

  it("a workspace root passed by the control plane maps to this attempt's directory", async () => {
    const { ctx } = makeCtx();
    const out = await roleExecutors["task.build"](
      assignment({
        requirements: {
          build: { command: "pwd", workdir: path.dirname(ctx.workspaceDir) },
        },
      }),
      ctx,
    );
    assert.equal(String(out.outputs?.stdout_tail).trim(), fs.realpathSync(ctx.workspaceDir));
  });

  it("out-of-bounds working directories are rejected outright", async () => {
    const { ctx } = makeCtx();
    await expectTaskFailed(
      () =>
        roleExecutors["task.build"](
          assignment({ requirements: { build: { command: "pwd", workdir: "../.." } } }),
          ctx,
        ),
      "BUILD_WORKDIR_INVALID",
    );
  });

  it("non-zero exit → BUILD_FAILED, keeping the log artifact and stderr tail", async () => {
    const { ctx, store, uploads } = makeCtx();
    const err = await expectTaskFailed(
      () =>
        roleExecutors["task.build"](
          assignment({ requirements: { build: { command: "echo boom >&2; exit 3" } } }),
          ctx,
        ),
      "BUILD_FAILED",
    );
    const detail = err.detail as Record<string, unknown>;
    assert.equal(detail.exit_code, 3);
    assert.match(String(detail.stderr_tail), /boom/);
    assert.equal(uploads.length, 1);
    assert.match(store.get(uploads[0].artifact_id)!.data.toString("utf8"), /boom/);
  });

  it("without a command, the deterministic manifest build is kept (demo / smoke)", async () => {
    const { ctx, store, uploads } = makeCtx();
    const task = assignment({ task_id: "task_build", payload_ref: "git://repo" });
    const out = await roleExecutors["task.build"](task, ctx);
    assert.equal(uploads.length, 1);
    const manifest = JSON.parse(store.get(uploads[0].artifact_id)!.data.toString("utf8"));
    assert.equal(manifest.schema, "build-manifest/1");
    assert.equal(manifest.built_by, "builder-ubuntu22-a");
    assert.equal(manifest.files.length, 3);
    for (const f of manifest.files) {
      const file = path.join(ctx.workspaceDir, f.path);
      assert.ok(fs.existsSync(file), `working directory is missing ${f.path}`);
      assert.equal(sha256Of(fs.readFileSync(file)), f.sha256);
    }
    assert.equal(out.outputs?.artifact_id, uploads[0].artifact_id);
  });
});

describe("role workdir and deterministic stage hooks", () => {
  it("accepts a mounted project root declared by the deployment", () => {
    const mounted = fs.mkdtempSync(path.join(BASE, "mounted-"));
    const prev = process.env.BUILDER_PROJECT_ROOTS;
    process.env.BUILDER_PROJECT_ROOTS = `/work,${mounted}`;
    try {
      assert.equal(resolveWorkdir("/tmp/attempt", "/work/ui-dev"), "/work/ui-dev");
      assert.equal(resolveWorkdir("/tmp/attempt", mounted), mounted);
      assert.throws(() => resolveWorkdir("/tmp/attempt", "/etc"), /escapes the boundary/);
    } finally {
      if (prev === undefined) delete process.env.BUILDER_PROJECT_ROOTS;
      else process.env.BUILDER_PROJECT_ROOTS = prev;
    }
  });

  it("prepare runs before the agent in the role workdir with task context", async () => {
    const { ctx } = makeCtx();
    const work = fs.mkdtempSync(path.join(BASE, "role-"));
    const task = assignment({
      requirements: {
        project: "demo",
        business_role: "ui-dev",
        origin_task_id: "task_root",
        build: {
          prepare_command:
            "printf '%s|%s|%s' \"$PLATFORM_BUSINESS_ROLE\" \"$PLATFORM_PROJECT\" \"$PLATFORM_ORIGIN_TASK_ID\" > prepared.txt && pwd >> prepared.txt",
        },
      },
    });

    assert.equal(await runStageHook(task, ctx, "prepare", work), true);
    const text = fs.readFileSync(path.join(work, "prepared.txt"), "utf8");
    assert.match(text, /^ui-dev\|demo\|task_root/);
    assert.match(text, /role-/);
    // A stage without a hook is a no-op rather than a failure.
    assert.equal(await runStageHook(assignment(), ctx, "post", work), false);
  });

  it("a failing hook fails the attempt with its tail of output", async () => {
    const { ctx } = makeCtx();
    const work = fs.mkdtempSync(path.join(BASE, "role-"));
    const task = assignment({ requirements: { build: { post_command: "echo nope >&2; exit 7" } } });
    const err = await expectTaskFailed(() => runStageHook(task, ctx, "post", work), "STAGE_POST_FAILED");
    assert.equal((err.detail as Record<string, unknown>).exit_code, 7);
    assert.match(String((err.detail as Record<string, unknown>).stderr_tail), /nope/);
  });
});
