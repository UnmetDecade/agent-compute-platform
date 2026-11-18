import { createHash } from "node:crypto";
import { q, q1, tx } from "../db.js";
import { ApiError } from "../errors.js";

/**
 * Business roles: the second role dimension used by this Intelligent Task Scheduling System variant.
 *
 * Execution roles stay scheduler | builder. Business roles (ui-dev, driver-dev,
 * code-review, test-bench, ...) are operator-defined and operator-assigned to
 * already-registered builders. No role is baked into a builder image.
 */

export const ROLE_KEY_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export interface BusinessRoleInput {
  /** Optional: the console derives one from the display name. */
  role_key?: string;
  project?: string;
  name?: string;
  description?: string;
  /** What this role does, in the operator's own words; appended to agent instructions. */
  operation_prompt?: string;
  required_capabilities?: string[];
  allowed_paths?: string[];
  workdir_template?: string | null;
  enabled?: boolean;
}

export interface InstanceRoleInput {
  role_key: string;
  weight?: number;
}

function stringList(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ApiError(400, "BAD_REQUEST", `${field} must be an array of strings`);
  }
  const out = value.map((v) => String(v).trim()).filter(Boolean);
  return [...new Set(out)];
}

function roleKey(value: unknown): string {
  const key = String(value ?? "").trim();
  if (!ROLE_KEY_RE.test(key)) {
    throw new ApiError(
      400,
      "BAD_REQUEST",
      "role_key must match [a-z0-9][a-z0-9._-]{0,63}",
    );
  }
  return key;
}

/**
 * A display name is all the console asks for. ASCII names get a readable key;
 * names that contain no ASCII letters or digits get a stable short hash instead
 * of an empty one. The operator never has to see or type this.
 */
export function deriveRoleKey(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56);
  if (slug) return slug;
  const hash = createHash("sha1").update(name).digest("hex").slice(0, 8);
  return `role-${hash}`;
}

function weightOf(value: unknown): number {
  const n = Number(value ?? 100);
  if (!Number.isFinite(n)) return 100;
  return Math.min(1000, Math.max(0, Math.trunc(n)));
}

/** Roles referenced by a plan document, in declaration order. */
export function rolesInPlan(document: unknown): string[] {
  const doc = (document ?? {}) as Record<string, unknown>;
  const rules = Array.isArray(doc.rules) ? doc.rules : [];
  const out: string[] = [];
  for (const raw of rules) {
    if (!raw || typeof raw !== "object") continue;
    const rule = raw as Record<string, unknown>;
    if (typeof rule.role === "string") out.push(rule.role);
    const chain = Array.isArray(rule.chain) ? rule.chain : [];
    for (const step of chain) {
      if (step && typeof step === "object" && typeof (step as Record<string, unknown>).role === "string") {
        out.push((step as Record<string, unknown>).role as string);
      } else if (typeof step === "string") {
        out.push(step);
      }
    }
  }
  return [...new Set(out)];
}

export async function listBusinessRoles(project?: string) {
  return q(
    `SELECT br.*,
            count(ir.instance_id)::int AS instances_total,
            count(ir.instance_id) FILTER (WHERE ri.state = 'ONLINE')::int AS instances_online
       FROM business_roles br
       LEFT JOIN instance_roles ir ON ir.role_key = br.role_key
       LEFT JOIN role_instances ri ON ri.instance_id = ir.instance_id
      WHERE ($1::text IS NULL OR br.project = $1 OR br.project = '*')
      GROUP BY br.role_key
      ORDER BY br.project, br.role_key`,
    [project ?? null],
  );
}

export async function getBusinessRole(key: string) {
  const row = await q1(`SELECT * FROM business_roles WHERE role_key = $1`, [key]);
  if (!row) throw new ApiError(404, "ROLE_UNKNOWN", `business role not found: ${key}`);
  return row;
}

