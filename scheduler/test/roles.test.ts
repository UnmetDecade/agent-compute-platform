import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { closePool, q, q1 } from "../src/db.js";
import { claim } from "../src/core/claim.js";
import { getWorkflowRun } from "../src/core/workflow.js";
import {
  createBusinessRole,
  deleteBusinessRole,
  listInstanceRoles,
  setInstanceRoles,
  updateBusinessRole,
} from "../src/repo/roles.js";
import { activatePlan, createPlan, submitRequest, templateIdFor } from "../src/repo/plans.js";
import { advance, assertTestDatabase, reset, runToSuccess } from "./helpers.js";

before(assertTestDatabase);
after(async () => {
  await closePool();
});
beforeEach(reset);

type Inst = { id: string; caps: string[] };

async function addBuilder({ id, caps }: Inst): Promise<void> {
  await q(
    `INSERT INTO role_instances
       (instance_id, role_id, host_id, state, agent_profile_id, allowed_task_types,
        capabilities, payload_schemas, last_heartbeat_at)
     VALUES ($1,'builder','host-a','ONLINE','agp_dev',ARRAY['task.build'],
             $2::jsonb, ARRAY['1.0'], app_now())`,
    [id, JSON.stringify({ healthy: caps })],
  );
}

async function setupWorld() {
  // The stock fixture targets execution roles worker/reviewer/tester. This
  // variant keeps role_id = builder for every worker and adds business roles.
  await q(
    `UPDATE task_definitions
        SET target_role = 'builder', capabilities = ARRAY['code.build','shell']
      WHERE task_type = 'task.build'`,
  );

  await addBuilder({ id: "ui-a", caps: ["code.build", "shell"] });
  await addBuilder({ id: "ui-b", caps: ["code.build", "shell"] });
  await addBuilder({ id: "review-a", caps: ["code.build", "shell", "repo:write"] });
  await addBuilder({ id: "test-a", caps: ["code.build", "shell", "board:v851s"] });
  await addBuilder({ id: "other-a", caps: ["code.build", "shell"] });

  await createBusinessRole({
    role_key: "ui-dev",
    project: "demo",
    name: "UI developer",
    allowed_paths: ["ui/"],
    workdir_template: "/work/{role}",
  });
  await createBusinessRole({
    role_key: "code-review",
    project: "demo",
    name: "Code review",
    required_capabilities: ["repo:write"],
    workdir_template: "/repo",
  });
  await createBusinessRole({
    role_key: "test-bench",
    project: "demo",
    name: "Board test",
    required_capabilities: ["board:v851s"],
    workdir_template: "/artifacts",
  });

  await setInstanceRoles("ui-a", [{ role_key: "ui-dev" }]);
  await setInstanceRoles("ui-b", [{ role_key: "ui-dev" }]);
  await setInstanceRoles("review-a", [{ role_key: "code-review" }]);
  await setInstanceRoles("test-a", [{ role_key: "test-bench" }]);

  const plan = await createPlan({
    project: "demo",
    name: "demo plan",
    document: {
      rules: [
        {
          id: "ui",
          priority: 10,
          match: { category: ["ui"] },
          role: "ui-dev",
          build: { instruction: "placeholder", timeout_seconds: 60 },
          chain: [
            { role: "code-review", build: { command: "echo review" } },
            {
              role: "test-bench",
              build: { command: "echo test" },
              capabilities: ["board:v851s"],
            },
          ],
        },
      ],
    },
  });
  await activatePlan(plan.plan_id);
  return plan;
}

describe("business roles do not come from the builder", () => {
  it("rejects assigning a role whose capabilities the builder lacks", async () => {
    await setupWorld();
    await assert.rejects(
      () => setInstanceRoles("ui-a", [{ role_key: "test-bench" }]),
      /lacks capabilities/,
    );
    // The failed transaction must not clear the previous assignment.
    const roles = await listInstanceRoles("ui-a");
    assert.deepEqual(roles.map((r) => r.role_key), ["ui-dev"]);
  });

  it("lets the operator reassign a builder at runtime", async () => {
    await setupWorld();
    await setInstanceRoles("review-a", [{ role_key: "ui-dev", weight: 200 }]);
    const roles = await listInstanceRoles("review-a");
    assert.equal(roles[0].role_key, "ui-dev");
    assert.equal(Number(roles[0].weight), 200);
  });

  it("refuses to delete a role a plan still references", async () => {
    await setupWorld();
    await assert.rejects(() => deleteBusinessRole("ui-dev"), /referenced by plans/);
  });
});

