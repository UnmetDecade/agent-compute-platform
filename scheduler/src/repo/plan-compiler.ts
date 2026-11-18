import { config } from "../config.js";
import { ApiError } from "../errors.js";
import { q } from "../db.js";
import type { PlanDocument } from "./plans.js";

/**
 * The operator writes the allocation plan as prose; the scheduler compiles it
 * once, here, into the deterministic rule document the matcher executes.
 *
 * Compilation is deliberately not part of request intake: the same request must
 * always route the same way, and the operator must be able to read (and confirm)
 * the rules that their words turned into before activating the plan. If the
 * compiler cannot produce a valid document, nothing is saved.
 */

const SYSTEM_PROMPT = `You are the "allocation plan compiler" of the Intelligent Task Scheduling System scheduler. An operator uses natural language to describe how tasks in a project should be allocated.
Your only job is to translate that description into the rule JSON that the scheduler executes.

Rule document structure:
{"rules":[{
  "id": "short identifier, unique within the plan",
  "priority": 20,
  "match": {"category":["..."], "keywords":["..."], "path_prefix":["..."], "subsystem":["..."], "task_type":["task.build"]},
  "role": "role_key of an existing business role",
  "task_type": "task.build",
  "build": {"instruction": "what to tell the executing role, optional"},
  "chain": [{"role": "role_key", "build": {"command": "shell command", "mode": "command"}}]
}]}

Hard requirements:
1. Only use the provided role_key values; do not invent roles, capabilities, or task types.
2. Write build.command only when the description explicitly provides a shell command; do not make up commands. Every chain step
   must define build, and must include at least build.instruction (one sentence stating what this step does); do not leave it empty.
3. Every dimension listed in match must match; within one dimension any single hit is enough. Keywords are used for literal
   matching against the description, so take them from the description itself where possible.
4. If the description implies an "other/default/fallback" case, you may add {"id":"fallback","priority":0,"match":{"any":true},"role":"..."};
   if there is no explicit fallback, do not add one — unmatched requests are rejected, which is safer than a wrong allocation.
5. Higher priority wins; give more specific rules a higher priority.
6. Output JSON only; no markdown code fences and no explanation.`;

interface RoleRow {
  role_key: string;
  name: string;
  description: string;
  operation_prompt: string;
  enabled: boolean;
}

interface MessagesResponse {
  content?: Array<{ type?: string; text?: string }>;
  error?: { message?: string };
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1].trim() : trimmed;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new ApiError(502, "PLAN_COMPILE_FAILED", "plan compiler did not return a JSON object");
  }
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    throw new ApiError(502, "PLAN_COMPILE_FAILED", "plan compiler returned malformed JSON");
  }
}

async function callModel(project: string, text: string, roles: RoleRow[]): Promise<unknown> {
  const { baseUrl, model, timeoutMs } = config.planCompiler;
  // Read the credential at call time so a test (or a credential rotated into the
  // process) does not depend on module-load order.
  const apiKey = (
    process.env.PLAN_COMPILER_API_KEY ??
    process.env.ANTHROPIC_API_KEY ??
    process.env.DEEPSEEK_API_KEY ??
    config.planCompiler.apiKey
  ).trim();
  if (!apiKey) {
    throw new ApiError(
      503,
      "PLAN_COMPILER_UNAVAILABLE",
      "no model credential for the plan compiler (set ANTHROPIC_API_KEY or PLAN_COMPILER_API_KEY)",
    );
  }
  const roleList = roles
    .filter((r) => r.enabled)
    .map((r) =>
      [
        `- role_key: ${r.role_key}`,
        `  name: ${r.name}`,
        r.description ? `  description: ${r.description}` : "",
        r.operation_prompt ? `  operation instructions: ${r.operation_prompt}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n");

  const user = `Project: ${project}\n\nAvailable business roles:\n${roleList || "(no available roles)"}\n\nThe operator's allocation plan:\n${text}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        temperature: 0,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: user }],
      }),
      signal: controller.signal,
    });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new ApiError(503, "PLAN_COMPILER_UNAVAILABLE", `plan compiler request failed: ${reason}`);
  } finally {
    clearTimeout(timer);
  }

  const payload = (await res.json().catch(() => ({}))) as MessagesResponse;
  if (!res.ok) {
    throw new ApiError(
      502,
      "PLAN_COMPILE_FAILED",
      `plan compiler returned ${res.status}: ${payload.error?.message ?? "unknown error"}`,
    );
  }
  const textOut = (payload.content ?? [])
    .map((part) => (part.type === "text" ? part.text ?? "" : ""))
    .join("");
  if (!textOut.trim()) {
    throw new ApiError(502, "PLAN_COMPILE_FAILED", "plan compiler returned no text");
  }
  return extractJson(textOut);
}

/** Compile prose into a candidate document. Validation happens in plans.ts. */
export async function compilePlanText(input: {
  project: string;
  text: string;
}): Promise<{ document: PlanDocument; model: string }> {
  const project = String(input.project ?? "").trim();
  const text = String(input.text ?? "").trim();
  if (!project) throw new ApiError(400, "BAD_REQUEST", "project is required");
  if (!text) throw new ApiError(400, "BAD_REQUEST", "plan text is empty");
  if (text.length > 20_000) {
    throw new ApiError(400, "BAD_REQUEST", "plan text is too long (20000 characters max)");
  }

  const roles = await q<RoleRow>(
    `SELECT role_key, name, description, operation_prompt, enabled
       FROM business_roles WHERE project = $1 OR project = '*' ORDER BY role_key`,
    [project],
  );
  if (!roles.length) {
    throw new ApiError(
      422,
      "ROLE_UNKNOWN",
      `project ${project} has no business roles; create roles before writing the plan`,
    );
  }

  const raw = await callModel(project, text, roles);
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { rules?: unknown }).rules)) {
    throw new ApiError(502, "PLAN_COMPILE_FAILED", "plan compiler returned no rules[]");
  }
  fillChainBuilds(raw as PlanDocument, new Map(roles.map((r) => [r.role_key, r])));
  return { document: raw as PlanDocument, model: config.planCompiler.model };
}

/**
 * A chain step must say what it runs (the activation validator enforces it). A
 * model sometimes emits only `{role}`; the role's own description is the
 * intended instruction in that case, so fill it rather than failing the compile.
 */
function fillChainBuilds(document: PlanDocument, roles: Map<string, RoleRow>): void {
  for (const rule of document.rules ?? []) {
    for (const step of rule.chain ?? []) {
      if (!step || typeof step !== "object") continue;
      const build = step.build ?? {};
      if (build.command || build.instruction) {
        step.build = build;
        continue;
      }
      const role = roles.get(String(step.role ?? ""));
      step.build = {
        ...build,
        instruction:
          role?.operation_prompt?.trim() ||
          `Complete this step according to the responsibilities of "${role?.name ?? step.role}".`,
      };
    }
  }
}