export async function createBusinessRole(input: BusinessRoleInput) {
  const name = String(input.name ?? input.role_key ?? "").trim();
  if (!name) throw new ApiError(400, "BAD_REQUEST", "name is required");
  const project = String(input.project ?? "*").trim() || "*";
  const baseKey = input.role_key ? roleKey(input.role_key) : deriveRoleKey(name);
  // The console does not ask for a workdir: every container mounts the same
  // project tree, so the default is a per-role directory inside it.
  const workdir = input.workdir_template
    ? String(input.workdir_template)
    : "/work/{project}/work/{role}";

  // A derived key may already be taken (two roles with the same display name);
  // suffix it. An explicitly supplied key never does — that is a real conflict.
  const maxAttempts = input.role_key ? 1 : 20;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const key = attempt === 1 ? baseKey : `${baseKey}-${attempt}`;
    const row = await q1(
      `INSERT INTO business_roles
         (role_key, project, name, description, operation_prompt,
          required_capabilities, allowed_paths, workdir_template, enabled)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9, TRUE))
       ON CONFLICT (role_key) DO NOTHING
       RETURNING *`,
      [
        key,
        project,
        name,
        String(input.description ?? ""),
        String(input.operation_prompt ?? ""),
        stringList(input.required_capabilities, "required_capabilities"),
        stringList(input.allowed_paths, "allowed_paths"),
        workdir,
        input.enabled ?? true,
      ],
    );
    if (row) return row;
  }
  if (input.role_key) throw new ApiError(409, "ROLE_EXISTS", `business role already exists: ${baseKey}`);
  throw new ApiError(409, "ROLE_EXISTS", `could not find a free role key for ${name}`);
}

export async function updateBusinessRole(key: string, input: Partial<BusinessRoleInput>) {
  const existing = await getBusinessRole(key);
  const row = await q1(
    `UPDATE business_roles
        SET project = $2,
            name = $3,
            description = $4,
            operation_prompt = $9,
            required_capabilities = $5,
            allowed_paths = $6,
            workdir_template = $7,
            enabled = $8,
            updated_at = app_now()
      WHERE role_key = $1
      RETURNING *`,
    [
      key,
      input.project === undefined ? existing.project : String(input.project),
      input.name === undefined ? existing.name : String(input.name).trim() || existing.name,
      input.description === undefined ? existing.description : String(input.description),
      input.required_capabilities === undefined
        ? existing.required_capabilities
        : stringList(input.required_capabilities, "required_capabilities"),
      input.allowed_paths === undefined
        ? existing.allowed_paths
        : stringList(input.allowed_paths, "allowed_paths"),
      input.workdir_template === undefined
        ? existing.workdir_template
        : input.workdir_template
          ? String(input.workdir_template)
          : null,
      input.enabled === undefined ? existing.enabled : Boolean(input.enabled),
      input.operation_prompt === undefined
        ? existing.operation_prompt
        : String(input.operation_prompt),
    ],
  );
  return row;
}

/**
 * Deleting a role is refused while a plan still references it. Assignments are
 * removed by the foreign key cascade, which is what the operator expects when
 * the role itself is gone.
 */
export async function deleteBusinessRole(key: string) {
  const plans = await q<{ plan_id: string; document: unknown }>(
    `SELECT plan_id, document FROM allocation_plans WHERE status <> 'DISABLED'`,
  );
  const users = plans.filter((p) => rolesInPlan(p.document).includes(key)).map((p) => p.plan_id);
  if (users.length) {
    throw new ApiError(409, "ROLE_IN_USE", `role ${key} is referenced by plans: ${users.join(", ")}`, {
      plans: users,
    });
  }
  const row = await q1(`DELETE FROM business_roles WHERE role_key = $1 RETURNING role_key`, [key]);
  if (!row) throw new ApiError(404, "ROLE_UNKNOWN", `business role not found: ${key}`);
  return { deleted: key };
}

export async function listInstanceRoles(instanceId: string) {
  const inst = await q1(`SELECT instance_id FROM role_instances WHERE instance_id = $1`, [instanceId]);
  if (!inst) throw new ApiError(404, "INSTANCE_UNKNOWN", `instance not registered: ${instanceId}`);
  return q(
    `SELECT ir.role_key, ir.weight, ir.assigned_by, ir.assigned_at,
            br.name, br.project, br.enabled
       FROM instance_roles ir
       JOIN business_roles br USING (role_key)
      WHERE ir.instance_id = $1
      ORDER BY br.project, ir.role_key`,
    [instanceId],
  );
}

/**
 * Replace the role assignment of one builder. Operators call this from the
 * console; the builder never declares business roles itself.
 *
 * Required capabilities are checked against the instance's currently healthy
 * set. A later capability loss (e.g. a board disappears) does not silently
 * unassign the role: the claim filter also re-checks required capabilities.
 */