describe("rule-based allocation", () => {
  it("matches the request to a role and runs the chain on role-assigned builders", async () => {
    const plan = await setupWorld();

    const submitted = await submitRequest({
      project: "demo",
      category: "ui",
      instruction: "fix the settings page crash",
      requester: "tester",
    });
    assert.equal(submitted.matched.rule_id, "ui");
    assert.equal(submitted.matched.role, "ui-dev");
    assert.deepEqual(submitted.matched.chain, ["code-review", "test-bench"]);

    const first = await q1<Record<string, any>>(`SELECT * FROM tasks WHERE task_id = $1`, [
      submitted.task_id,
    ]);
    assert.ok(first);
    assert.equal(first.business_role, "ui-dev");
    assert.equal(first.plan_id, plan.plan_id);
    assert.equal(first.requirements.build.instruction, "fix the settings page crash");
    assert.equal(first.requirements.build.mode, "agent");
    assert.equal(first.requirements.build.workdir, "/work/ui-dev");
    assert.deepEqual(first.requirements.allowed_paths, ["ui/"]);
    assert.deepEqual([...first.requirements.capabilities].sort(), ["code.build", "shell"]);

    // Only ui-assigned builders may claim the developer task.
    assert.equal(await claim({ instance_id: "other-a" }), null);
    assert.equal(await claim({ instance_id: "review-a" }), null);

    await runToSuccess("ui-a", submitted.task_id);

    const second = await q1<Record<string, any>>(
      `SELECT * FROM tasks WHERE parent_task_id = $1`,
      [submitted.task_id],
    );
    assert.ok(second);
    assert.equal(second.business_role, "code-review");
    assert.equal(second.requirements.build.command, "echo review");
    assert.equal(second.requirements.build.mode, "command");
    assert.equal(second.requirements.build.workdir, "/repo");
    assert.equal(second.requirements.origin_task_id, submitted.task_id);
    assert.deepEqual([...second.requirements.capabilities].sort(), [
      "code.build",
      "repo:write",
      "shell",
    ]);

    // The developer machine cannot take the review task; the assigned machine can.
    assert.equal(await claim({ instance_id: "ui-a" }), null);
    assert.equal(await claim({ instance_id: "test-a" }), null);
    await runToSuccess("review-a", second.task_id);

    const third = await q1<Record<string, any>>(
      `SELECT * FROM tasks WHERE parent_task_id = $1`,
      [second.task_id],
    );
    assert.ok(third);
    assert.equal(third.business_role, "test-bench");
    assert.equal(third.requirements.build.command, "echo test");
    assert.equal(third.requirements.build.workdir, "/artifacts");
    assert.deepEqual([...third.requirements.capabilities].sort(), [
      "board:v851s",
      "code.build",
      "shell",
    ]);

    await runToSuccess("test-a", third.task_id);
    const run = await getWorkflowRun(submitted.workflow_run_id);
    assert.equal(run.status, "COMPLETED");
  });

  it("compiles one workflow template per rule at activation", async () => {
    const plan = await setupWorld();
    const tpl = await q1<Record<string, any>>(
      `SELECT * FROM workflow_templates WHERE workflow_template_id = $1`,
      [templateIdFor(plan.plan_id, "ui")],
    );
    assert.ok(tpl);
    assert.equal(tpl.phases[0].business_role, "ui-dev");
    assert.equal(tpl.phases[1].business_role, "code-review");
    assert.equal(tpl.phases[2].business_role, "test-bench");
  });

  it("rejects a request no rule matches", async () => {
    await setupWorld();
    await assert.rejects(
      () =>
        submitRequest({
          project: "demo",
          category: "driver",
          instruction: "fix the driver",
        }),
      /no rule in the active plan matches/,
    );
  });

  it("dry-run reports the allocation without creating a task", async () => {
    await setupWorld();
    const before = await q1<{ n: string }>(`SELECT count(*)::text AS n FROM tasks`);
    const out = await submitRequest({
      project: "demo",
      category: "ui",
      instruction: "look only",
      dry_run: true,
    });
    assert.equal(out.matched.role, "ui-dev");
    const after = await q1<{ n: string }>(`SELECT count(*)::text AS n FROM tasks`);
    assert.equal(after?.n, before?.n);
  });

  it("dry-runs a draft plan so the operator can check routing before activation", async () => {
    await setupWorld();
    const draft = await createPlan({
      project: "demo",
      name: "draft routing",
      document: {
        rules: [{ id: "draft-ui", priority: 5, match: { category: ["ui"] }, role: "ui-dev" }],
      },
    });
    assert.equal(draft.status, "DRAFT");

    const out = await submitRequest({
      project: "demo",
      plan_id: draft.plan_id,
      category: "ui",
      instruction: "preview only",
      dry_run: true,
    });
    assert.equal(out.matched.rule_id, "draft-ui");
    assert.equal(out.matched.role, "ui-dev");

    // Creating a real task still requires the plan to be active.
    await assert.rejects(
      () =>
        submitRequest({
          project: "demo",
          plan_id: draft.plan_id,
          category: "ui",
          instruction: "should not run",
        }),
      /activate it first/,
    );
  });

  it("refuses to hand out a task whose folder another live attempt holds", async () => {
    await setupWorld();
    const a = await submitRequest({ project: "demo", category: "ui", instruction: "first" });
    const b = await submitRequest({ project: "demo", category: "ui", instruction: "second" });

    const held = await claim({ instance_id: "ui-a" });
    assert.ok(held);
    const otherId = held.task_id === a.task_id ? b.task_id : a.task_id;

    // Same role, same default workdir: the second builder must not start inside
    // the folder the first one is editing.
    assert.equal(await claim({ instance_id: "ui-b" }), null);
    const blocked = await q1<{ resource_block_reason: string }>(
      `SELECT resource_block_reason FROM tasks WHERE task_id = $1`,
      [otherId],
    );
    assert.equal(blocked?.resource_block_reason, "WORKDIR_IN_USE");

    // Let the first lease expire (the holder is gone) and the block backoff pass;
    // the folder is free again and the other task can start.
    await advance(301);
    const next = await claim({ instance_id: "ui-b" });
    assert.equal(next?.task_id, otherId);
  });

  it("rejects a chain step that does not say what it runs", async () => {
    await setupWorld();
    await assert.rejects(
      () =>
        createPlan({
          project: "demo",
          name: "bad chain",
          document: {
            rules: [
              {
                id: "ui",
                role: "ui-dev",
                chain: [{ role: "code-review" }],
              },
            ],
          },
        }),
      /must define build\.command or build\.instruction/,
    );
  });
});

