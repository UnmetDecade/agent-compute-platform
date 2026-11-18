import { getLiveConnection } from "./config";
import { scheduler } from "./client";

/**
 * Business roles and allocation plans: the second scheduling dimension of this
 * Intelligent Task Scheduling System variant.
 *
 * The builder never declares a business role. The operator defines roles, assigns
 * them to already-registered builders, and authors the allocation plan the
 * scheduler obeys. Everything in this module is that operator surface; it talks
 * to the scheduler's /v1 API through the PCS /api/scheduler proxy.
 */

export type BusinessRole = {
  role_key: string;
  project: string;
  name: string;
  description?: string;
  /** What this role does, in the operator's words; appended to agent instructions. */
  operation_prompt?: string;
  required_capabilities: string[];
  allowed_paths: string[];
  workdir_template: string | null;
  enabled: boolean;
  instances_total?: number;
  instances_online?: number;
  created_at?: string;
  updated_at?: string;
};

/** The console sends only what the operator typed; the scheduler derives the rest. */
export type BusinessRoleInput = {
  role_key?: string;
  project: string;
  name: string;
  description?: string;
  operation_prompt?: string;
  required_capabilities?: string[];
  allowed_paths?: string[];
  workdir_template?: string | null;
  enabled?: boolean;
};

export type InstanceRole = {
  role_key: string;
  weight: number;
  assigned_by?: string;
  assigned_at?: string;
  name?: string;
  project?: string;
  enabled?: boolean;
};

export type PlanBuildSpec = {
  mode?: "agent" | "command";
  instruction?: string;
  command?: string;
  workdir?: string;
  timeout_seconds?: number;
  env?: Record<string, string>;
  [key: string]: unknown;
};

export type PlanRuleMatch = {
  category?: string[];
  subsystem?: string[];
  task_type?: string[];
  path_prefix?: string[];
  keywords?: string[];
  /** Explicit fallback; at most one per plan. */
  any?: boolean;
};

export type PlanChainStep = {
  role: string;
  phase?: string;
  build?: PlanBuildSpec;
  capabilities?: string[];
};

export type PlanRule = {
  id: string;
  priority?: number;
  match?: PlanRuleMatch;
  task_type?: string;
  role: string;
  build?: PlanBuildSpec;
  capabilities?: string[];
  chain?: PlanChainStep[];
};

export type PlanDocument = { rules: PlanRule[] };

export type PlanStatus = "DRAFT" | "ACTIVE" | "DISABLED";

export type AllocationPlan = {
  plan_id: string;
  project: string;
  name: string;
  version: number;
  status: PlanStatus;
  document?: PlanDocument;
  /** The operator's prose, kept alongside the rules it compiled into. */
  document_text?: string;
  rule_count?: number;
  created_by?: string;
  created_at?: string;
  updated_at?: string;
};

export type RequestPreview = {
  dry_run: true;
  matched: {
    plan_id: string;
    plan_version: number;
    rule_id: string;
    role: string;
    chain: string[];
  };
  build: PlanBuildSpec;
  capabilities: string[];
};

type Rows<T> = { items?: T[] };

function list(value: string): string[] {
  return value
    .split(/[,;\s]+/)
    .map((v) => v.trim())
    .filter(Boolean);
}

/** Comma/space separated capability or path text into the array the API takes. */
export const splitList = list;

export async function fetchBusinessRoles(): Promise<BusinessRole[]> {
  const out = await scheduler<Rows<BusinessRole>>(getLiveConnection(), "/v1/business-roles");
  return (out.items ?? []).map(normalizeRole);
}

function normalizeRole(row: BusinessRole): BusinessRole {
  return {
    ...row,
    required_capabilities: Array.isArray(row.required_capabilities) ? row.required_capabilities : [],
    allowed_paths: Array.isArray(row.allowed_paths) ? row.allowed_paths : [],
    operation_prompt: row.operation_prompt ?? "",
    workdir_template: row.workdir_template ?? null,
    enabled: row.enabled !== false,
    instances_total: Number(row.instances_total ?? 0),
    instances_online: Number(row.instances_online ?? 0),
  };
}

export async function createBusinessRole(input: BusinessRoleInput): Promise<BusinessRole> {
  const out = await scheduler<BusinessRole>(getLiveConnection(), "/v1/business-roles", {
    method: "POST",
    body: input,
  });
  return normalizeRole(out);
}

export async function updateBusinessRole(
  roleKey: string,
  input: Omit<BusinessRoleInput, "role_key">,
): Promise<BusinessRole> {
  const out = await scheduler<BusinessRole>(
    getLiveConnection(),
    `/v1/business-roles/${encodeURIComponent(roleKey)}`,
    { method: "PUT", body: input },
  );
  return normalizeRole(out);
}

export async function deleteBusinessRole(roleKey: string): Promise<void> {
  await scheduler(getLiveConnection(), `/v1/business-roles/${encodeURIComponent(roleKey)}`, {
    method: "DELETE",
  });
}

export async function fetchInstanceRoles(instanceId: string): Promise<InstanceRole[]> {
  const out = await scheduler<Rows<InstanceRole>>(
    getLiveConnection(),
    `/v1/instances/${encodeURIComponent(instanceId)}/roles`,
  );
  return (out.items ?? []).map((r) => ({ ...r, weight: Number(r.weight ?? 100) }));
}

