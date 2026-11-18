#!/usr/bin/env node
/**
 * platformctl — apply a project definition to the scheduler.
 *
 * The scheduler is rule-driven: it never guesses which machine should get a
 * task. This CLI is how the operator tells it the plan: create the business
 * roles, assign those roles to registered builders, publish (activate) the
 * allocation plan, and optionally submit a request to watch the chain run.
 *
 * Usage:
 *   PLATFORM_SCHEDULER_URL=http://127.0.0.1:18443 \
 *     node scripts/platformctl.mjs apply projects/demo/project.json
 *
 *   node scripts/platformctl.mjs apply <manifest> --dry-run
 *   node scripts/platformctl.mjs submit --project demo --category ui --instruction "..."
 *   node scripts/platformctl.mjs submit --project demo --category ui --instruction "..." --dry-run
 *   node scripts/platformctl.mjs status --project demo
 *   node scripts/platformctl.mjs watch <task_id>
 *   node scripts/platformctl.mjs roles | plans | tasks [--project demo]
 *
 * Manifest: JSON by default. A .yaml/.yml file needs the optional `yaml`
 * package to be resolvable (npm i yaml); the tool says so instead of guessing
 * at a parser.
 */
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const command = args[0] ?? "help";
const flags = new Map();
const positionals = [];
for (let i = 1; i < args.length; i++) {
  const a = args[i];
  if (a === "--dry-run") flags.set("dry-run", true);
  else if (a.startsWith("--") && i + 1 < args.length && !args[i + 1].startsWith("--")) {
    flags.set(a.slice(2), args[++i]);
  } else if (a.startsWith("--")) flags.set(a.slice(2), true);
  else positionals.push(a);
}

const BASE = (
  flags.get("url") ??
  process.env.PLATFORM_SCHEDULER_URL ??
  process.env.SCHEDULER_URL ??
  "http://127.0.0.1:18443"
).replace(/\/+$/, "");
const DRY = flags.get("dry-run") === true;

function die(message, code = 1) {
  console.error(`platformctl: ${message}`);
  process.exit(code);
}

async function api(method, url, body) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!res.ok) {
    const err = parsed?.error ?? {};
    const detail = err.detail ? ` ${JSON.stringify(err.detail)}` : "";
    const e = new Error(`${method} ${url} -> ${res.status} ${err.code ?? ""} ${err.message ?? text}${detail}`);
    e.status = res.status;
    throw e;
  }
  return parsed;
}

// ---------------------------------------------------------------- manifest

async function readManifest(file) {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) die(`manifest not found: ${abs}`);
  const text = fs.readFileSync(abs, "utf8");
  if (/\.ya?ml$/i.test(abs)) {
    let yaml;
    try {
      yaml = await import("yaml");
    } catch {
      die(
        "YAML manifests need the `yaml` package (npm install yaml), or use JSON. " +
          "The repository ships projects/demo/project.json as the reference.",
      );
    }
    return yaml.parse(text);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    die(`invalid JSON in ${abs}: ${e.message}`);
  }
}

function requireProject(manifest) {
  const project = String(manifest.project ?? "").trim();
  if (!project) die("manifest.project is required");
  return project;
}

// ---------------------------------------------------------------- apply

async function upsertRole(role) {
  const key = String(role.role_key ?? "").trim();
  if (!key) die("every role needs role_key");
  let existing = null;
  try {
    existing = await api("GET", `/v1/business-roles/${encodeURIComponent(key)}`);
  } catch (e) {
    if (e.status !== 404) throw e;
  }
  const body = {
    role_key: key,
    project: role.project,
    name: role.name ?? key,
    description: role.description ?? "",
    operation_prompt: role.operation_prompt ?? "",
    required_capabilities: role.required_capabilities ?? [],
    allowed_paths: role.allowed_paths ?? [],
    workdir_template: role.workdir_template ?? null,
    enabled: role.enabled ?? true,
  };
  if (DRY) {
    console.log(`  role ${key}: would ${existing ? "update" : "create"}`);
    return existing ?? body;
  }
  const row = existing
    ? await api("PUT", `/v1/business-roles/${encodeURIComponent(key)}`, body)
    : await api("POST", "/v1/business-roles", body);
  console.log(`  role ${key}: ${existing ? "updated" : "created"}`);
  return row;
}