describe("operator writes prose, scheduler compiles it once", () => {
  it("creates a role from a display name and prose alone", async () => {
    const role = await createBusinessRole({
      project: "demo",
      name: "Документы",
      description: "Maintains the project documentation",
      operation_prompt: "Only modify files under docs/; run scripts/check-docs.sh when done",
    });
    // Names with no ASCII letters or digits get a stable derived key; the operator never types one.
    assert.match(String(role.role_key), /^role-[0-9a-f]{8}$/);
    assert.equal(role.workdir_template, "/work/{project}/work/{role}");
    assert.deepEqual(role.required_capabilities, []);
    assert.equal(role.operation_prompt, "Only modify files under docs/; run scripts/check-docs.sh when done");
  });

  it("gives the role's prose to the agent with the task instruction", async () => {
    await setupWorld();
    await updateBusinessRole("ui-dev", {
      operation_prompt: "Only modify files under ui/; run repo/smoke.sh before finishing",
    });
    const submitted = await submitRequest({
      project: "demo",
      category: "ui",
      instruction: "Fix the settings page crash",
    });
    const task = await q1<Record<string, any>>(`SELECT * FROM tasks WHERE task_id = $1`, [
      submitted.task_id,
    ]);
    assert.ok(task);
    const instruction = task.requirements.build.instruction as string;
    assert.match(instruction, /Fix the settings page crash/);
    assert.match(instruction, /\[Role operating instructions\]/);
    assert.match(instruction, /repo\/smoke\.sh/);
  });

  it("compiles a prose plan on save and keeps the words and the rules", async () => {
    await setupWorld();
    const previousKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-key";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                rules: [
                  {
                    id: "ui",
                    priority: 10,
                    match: { category: ["ui"] },
                    role: "ui-dev",
                    // A model may emit a chain step with no build; the compiler
                    // must fill it from the role description instead of failing.
                    chain: [{ role: "code-review" }],
                  },
                ],
              }),
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;
    try {
      const plan = await createPlan({
        project: "demo",
        name: "prose plan",
        document_text:
          "Hand UI-related requests to the UI developer; do not guess for anything else, reject them outright.",
      });
      assert.equal(plan.status, "DRAFT");
      assert.equal(
        plan.document_text,
        "Hand UI-related requests to the UI developer; do not guess for anything else, reject them outright.",
      );
      assert.equal((plan.document as { rules: Array<{ role: string }> }).rules[0].role, "ui-dev");
      const chain = (plan.document as { rules: Array<{ chain?: Array<{ build?: { instruction?: string } }> }> })
        .rules[0].chain;
      assert.ok(chain?.[0]?.build?.instruction, "a build-less chain step gets an instruction");

      await activatePlan(String(plan.plan_id));
      const out = await submitRequest({
        project: "demo",
        category: "ui",
        instruction: "Take a look at the router",
        dry_run: true,
      });
      assert.equal(out.matched.role, "ui-dev");
    } finally {
      globalThis.fetch = originalFetch;
      if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previousKey;
    }
  });
});
