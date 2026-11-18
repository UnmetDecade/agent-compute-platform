import { q, q1, tx } from "../db.js";
import { ApiError } from "../errors.js";
import { newId } from "../ids.js";
import { createWorkflowRun, type Phase } from "../core/workflow.js";
import { compilePlanText } from "./plan-compiler.js";
import { ROLE_KEY_RE } from "./roles.js";

/**
 * Allocation plans.
 *
 * The operator tells the scheduler the plan up front; the scheduler then obeys
 * rules instead of guessing. A plan is a validated, versioned document:
 *
 *   {
 *     "rules": [
 *       { "id": "ui", "priority": 10,
 *         "match": { "category": "ui" },
 *         "role": "ui-dev",
 *         "chain": [
 *           { "role": "code-review",
 *             "build": { "command": "bash /scripts/06-review-commit.sh \"$PLATFORM_ORIGIN_TASK_ID\"",
 *                        "mode": "command" } },
 *           { "role": "test-bench",
 *             "build": { "command": "bash /scripts/test-board.sh --task \"$PLATFORM_ORIGIN_TASK_ID\"",
 *                        "mode": "command" },
 *             "capabilities": ["board:v851s"] }
 *         ] }
 *     ]
 *   }
 *
 * On activation every rule is compiled into a workflow template. A request is
 * matched deterministically (priority, specificity, declaration order), then
 * starts that workflow. The first phase runs on the rule role; each chain step
 * runs on its own role. Role -> instance selection stays in claim.ts.
 */

export interface RuleMatch {
  category?: string[];
  subsystem?: string[];
  task_type?: string[];
  path_prefix?: string[];
  keywords?: string[];
  /** Explicit fallback: matches every request. At most one per plan. */
  any?: boolean;
}

export interface BuildSpec {
  mode?: "agent" | "command";
  instruction?: string;
  command?: string;
  workdir?: string;
  timeout_seconds?: number;
  env?: Record<string, string>;
  [key: string]: unknown;
}

export interface ChainStep {
  role: string;
  phase?: string;
  build?: BuildSpec;
  capabilities?: string[];
}

export interface PlanRule {
  id: string;
  priority?: number;
  match?: RuleMatch;
  task_type?: string;
  role: string;
  build?: BuildSpec;
  capabilities?: string[];
  chain?: ChainStep[];
}

export interface PlanDocument {
  rules: PlanRule[];
}

export interface PlanInput {
  project: string;
  name: string;
  /** Rules written by hand or compiled earlier. Optional when `document_text` is given. */
  document?: PlanDocument;
  /** The operator's prose; compiled into `document` once, on save. */
  document_text?: string;
  created_by?: string;
}

/**
 * Resolve the rule document for a save: explicit rules win, otherwise the prose
 * is compiled. Either way the result is validated by the caller.
 */
async function resolveDocument(input: {
  project: string;
  document?: PlanDocument;
  document_text?: string;
}): Promise<{ document: PlanDocument; text: string }> {
  const text = String(input.document_text ?? "").trim();
  if (input.document !== undefined) return { document: input.document, text };
  if (!text) {
    throw new ApiError(400, "BAD_REQUEST", "a plan needs document_text or document.rules");
  }
  const compiled = await compilePlanText({ project: input.project, text });
  return { document: compiled.document, text };
}

export interface RequestInput {
  project: string;
  plan_id?: string;
  category?: string;
  subsystem?: string;
  task_type?: string;
  paths?: string[];
  instruction?: string;
  build?: BuildSpec;
  capabilities?: string[];
  priority_class?: 0 | 1 | 2 | 3;
  requester?: string;
  dry_run?: boolean;
}

const RULE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const MATCH_KEYS = ["category", "subsystem", "task_type", "path_prefix", "keywords"] as const;

function listOf(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.map((v) => String(v)).filter(Boolean);
  return [String(value)].filter(Boolean);
}

function asSpec(value: unknown, field: string): BuildSpec | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "PLAN_INVALID", `${field} must be an object`);
  }
  const spec = { ...(value as BuildSpec) };
  if (spec.mode !== undefined && spec.mode !== "agent" && spec.mode !== "command") {
    throw new ApiError(400, "PLAN_INVALID", `${field}.mode must be agent or command`);
  }
  if (spec.command !== undefined && typeof spec.command !== "string") {
    throw new ApiError(400, "PLAN_INVALID", `${field}.command must be a string`);
  }
  if (spec.instruction !== undefined && typeof spec.instruction !== "string") {
    throw new ApiError(400, "PLAN_INVALID", `${field}.instruction must be a string`);
  }
  return spec;
}