async function applyAssignments(assignments) {
  for (const item of assignments ?? []) {
    const instanceId = String(item.instance_id ?? "").trim();
    if (!instanceId) die("every assignment needs instance_id");
    const roles = (item.roles ?? []).map((r) =>
      typeof r === "string" ? { role_key: r } : { role_key: r.role_key, weight: r.weight },
    );
    if (DRY) {
      console.log(`  assignment ${instanceId}: would assign [${roles.map((r) => r.role_key).join(", ")}]`);
      continue;
    }
    try {
      await api("PUT", `/v1/instances/${encodeURIComponent(instanceId)}/roles`, {
        roles,
        actor: item.actor ?? "platformctl",
      });
      console.log(`  assignment ${instanceId}: [${roles.map((r) => r.role_key).join(", ")}]`);
    } catch (e) {
      // A builder that has not registered yet must not abort the whole apply:
      // the plan and roles are still useful, and the operator can re-run.
      console.error(`  assignment ${instanceId}: FAILED — ${e.message}`);
      process.exitCode = 1;
    }
  }
}

async function applyPlan(project, plan) {
  if (!plan || !Array.isArray(plan.rules)) die("manifest.plan.rules must be an array");
  const name = String(plan.name ?? `${project}-allocation`).trim();
  const existing = (await api("GET", `/v1/plans?project=${encodeURIComponent(project)}`)).items ?? [];
  const current = existing.find((p) => String(p.name) === name);

  if (DRY) {
    console.log(`  plan ${name}: would ${current ? `update v${current.version}` : "create"} and activate`);
    return null;
  }

  const document = { rules: plan.rules };
  // `text` is the operator-facing description kept next to the rules. Rules in
  // a manifest are authoritative (they pin real commands), so both are sent and
  // the explicit document wins. Editing the text in the admin app recompiles.
  const text = typeof plan.text === "string" ? plan.text : null;
  const textField = text === null ? {} : { document_text: text };
  const row = current
    ? await api("PUT", `/v1/plans/${encodeURIComponent(current.plan_id)}`, {
        project,
        name,
        document,
        ...textField,
      })
    : await api("POST", "/v1/plans", {
        project,
        name,
        document,
        ...textField,
        created_by: "platformctl",
      });
  const activated = await api("POST", `/v1/plans/${encodeURIComponent(row.plan_id)}/activate`);
  console.log(
    `  plan ${name}: ${current ? "updated" : "created"} v${activated.plan.version}, ` +
      `active, ${activated.templates.length} template(s) compiled`,
  );
  return activated.plan;
}

async function cmdApply() {
  const file = positionals[0];
  if (!file) die("usage: platformctl apply <manifest.json> [--dry-run]");
  const manifest = await readManifest(file);
  const project = requireProject(manifest);
  console.log(`[apply] ${manifest.name ?? project} -> ${BASE}${DRY ? " (dry run)" : ""}`);

  for (const role of manifest.roles ?? []) {
    await upsertRole({ project, ...role });
  }
  await applyPlan(project, manifest.plan);
  await applyAssignments(manifest.assignments);

  if (!DRY) {
    const coverage = await api("GET", `/v1/roles/coverage?project=${encodeURIComponent(project)}`);
    console.log("[coverage]");
    for (const r of coverage.items ?? []) {
      console.log(
        `  ${r.role_key.padEnd(16)} online ${r.instances_online}/${r.instances_total}` +
          `  paths ${JSON.stringify(r.allowed_paths ?? [])}`,
      );
    }
  }
  console.log("[apply] done");
}

// ---------------------------------------------------------------- submit

async function cmdSubmit() {
  const project = flags.get("project");
  if (!project) die("submit needs --project");
  const instruction = flags.get("instruction");
  if (!instruction) die("submit needs --instruction");
  const body = {
    project,
    category: flags.get("category"),
    subsystem: flags.get("subsystem"),
    instruction,
    requester: flags.get("requester") ?? process.env.USER ?? "operator",
    dry_run: DRY,
    ...(flags.get("priority") ? { priority_class: Number(flags.get("priority")) } : {}),
  };
  const out = await api("POST", "/v1/requests", body);
  console.log(JSON.stringify(out, null, 2));
  if (!DRY && out.task_id) {
    console.log(`\nWatch it with: node scripts/platformctl.mjs watch ${out.task_id}`);
  }
}

// ---------------------------------------------------------------- status

async function printCoverage(project) {
  const q = project ? `?project=${encodeURIComponent(project)}` : "";
  const coverage = await api("GET", `/v1/roles/coverage${q}`);
  console.log("role                 online/total");
  for (const r of coverage.items ?? []) {
    console.log(`  ${String(r.role_key).padEnd(18)} ${r.instances_online}/${r.instances_total}`);
  }
}