/**
 * Replace one builder's assignment. The scheduler checks the role's required
 * capabilities against the builder's healthy set, so a board role cannot be
 * assigned to a machine that lacks the board.
 */
export async function setInstanceRoles(
  instanceId: string,
  roles: Array<{ role_key: string; weight?: number }>,
  actor: string,
): Promise<InstanceRole[]> {
  const out = await scheduler<Rows<InstanceRole>>(
    getLiveConnection(),
    `/v1/instances/${encodeURIComponent(instanceId)}/roles`,
    { method: "PUT", body: { roles, actor } },
  );
  return (out.items ?? []).map((r) => ({ ...r, weight: Number(r.weight ?? 100) }));
}

export async function fetchPlans(project?: string): Promise<AllocationPlan[]> {
  const query = project ? `?project=${encodeURIComponent(project)}` : "";
  const out = await scheduler<Rows<AllocationPlan>>(getLiveConnection(), `/v1/plans${query}`);
  return out.items ?? [];
}

export async function fetchPlan(planId: string): Promise<AllocationPlan> {
  return scheduler<AllocationPlan>(
    getLiveConnection(),
    `/v1/plans/${encodeURIComponent(planId)}`,
  );
}

export type PlanInput = {
  project: string;
  name: string;
  /** Prose the scheduler compiles on save. */
  document_text?: string;
  /** Raw rules, for the CLI or an advanced edit. */
  document?: PlanDocument;
};

export async function createPlan(input: PlanInput): Promise<AllocationPlan> {
  return scheduler<AllocationPlan>(getLiveConnection(), "/v1/plans", {
    method: "POST",
    body: input,
  });
}

export async function updatePlan(
  planId: string,
  input: Partial<PlanInput>,
): Promise<AllocationPlan> {
  return scheduler<AllocationPlan>(getLiveConnection(), `/v1/plans/${encodeURIComponent(planId)}`, {
    method: "PUT",
    body: input,
  });
}

/** Compile prose without saving, so the operator can read the rules first. */
export async function compilePlan(input: {
  project: string;
  document_text: string;
}): Promise<PlanDocument> {
  return scheduler<PlanDocument>(getLiveConnection(), "/v1/plans/compile", {
    method: "POST",
    body: input,
  });
}

/** Activation compiles one workflow template per rule; editing a plan returns it to DRAFT. */
export async function activatePlan(
  planId: string,
): Promise<{ plan: AllocationPlan; templates: string[] }> {
  return scheduler(getLiveConnection(), `/v1/plans/${encodeURIComponent(planId)}/activate`, {
    method: "POST",
  });
}

export async function deactivatePlan(planId: string): Promise<AllocationPlan> {
  return scheduler<AllocationPlan>(
    getLiveConnection(),
    `/v1/plans/${encodeURIComponent(planId)}/deactivate`,
    { method: "POST" },
  );
}

export async function deletePlan(planId: string): Promise<void> {
  await scheduler(getLiveConnection(), `/v1/plans/${encodeURIComponent(planId)}`, {
    method: "DELETE",
  });
}

/**
 * Ask the scheduler which rule would take a request, without creating a task.
 * This is the operator-facing check that the plan's rules say what they meant.
 */
export async function previewRequest(input: {
  project: string;
  plan_id?: string;
  category?: string;
  instruction?: string;
  paths?: string[];
}): Promise<RequestPreview> {
  return scheduler<RequestPreview>(getLiveConnection(), "/v1/requests", {
    method: "POST",
    body: { ...input, dry_run: true },
  });
}

/** Parse the plan editor's JSON; throws with a readable message so the dialog can show it inline. */
export function parsePlanDocument(text: string): PlanDocument {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    throw new Error(`JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("JSON: document must be an object with a rules array");
  }
  const rules = (value as PlanDocument).rules;
  if (!Array.isArray(rules) || rules.length === 0) {
    throw new Error("JSON: document.rules must be a non-empty array");
  }
  return value as PlanDocument;
}

/** Compact rule summary for the plan list and the editor preview. */
export function summarizeRule(rule: PlanRule): {
  match: string;
  chain: string[];
} {
  const match = rule.match ?? {};
  const parts: string[] = [];
  if (match.any) parts.push("any");
  for (const key of ["category", "subsystem", "task_type", "path_prefix", "keywords"] as const) {
    const values = match[key];
    if (values?.length) parts.push(`${key}=${values.join("|")}`);
  }
  return {
    match: parts.length ? parts.join(" · ") : "any",
    chain: [rule.role, ...(rule.chain ?? []).map((s) => (typeof s === "string" ? s : s.role))],
  };
}

/** Editor placeholder: a plan the operator can adapt rather than an empty textarea. */
export const PLAN_EXAMPLE: PlanDocument = {
  rules: [
    {
      id: "ui",
      priority: 20,
      match: { category: ["ui"], keywords: ["ui", "interface", "button"] },
      role: "ui-dev",
      chain: [
        {
          role: "code-review",
          build: { mode: "command", command: 'bash /scripts/apply-changes.sh "$PLATFORM_ORIGIN_TASK_ID"' },
        },
        {
          role: "test-bench",
          build: { mode: "command", command: 'bash /scripts/run-tests.sh "$PLATFORM_ORIGIN_TASK_ID"' },
        },
      ],
    },
    {
      id: "fallback",
      priority: 0,
      match: { any: true },
      role: "driver-dev",
    },
  ],
};