/** Normalize and validate a plan document; unknown roles are reported by loadRoles. */
export function normalizeDocument(raw: unknown): PlanDocument {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ApiError(400, "PLAN_INVALID", "document must be an object");
  }
  const rulesRaw = (raw as Record<string, unknown>).rules;
  if (!Array.isArray(rulesRaw) || rulesRaw.length === 0) {
    throw new ApiError(400, "PLAN_INVALID", "document.rules must be a non-empty array");
  }

  const seen = new Set<string>();
  let fallbacks = 0;
  const rules: PlanRule[] = rulesRaw.map((rawRule, index) => {
    if (!rawRule || typeof rawRule !== "object" || Array.isArray(rawRule)) {
      throw new ApiError(400, "PLAN_INVALID", `rules[${index}] must be an object`);
    }
    const r = rawRule as Record<string, unknown>;
    const id = String(r.id ?? "").trim();
    if (!RULE_ID_RE.test(id)) {
      throw new ApiError(400, "PLAN_INVALID", `rules[${index}].id must match ${RULE_ID_RE}`);
    }
    if (seen.has(id)) throw new ApiError(400, "PLAN_INVALID", `duplicate rule id: ${id}`);
    seen.add(id);

    const role = String(r.role ?? "").trim();
    if (!ROLE_KEY_RE.test(role)) {
      throw new ApiError(400, "PLAN_INVALID", `rules[${index}].role is not a valid role_key`);
    }

    const matchRaw = r.match === undefined ? {} : r.match;
    if (!matchRaw || typeof matchRaw !== "object" || Array.isArray(matchRaw)) {
      throw new ApiError(400, "PLAN_INVALID", `rules[${index}].match must be an object`);
    }
    const match: RuleMatch = {};
    for (const [key, value] of Object.entries(matchRaw as Record<string, unknown>)) {
      if (key === "any") {
        if (value === true) match.any = true;
        continue;
      }
      if (!(MATCH_KEYS as readonly string[]).includes(key)) {
        throw new ApiError(400, "PLAN_INVALID", `rules[${index}].match.${key} is not supported`);
      }
      const values = listOf(value);
      if (values.length) (match as Record<string, unknown>)[key] = values;
    }
    if (match.any) fallbacks += 1;

    const chainRaw = r.chain === undefined ? [] : r.chain;
    if (!Array.isArray(chainRaw)) {
      throw new ApiError(400, "PLAN_INVALID", `rules[${index}].chain must be an array`);
    }
    const chain: ChainStep[] = chainRaw.map((step, stepIndex) => {
      if (typeof step === "string") {
        if (!ROLE_KEY_RE.test(step)) {
          throw new ApiError(400, "PLAN_INVALID", `rules[${index}].chain[${stepIndex}] is not a role_key`);
        }
        return { role: step };
      }
      if (!step || typeof step !== "object" || Array.isArray(step)) {
        throw new ApiError(400, "PLAN_INVALID", `rules[${index}].chain[${stepIndex}] must be a role or object`);
      }
      const s = step as Record<string, unknown>;
      const stepRole = String(s.role ?? "").trim();
      if (!ROLE_KEY_RE.test(stepRole)) {
        throw new ApiError(400, "PLAN_INVALID", `rules[${index}].chain[${stepIndex}].role is not a valid role_key`);
      }
      const build = asSpec(s.build, `rules[${index}].chain[${stepIndex}].build`);
      // Each stage must state what it does. Inheriting the developer's
      // instruction into a review or test machine would make execution
      // depend on which agent happens to be bound there.
      if (!build?.command && !build?.instruction) {
        throw new ApiError(
          400,
          "PLAN_INVALID",
          `rules[${index}].chain[${stepIndex}] must define build.command or build.instruction`,
        );
      }
      return {
        role: stepRole,
        phase: s.phase === undefined ? undefined : String(s.phase),
        build,
        capabilities: s.capabilities === undefined ? undefined : listOf(s.capabilities),
      };
    });

    const taskType = r.task_type === undefined ? "task.build" : String(r.task_type);
    if (!taskType) throw new ApiError(400, "PLAN_INVALID", `rules[${index}].task_type is empty`);

    return {
      id,
      priority: Number.isFinite(Number(r.priority)) ? Number(r.priority) : 0,
      match,
      task_type: taskType,
      role,
      build: asSpec(r.build, `rules[${index}].build`),
      capabilities: r.capabilities === undefined ? undefined : listOf(r.capabilities),
      chain,
    };
  });

  if (fallbacks > 1) {
    throw new ApiError(400, "PLAN_INVALID", "at most one fallback rule (match.any) is allowed");
  }
  return { rules };
}