async function printInstances() {
  const out = await api("GET", "/v1/instances");
  const rows = (out.items ?? []).filter((i) => i.role_id === "builder");
  console.log("instance             state      caps");
  for (const i of rows) {
    const caps = i.capabilities?.healthy ?? [];
    console.log(`  ${String(i.instance_id).padEnd(18)} ${String(i.state).padEnd(10)} ${caps.join(",")}`);
  }
}

async function printPlans(project) {
  const q = project ? `?project=${encodeURIComponent(project)}` : "";
  const out = await api("GET", `/v1/plans${q}`);
  for (const p of out.items ?? []) {
    console.log(
      `  ${String(p.plan_id).padEnd(26)} ${String(p.project).padEnd(10)} ${String(p.status).padEnd(9)} ` +
        `v${p.version} ${p.name} (${p.rule_count} rules)`,
    );
  }
}

async function printTasks(project) {
  const out = await api("GET", "/v1/tasks?limit=50");
  const rows = (out.items ?? []).filter(
    (t) => !project || String(t.requirements?.project ?? t.project ?? "") === project,
  );
  console.log("task_id       status      business_role   type");
  for (const t of rows) {
    console.log(
      `  ${String(t.task_id).padEnd(14)} ${String(t.status).padEnd(11)} ` +
        `${String(t.business_role ?? "-").padEnd(15)} ${t.task_type}`,
    );
  }
}

async function cmdStatus() {
  const project = flags.get("project");
  console.log(`[scheduler] ${BASE}`);
  console.log("\n[instances]");
  await printInstances();
  console.log("\n[roles]");
  await printCoverage(project);
  console.log("\n[plans]");
  await printPlans(project);
  console.log("\n[recent tasks]");
  await printTasks(project);
}

// ---------------------------------------------------------------- watch

async function cmdWatch() {
  const startId = positionals[0];
  if (!startId) die("usage: platformctl watch <task_id>");
  let taskId = startId;
  let last = "";
  for (;;) {
    const task = await api("GET", `/v1/tasks/${encodeURIComponent(taskId)}`);
    const line = `${task.status} ${task.business_role ?? "-"} ${task.task_type}`;
    if (line !== last) {
      console.log(`[${new Date().toLocaleTimeString()}] ${taskId}: ${line}`);
      last = line;
    }

    if (["FAILED", "CANCELLED", "DEAD", "PARKED", "NEEDS_INPUT"].includes(task.status)) {
      const attempts = task.attempts ?? [];
      const lastAttempt = attempts[attempts.length - 1];
      if (lastAttempt?.error) console.log(`  error: ${JSON.stringify(lastAttempt.error)}`);
      const artifacts = await api("GET", `/v1/tasks/${encodeURIComponent(taskId)}/artifacts`);
      for (const a of artifacts.items ?? []) {
        console.log(` artifact ${a.artifact_id} ${a.media_type ?? ""} ${a.size_bytes ?? ""}`);
      }
      return;
    }

    const run = task.workflow_run_id
      ? await api("GET", `/v1/workflows/${encodeURIComponent(task.workflow_run_id)}`)
      : null;
    if (run) {
      if (["COMPLETED", "FAILED", "CANCELLED"].includes(run.status)) {
        console.log(`workflow ${run.status} after ${run.tasks?.length ?? "?"} task(s)`);
        return;
      }
      // A finished phase is not a finished workflow: follow the run into the
      // next phase task instead of stopping at the first SUCCEEDED.
      if (task.status === "SUCCEEDED" && run.current_task_id && run.current_task_id !== taskId) {
        taskId = run.current_task_id;
        last = "";
        continue;
      }
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

// ---------------------------------------------------------------- main

switch (command) {
  case "apply":
    await cmdApply();
    break;
  case "submit":
    await cmdSubmit();
    break;
  case "status":
    await cmdStatus();
    break;
  case "watch":
    await cmdWatch();
    break;
  case "roles":
    await printCoverage(flags.get("project"));
    break;
  case "plans":
    await printPlans(flags.get("project"));
    break;
  case "tasks":
    await printTasks(flags.get("project"));
    break;
  case "help":
  case "--help":
  case "-h":
  default:
    console.log(
      [
        "platformctl — tell the scheduler the plan",
        "",
        "  apply <manifest.json> [--dry-run]     roles, plan, assignments",
        "  submit --project P --instruction S    one request (add --category ui)",
        "  status [--project P]                  instances, coverage, plans, tasks",
        "  watch <task_id>                       follow a workflow to its end",
        "  roles | plans | tasks [--project P]",
        "",
        `  scheduler: ${BASE}  (override with --url or PLATFORM_SCHEDULER_URL)`,
      ].join("\n"),
    );
}