export async function setInstanceRoles(
  instanceId: string,
  roles: InstanceRoleInput[],
  actor = "operator",
) {
  if (!Array.isArray(roles)) throw new ApiError(400, "BAD_REQUEST", "roles must be an array");
  const normalized = roles.map((r) => ({
    role_key: roleKey(r?.role_key),
    weight: weightOf(r?.weight),
  }));
  const unique = new Map(normalized.map((r) => [r.role_key, r]));
  if (unique.size !== normalized.length) {
    throw new ApiError(400, "BAD_REQUEST", "duplicate role_key in assignment");
  }

  return tx(async (c) => {
    const inst = (
      await c.query(`SELECT * FROM role_instances WHERE instance_id = $1 FOR UPDATE`, [instanceId])
    ).rows[0];
    if (!inst) throw new ApiError(404, "INSTANCE_UNKNOWN", `instance not registered: ${instanceId}`);
    if (inst.role_id !== "builder") {
      throw new ApiError(
        422,
        "ROLE_NOT_ALLOWED",
        `only a builder can receive business roles; ${instanceId} is ${inst.role_id}`,
      );
    }

    const keys = [...unique.keys()];
    const roleRows = keys.length
      ? (
          await c.query(
            `SELECT role_key, enabled, required_capabilities
               FROM business_roles WHERE role_key = ANY($1::text[])`,
            [keys],
          )
        ).rows
      : [];
    const byKey = new Map(roleRows.map((r) => [r.role_key, r]));
    const missing = keys.filter((k) => !byKey.has(k));
    if (missing.length) {
      throw new ApiError(404, "ROLE_UNKNOWN", `unknown business roles: ${missing.join(", ")}`);
    }
    const disabled = roleRows.filter((r) => !r.enabled).map((r) => r.role_key);
    if (disabled.length) {
      throw new ApiError(422, "ROLE_DISABLED", `disabled business roles: ${disabled.join(", ")}`);
    }

    const caps = (inst.capabilities ?? {}) as { healthy?: string[]; unhealthy?: string[] };
    const usable = new Set(
      (caps.healthy ?? []).filter((x) => !(caps.unhealthy ?? []).includes(x)),
    );
    const needed = [
      ...new Set(roleRows.flatMap((r) => (r.required_capabilities ?? []) as string[])),
    ];
    const absent = needed.filter((x) => !usable.has(x));
    if (absent.length) {
      throw new ApiError(
        422,
        "CAPABILITY_MISMATCH",
        `instance ${instanceId} lacks capabilities required by the requested roles: ${absent.join(", ")}`,
        { missing: absent, healthy: [...usable] },
      );
    }

    await c.query(`DELETE FROM instance_roles WHERE instance_id = $1`, [instanceId]);
    for (const r of unique.values()) {
      await c.query(
        `INSERT INTO instance_roles (instance_id, role_key, weight, assigned_by)
         VALUES ($1,$2,$3,$4)`,
        [instanceId, r.role_key, r.weight, actor],
      );
    }

    return (
      await c.query(
        `SELECT ir.role_key, ir.weight, ir.assigned_by, ir.assigned_at,
                br.name, br.project
           FROM instance_roles ir JOIN business_roles br USING (role_key)
          WHERE ir.instance_id = $1 ORDER BY br.project, ir.role_key`,
        [instanceId],
      )
    ).rows;
  });
}

/**
 * Coverage view for the console and for plan validation: which roles exist and
 * whether at least one online builder is currently assigned.
 */
export async function roleCoverage(project?: string) {
  return q(
    `SELECT br.role_key, br.name, br.project, br.enabled,
            br.allowed_paths, br.workdir_template, br.required_capabilities,
            count(ir.instance_id)::int AS instances_total,
            count(ir.instance_id) FILTER (WHERE ri.state = 'ONLINE')::int AS instances_online
       FROM business_roles br
       LEFT JOIN instance_roles ir ON ir.role_key = br.role_key
       LEFT JOIN role_instances ri ON ri.instance_id = ir.instance_id
      WHERE ($1::text IS NULL OR br.project = $1 OR br.project = '*')
      GROUP BY br.role_key
      ORDER BY br.project, br.role_key`,
    [project ?? null],
  );
}