async function assertRolesExist(document: PlanDocument): Promise<void> {
  const keys = [
    ...new Set(
      document.rules.flatMap((r) => [r.role, ...(r.chain ?? []).map((s) => s.role)]),
    ),
  ];
  const rows = await q<{ role_key: string; enabled: boolean }>(
    `SELECT role_key, enabled FROM business_roles WHERE role_key = ANY($1::text[])`,
    [keys],
  );
  const found = new Map(rows.map((r) => [r.role_key, r.enabled]));
  const unknown = keys.filter((k) => !found.has(k));
  if (unknown.length) {
    throw new ApiError(422, "ROLE_UNKNOWN", `plan references unknown roles: ${unknown.join(", ")}`, {
      unknown,
    });
  }
  const disabled = keys.filter((k) => found.get(k) === false);
  if (disabled.length) {
    throw new ApiError(422, "ROLE_DISABLED", `plan references disabled roles: ${disabled.join(", ")}`, {
      disabled,
    });
  }

  const taskTypes = [
    ...new Set(document.rules.flatMap((r) => [r.task_type ?? "task.build"])),
  ];
  const defs = await q<{ task_type: string }>(
    `SELECT task_type FROM task_definitions WHERE task_type = ANY($1::text[])`,
    [taskTypes],
  );
  const known = new Set(defs.map((d) => d.task_type));
  const unknownTypes = taskTypes.filter((t) => !known.has(t));
  if (unknownTypes.length) {
    throw new ApiError(422, "TASK_TYPE_UNKNOWN", `plan references unknown task types: ${unknownTypes.join(", ")}`);
  }
}

/** Template id is derived, so reactivating a plan replaces the same rows. */
export function templateIdFor(planId: string, ruleId: string): string {
  return `plan.${planId}.${ruleId}`;
}

function withRolePrompt(build: BuildSpec | undefined, prompt: string | undefined): BuildSpec | undefined {
  const rolePrompt = (prompt ?? "").trim();
  if (!build || !rolePrompt) return build;
  const mode = build.mode ?? (build.command ? "command" : "agent");
  if (mode !== "agent") return build;
  const instruction = build.instruction ?? "";
  return { ...build, instruction: instruction ? `${instruction}\n\n[Role operating instructions]\n${rolePrompt}` : rolePrompt };
}

function compilePhases(rule: PlanRule, prompts: Map<string, string>): Phase[] {
  const firstReq: Record<string, unknown> = {};
  const firstBuild = withRolePrompt(rule.build, prompts.get(rule.role));
  if (firstBuild) firstReq.build = firstBuild;
  if (rule.capabilities?.length) firstReq.capabilities = rule.capabilities;
  firstReq.business_role = rule.role;

  const phases: Phase[] = [
    {
      phase: "EXECUTE",
      task_type: rule.task_type ?? "task.build",
      business_role: rule.role,
      requirements: firstReq,
    },
  ];

  (rule.chain ?? []).forEach((step, index) => {
    const requirements: Record<string, unknown> = { business_role: step.role };
    const stepBuild = withRolePrompt(step.build, prompts.get(step.role));
    if (stepBuild || step.capabilities?.length) {
      // The step's build spec replaces the previous phase build wholesale; a review
      // command must not inherit the developer's instruction.
      const build: BuildSpec = { ...(stepBuild ?? {}) };
      if (!build.mode) build.mode = build.command ? "command" : "agent";
      if (build.workdir === undefined) build.workdir = undefined;
      requirements.build = build;
    }
    if (step.capabilities?.length) requirements.capabilities = step.capabilities;
    phases.push({
      phase: step.phase ?? `STAGE_${index + 1}`,
      task_type: "task.build",
      business_role: step.role,
      requirements,
    });
  });

  return phases;
}

async function compileTemplates(
  c: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> },
  plan: { plan_id: string; name: string; version: number; document: PlanDocument },
): Promise<string[]> {
  const roleKeys = [
    ...new Set(
      plan.document.rules.flatMap((r) => [r.role, ...(r.chain ?? []).map((s) => s.role)]),
    ),
  ];
  const roleRows = await q<{ role_key: string; operation_prompt: string }>(
    `SELECT role_key, operation_prompt FROM business_roles WHERE role_key = ANY($1::text[])`,
    [roleKeys],
  );
  const prompts = new Map(roleRows.map((r) => [r.role_key, String(r.operation_prompt ?? "")]));
  const ids: string[] = [];
  for (const rule of plan.document.rules) {
    const id = templateIdFor(plan.plan_id, rule.id);
    ids.push(id);
    const phases = compilePhases(rule, prompts);
    await c.query(
      `INSERT INTO workflow_templates
         (workflow_template_id, name, version, phases)
       VALUES ($1,$2,$3,$4::jsonb)
       ON CONFLICT (workflow_template_id) DO UPDATE
         SET name = EXCLUDED.name,
             version = EXCLUDED.version,
             phases = EXCLUDED.phases`,
      [id, `${plan.name} / ${rule.id}`, String(plan.version), JSON.stringify(phases)],
    );
  }
  return ids;
}

export async function listPlans(project?: string) {
  return q(
    `SELECT plan_id, project, name, version, status, created_by, created_at, updated_at,
            jsonb_array_length(COALESCE(document->'rules', '[]'::jsonb))::int AS rule_count
       FROM allocation_plans
      WHERE ($1::text IS NULL OR project = $1)
      ORDER BY project, created_at DESC`,
    [project ?? null],
  );
}

export async function getPlan(planId: string) {
  const row = await q1(`SELECT * FROM allocation_plans WHERE plan_id = $1`, [planId]);
  if (!row) throw new ApiError(404, "PLAN_UNKNOWN", `plan not found: ${planId}`);
  return row;
}

export async function createPlan(input: PlanInput) {
  const project = String(input.project ?? "").trim();
  if (!project) throw new ApiError(400, "BAD_REQUEST", "project is required");
  const name = String(input.name ?? "").trim();
  if (!name) throw new ApiError(400, "BAD_REQUEST", "name is required");
  const resolved = await resolveDocument({ project, document: input.document, document_text: input.document_text });
  const document = normalizeDocument(resolved.document);
  await assertRolesExist(document);

  const planId = newId("plan");
  return tx(async (c) => {
    const row = (
      await c.query(
        `INSERT INTO allocation_plans
           (plan_id, project, name, version, status, document, document_text, created_by)
         VALUES ($1,$2,$3,1,'DRAFT',$4::jsonb,$5,$6)
         RETURNING *`,
        [planId, project, name, JSON.stringify(document), resolved.text, input.created_by ?? "operator"],
      )
    ).rows[0];
    return row;
  });
}

/** Editing any plan returns it to DRAFT and bumps the version; activation recompiles templates. */
export async function updatePlan(planId: string, input: Partial<PlanInput>) {
  const existing = await getPlan(planId);
  const project = input.project === undefined ? String(existing.project) : String(input.project);
  const existingText = String(existing.document_text ?? "");
  let document: PlanDocument;
  let text = existingText;
  if (input.document === undefined && input.document_text !== undefined && input.document_text.trim() !== existingText.trim()) {
    // The words changed: recompile. Unchanged text keeps the current rules, so
    // renaming a plan does not silently spend a model call.
    const resolved = await resolveDocument({ project, document_text: input.document_text });
    document = normalizeDocument(resolved.document);
    text = resolved.text;
  } else if (input.document === undefined) {
    document = normalizeDocument(existing.document);
  } else {
    document = normalizeDocument(input.document);
    text = input.document_text === undefined ? existingText : String(input.document_text);
  }
  await assertRolesExist(document);

  return tx(async (c) => {
    const row = (
      await c.query(
        `UPDATE allocation_plans
            SET project = $2,
                name = $3,
                version = version + 1,
                status = 'DRAFT',
                document = $4::jsonb,
                document_text = $5,
                updated_at = app_now()
          WHERE plan_id = $1
          RETURNING *`,
        [
          planId,
          project,
          input.name === undefined ? existing.name : String(input.name).trim() || existing.name,
          JSON.stringify(document),
          text,
        ],
      )
    ).rows[0];
    return row;
  });
}

export async function activatePlan(planId: string) {
  const plan = await getPlan(planId);
  const document = normalizeDocument(plan.document);
  await assertRolesExist(document);

  return tx(async (c) => {
    await c.query(
      `UPDATE allocation_plans
          SET status = 'DISABLED', updated_at = app_now()
        WHERE project = $1 AND status = 'ACTIVE' AND plan_id <> $2`,
      [plan.project, planId],
    );
    const row = (
      await c.query(
        `UPDATE allocation_plans
            SET status = 'ACTIVE', document = $2::jsonb, updated_at = app_now()
          WHERE plan_id = $1
          RETURNING *`,
        [planId, JSON.stringify(document)],
      )
    ).rows[0];
    const templates = await compileTemplates(c, {
      plan_id: row.plan_id,
      name: row.name,
      version: row.version,
      document,
    });
    return { plan: row, templates };
  });
}

/** Compile prose to rules without saving; the operator confirms before activating. */
export async function previewPlan(input: { project: string; document_text: string }) {
  const resolved = await resolveDocument({
    project: String(input.project ?? "").trim(),
    document_text: input.document_text,
  });
  const document = normalizeDocument(resolved.document);
  await assertRolesExist(document);
  return document;
}

export async function deactivatePlan(planId: string) {
  const row = await q1(
    `UPDATE allocation_plans SET status = 'DISABLED', updated_at = app_now()
      WHERE plan_id = $1 RETURNING *`,
    [planId],
  );
  if (!row) throw new ApiError(404, "PLAN_UNKNOWN", `plan not found: ${planId}`);
  return row;
}

export async function deletePlan(planId: string) {
  const plan = await getPlan(planId);
  if (plan.status === "ACTIVE") {
    throw new ApiError(409, "PLAN_ACTIVE", "deactivate the plan before deleting it");
  }
  for (const rule of (plan.document as PlanDocument).rules ?? []) {
    await q(`DELETE FROM workflow_templates WHERE workflow_template_id = $1`, [
      templateIdFor(planId, rule.id),
    ]);
  }
  await q(`DELETE FROM allocation_plans WHERE plan_id = $1`, [planId]);
  return { deleted: planId };
}

// ---------------------------------------------------------------- Rule matching

function containsAny(actual: string[], expected: string[]): boolean {
  const set = new Set(actual.map((v) => v.toLowerCase()));
  return expected.some((v) => set.has(v.toLowerCase()));
}

function pathMatches(actual: string[], prefixes: string[]): boolean {
  return actual.some((p) => prefixes.some((prefix) => p.startsWith(prefix)));
}

function ruleMatches(rule: PlanRule, input: RequestInput): boolean {
  const match = rule.match ?? {};
  if (match.any === true || Object.keys(match).length === 0) return true;

  const categories = listOf([input.category, input.subsystem].filter(Boolean));
  if (match.category?.length && !containsAny(categories, match.category)) return false;
  if (match.subsystem?.length && !containsAny(categories, match.subsystem)) return false;
  if (match.task_type?.length) {
    const type = input.task_type ?? "task.build";
    if (!match.task_type.some((t) => t.toLowerCase() === type.toLowerCase())) return false;
  }
  if (match.path_prefix?.length && !pathMatches(input.paths ?? [], match.path_prefix)) {
    return false;
  }
  if (match.keywords?.length) {
    const text = `${input.instruction ?? ""}`.toLowerCase();
    if (!match.keywords.some((k) => text.includes(k.toLowerCase()))) return false;
  }
  return true;
}

function specificity(rule: PlanRule): number {
  const match = rule.match ?? {};
  if (match.any) return 0;
  return Object.keys(match).filter((k) => k !== "any").length;
}

export function matchRule(document: PlanDocument, input: RequestInput): PlanRule {
  const matches = document.rules
    .map((rule, order) => ({ rule, order }))
    .filter(({ rule }) => ruleMatches(rule, input))
    .sort(
      (a, b) =>
        (Number(b.rule.priority ?? 0) - Number(a.rule.priority ?? 0)) ||
        (specificity(b.rule) - specificity(a.rule)) ||
        (a.order - b.order),
    );
  if (!matches.length) {
    throw new ApiError(422, "NO_MATCHING_RULE", "no rule in the active plan matches this request", {
      tried: document.rules.map((r) => r.id),
    });
  }
  return matches[0].rule;
}

// ---------------------------------------------------------------- Request intake

function substituteWorkdir(template: string, project: string, role: string): string {
  return template.replaceAll("{project}", project).replaceAll("{role}", role);
}

function roleRequirements(role: Record<string, unknown>, project: string) {
  const template = role.workdir_template ? String(role.workdir_template) : null;
  return {
    workdir: template ? substituteWorkdir(template, project, String(role.role_key)) : undefined,
    allowed_paths: (role.allowed_paths ?? []) as string[],
    required_capabilities: (role.required_capabilities ?? []) as string[],
  };
}

/**
 * Submit one request. Matching is deterministic; the scheduler agent may help
 * the operator author the plan, but never makes per-request routing decisions.
 */
export async function submitRequest(input: RequestInput) {
  const project = String(input.project ?? "").trim();
  if (!project) throw new ApiError(400, "BAD_REQUEST", "project is required");

  const plan = input.plan_id
    ? await getPlan(input.plan_id)
    : await q1(
        `SELECT * FROM allocation_plans WHERE project = $1 AND status = 'ACTIVE' LIMIT 1`,
        [project],
      );
  if (!plan) {
    throw new ApiError(404, "PLAN_NOT_ACTIVE", `no active allocation plan for project ${project}`);
  }
  // A dry run only answers "which rule would take this request"; the operator
  // uses it while authoring, before the plan is active. Anything that creates a
  // task must run an active plan.
  if (!input.dry_run && plan.status !== "ACTIVE") {
    throw new ApiError(409, "PLAN_NOT_ACTIVE", `plan ${plan.plan_id} is ${plan.status}; activate it first`);
  }
  if (plan.project !== project) {
    throw new ApiError(422, "PLAN_PROJECT_MISMATCH", `plan belongs to ${plan.project}, not ${project}`);
  }

  const document = normalizeDocument(plan.document);
  const rule = matchRule(document, input);
  const allRoles = [rule.role, ...(rule.chain ?? []).map((s) => s.role)];
  const roleRows = await q<Record<string, unknown>>(
    `SELECT * FROM business_roles WHERE role_key = ANY($1::text[])`,
    [allRoles],
  );
  const roleByKey = new Map(roleRows.map((r) => [String(r.role_key), r]));
  const missing = allRoles.filter((r) => !roleByKey.has(r));
  if (missing.length) {
    throw new ApiError(422, "ROLE_UNKNOWN", `plan references unknown roles: ${missing.join(", ")}`);
  }

  const firstRole = roleByKey.get(rule.role)!;
  const firstRoleReq = roleRequirements(firstRole, project);

  const instruction = String(input.instruction ?? "").trim();
  const build: BuildSpec = { ...(rule.build ?? {}), ...(input.build ?? {}) };
  if (instruction) build.instruction = instruction;
  build.mode ??= build.command ? "command" : "agent";
  if (build.workdir === undefined && firstRoleReq.workdir) build.workdir = firstRoleReq.workdir;
  if (build.workdir === undefined) {
    throw new ApiError(
      422,
      "WORKDIR_MISSING",
      `role ${rule.role} has no workdir_template and the request does not set build.workdir`,
    );
  }
  if (build.mode === "agent" && !build.instruction) {
    throw new ApiError(422, "INSTRUCTION_MISSING", "an agent build needs a non-empty instruction");
  }
  // The role's own prose is part of the instruction: the operator defined what
  // this machine does when creating the role, and the agent should know it.
  const rolePrompt = String(firstRole.operation_prompt ?? "").trim();
  if (build.mode === "agent" && rolePrompt) {
    build.instruction = `${build.instruction}\n\n[Role operating instructions]\n${rolePrompt}`;
  }
  if (build.mode === "command" && !build.command) {
    throw new ApiError(422, "COMMAND_MISSING", "a command build needs requirements.build.command");
  }

  const capabilities = [
    ...new Set([
      "code.build",
      "shell",
      ...firstRoleReq.required_capabilities,
      ...(rule.capabilities ?? []),
      ...(input.capabilities ?? []),
    ]),
  ];

  const matched = {
    plan_id: plan.plan_id,
    plan_version: plan.version,
    rule_id: rule.id,
    role: rule.role,
    chain: (rule.chain ?? []).map((s) => s.role),
  };

  if (input.dry_run) {
    return { dry_run: true, matched, build, capabilities };
  }

  const requirements: Record<string, unknown> = {
    business_role: rule.role,
    plan_id: plan.plan_id,
    rule_id: rule.id,
    project,
    requester: input.requester ?? "operator",
    allowed_paths: firstRoleReq.allowed_paths,
    capabilities,
    build,
  };

  const workflow = await createWorkflowRun({
    workflow_template_id: templateIdFor(plan.plan_id, rule.id),
    priority_class: input.priority_class ?? 1,
    requirements,
    plan_id: plan.plan_id,
  });

  return {
    matched,
    workflow_run_id: workflow.run.workflow_run_id,
    task_id: workflow.task.task_id,
    status: workflow.task.status,
    template_id: templateIdFor(plan.plan_id, rule.id),
  };
}
