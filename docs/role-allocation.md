# Role-based allocation

The Agent Compute Platform (ACP) keeps its execution model — scheduler, builder, leases, fencing,
artifacts, workflows — and replaces "dispatch by task type" with **allocation by
business role**. The operator defines the roles, assigns them to registered
builders, and publishes a plan. The scheduler then routes each request by those
rules. It never infers a destination per request.

The operator writes two pieces of plain language: what each role does and how to
do it, and the **allocation plan** as a whole ("which requests go to whom, then
to whom after that"). When the plan is saved, the scheduler compiles that prose
**once** into deterministic rules and stores them. Every later request matches
against the stored rules. No model call happens per request; the compiled rules
are shown for confirmation before activation.

Chinese: [role-allocation.zh-CN.md](role-allocation.zh-CN.md)

## Two role dimensions

| Dimension | Values | Who decides |
| --- | --- | --- |
| Execution role | `scheduler`, `builder` | the platform image / instance config |
| Business role | `ui-dev`, `driver-dev`, `code-review`, `test-bench`, … | the operator, at runtime |

A builder container starts with `ROLE_ID=builder` and a capability set only.
Business roles are rows in PostgreSQL (`business_roles`) plus assignments
(`instance_roles`). Nothing about "ui" or "driver" is baked into an image, so the
same image serves every project.

Capabilities remain the physical facts: `repo:write` says the machine may write
the canonical tree, `board:v851s` says a board is attached. A business role
declares the capabilities it requires; an assignment is refused when the builder
does not currently report them.

## Data model

```sql
business_roles   (role_key PK, project, name, description, operation_prompt,
                  required_capabilities[], allowed_paths[], workdir_template, enabled)
instance_roles   (instance_id → role_instances, role_key → business_roles,
                  weight, assigned_by, assigned_at)          -- operator assignment
allocation_plans (plan_id PK, project, name, version,
                  status DRAFT|ACTIVE|DISABLED, document jsonb, document_text)
tasks            (…, business_role, plan_id)
```

`operation_prompt` is the operator's natural-language note on how the role works.
Creating a role only needs project, display name, description and that note; the
scheduler derives `role_key` from the name (a hash suffix for non-ASCII names),
defaults the workdir to `/work/{project}/work/{role}`, and leaves capabilities
and allowed paths empty. The API/manifest can still set those fields explicitly
when finer control is needed.

`document_text` keeps the operator's words; `document` holds the compiled rules.
The words are for re-editing and auditing; the rules are what runs.

One plan may be `ACTIVE` per project. Activating a plan compiles every rule into
a `workflow_templates` row (`plan.<plan_id>.<rule_id>`), so a request starts the
same workflow state machine that any other ACP workflow uses.

## Plan document

```jsonc
{
  "rules": [
    {
      "id": "ui",                       // unique within the plan
      "priority": 20,                   // higher wins
      "match": {                        // all listed dimensions must match
        "category": ["ui"],
        "keywords": ["settings", "page"], // any keyword matches (keywords may be in any language)
        "path_prefix": ["ui/"],
        "subsystem": ["middle"],
        "task_type": ["task.build"]
      },
      "role": "ui-dev",                 // first stage role
      "build": {
        "instruction": "Fix the reported UI problem.",
        "prepare_command": "bash /scripts/sync-worktree.sh",
        "post_command": "bash /scripts/collect-changes.sh",
        "timeout_seconds": 1800
      },
      "capabilities": ["repo:read"],
      "chain": [                        // later stages, each with its own role
        { "role": "code-review",
          "build": { "command": "bash /scripts/apply-changes.sh", "mode": "command" } },
        { "role": "test-bench",
          "build": { "command": "bash /scripts/run-tests.sh", "mode": "command" },
          "capabilities": ["board:v851s"] }
      ]
    },
    { "id": "fallback", "priority": 0, "match": { "any": true }, "role": "ui-dev", "chain": [] }
  ]
}
```

Matching is deterministic: **priority desc → specificity desc (number of match
dimensions) → declaration order**. At most one `match.any` rule is allowed. A
request with no matching rule is rejected (`NO_RULE_MATCHED`), never guessed at.

Validation happens at create/activate time: roles must exist and be enabled,
task types must exist, rule ids must be unique, every chain step must define
`build.command` or `build.instruction`.

### Prose plans: compiled once, on save

The operator does not have to write the JSON above. The plan page is a single
text box: say which requests go to whom, what follows, and what should be
refused. **Save** compiles once and stores the rules with the prose document
(the API still offers `POST /v1/plans/compile` for a preview without saving):

```
POST /v1/plans/compile {project, document_text}
        │
        ▼
compiler (Anthropic-compatible /v1/messages)
        │  may only use existing role_keys; never invents shell commands
        ▼
rule document ──► the same validation ──► save document + document_text (DRAFT)
        │
        └─ operator reads "the rules the scheduler will run", then activates
```

- **Compilation happens only on save.** A request always matches the
  stored rules, so routing is reproducible; changing the plan means saving and
  reactivating it.
- The compiled output must pass the same validation. On any failure (model
  unavailable, no roles, invalid rules) **nothing is saved**.
- If the model emits a chain step with only a role and no `build`, the step's
  instruction is filled from that role's `operation_prompt` instead of failing.
- Compiler configuration: `PLAN_COMPILER_BASE_URL` (falls back to
  `ANTHROPIC_BASE_URL`), `PLAN_COMPILER_API_KEY` (falls back to
  `ANTHROPIC_API_KEY` / `DEEPSEEK_API_KEY`), `PLAN_COMPILER_MODEL` (default
  `deepseek-chat`). Without a credential the compile endpoint returns
  `PLAN_COMPILER_UNAVAILABLE`; already-compiled plans keep working.
- The JSON (`document`) API and `platformctl apply` still work and can be mixed.

The role's `operation_prompt` is appended at **runtime** to the agent
instruction, so "how to do the work" lives with the role, not the plan:

```
Fix the settings page crash

[Role operating instructions]
Only edit files under ui/. Sync the worktree first, run the repo's smoke script
when done, and describe the UI behavior you changed.
```

## Request flow

```
POST /v1/requests {project, category, instruction}
        │  match the active plan
        ▼
create workflow run ──► phase 1 task (business_role = rule.role)
        │                  build.workdir defaults to the role's workdir_template
        │                  capabilities = code.build, shell + role + rule + request
        ▼
claim: instance must be assigned to the task's business_role
        │  (weight orders candidates; role capabilities re-checked)
        │  folder exclusion: workdir held by another live lease blocks (WORKDIR_IN_USE)
        ▼
EXECUTE on ui-dev ──► STAGE_1 on code-review ──► STAGE_2 on test-bench
```

### The scheduler owns folder exclusion

Every builder mounts the same `/work`, so two agents editing one directory tread
on each other. Builders do not decide this locally; every claim asks the
scheduler, which knows the `requirements.build.workdir` of all live leases and
compares them by exact, parent and child prefixes. On overlap the claim is
refused and the task records:

- `resource_block_reason = WORKDIR_IN_USE`
- detail: the folder, the holder's task/instance/role, and a message naming the
  folder and saying it cannot be allocated right now.

The blocked task retries under the normal backoff. Once the holder finishes (or
its lease expires) the folder is free. This is a **task-level** block: the same
instance can still claim a task whose workdir is elsewhere.

Each next phase derives its capabilities, `allowed_paths` and default workdir
from *its own* role, not from the developer's. `PLATFORM_ORIGIN_TASK_ID` and
`PLATFORM_BUSINESS_ROLE` are exported to every stage command so scripts can
address the original task.

## Deterministic stage hooks

An agent stage may declare `prepare_command` and `post_command` next to
`instruction`. They run through `/bin/sh -lc` in the same directory as the agent:

- `prepare_command` runs **before** attachments and upstream artifacts are
  materialized (a worktree sync may safely delete the directory contents);
- `post_command` runs **after** the agent and before declared outputs upload;
- a non-zero exit fails the attempt (`STAGE_PREPARE_FAILED` /
  `STAGE_POST_FAILED`) and follows the normal retry policy.

The agent's working directory is `requirements.build.workdir` when set, and the
attempt workspace stays its `HOME`/`TMPDIR`, so CLI state never lands in the
project tree. `BUILDER_PROJECT_ROOTS` lists the container paths a workdir may
point at; anything else is rejected (`BUILD_WORKDIR_INVALID`).

## Operating it

```bash
scripts/roles.sh up                     # Postgres + scheduler + PCS + admin app + 4 generic builders
node scripts/platformctl.mjs apply projects/demo/project.json
node scripts/platformctl.mjs submit --project demo --category ui --instruction "fix the settings page"
node scripts/platformctl.mjs watch <task_id>
node scripts/platformctl.mjs status --project demo
```

When `up` finishes, the admin app is at `http://127.0.0.1:18080` (`UI_PORT`). The
first `up` generates an administrator (`PCS_ADMIN_USER`, default `admin`) and a
random password in `deploy/.env.roles`. The app reaches the scheduler through
PCS's `/api/scheduler` proxy; the browser only ever holds a PCS session cookie:

- **Business roles**: creating a role takes four fields — project, display name,
  description and **operation notes** — a plain-language box telling that role's
  agent how to work. The scheduler fills in `role_key`, the default workdir,
  capabilities and allowed paths. The list shows each role's notes; assignment
  to builders (with weights) and the "no online machine" coverage warning live
  here too;
- **Plans**: the whole plan is one plain-language text box. **Save** compiles it
  once and the dialog shows "the rules the scheduler will run"
  (match → first role → chain); activate when they look right. Scripts can still
  preview (`POST /v1/plans/compile`) and dry-run a request
  (`POST /v1/requests {dry_run:true}`), which creates no task.

The CLI and the API remain available and change the same state.

The manifest is the operator's plan in one file: `roles`, `plan.rules`, and
`assignments` (which registered instance plays which role). `plan.text` is an
optional human-readable description stored alongside the rules; `plan.rules`
stays authoritative in a manifest (the demo uses it to pin real commands), and
editing the text in the admin app recompiles on save. `platformctl apply`
is idempotent: roles are updated in place, the plan is versioned and reactivated,
assignments are replaced.

Role assignment is also a plain API:

```
POST   /v1/business-roles              PUT /v1/business-roles/:key
PUT    /v1/instances/:id/roles         {roles:[{role_key,weight}]}
GET    /v1/roles/coverage              which roles have online machines
POST   /v1/plans                       PUT /v1/plans/:id
POST   /v1/plans/compile               compile prose into rules (does not save)
POST   /v1/plans/:id/activate          compiles workflow templates
POST   /v1/requests                    match + start workflow
GET    /v1/tasks?business_role=ui-dev
```

## Project tree convention

`deploy/compose.roles.yaml` mounts one directory at `/work` in every builder:

```
/work/<project>/
  repo/            canonical tree; review applies change packages here
  snapshots/       optional baselines
  work/<role>/     per-role work trees (agent cwd)
  changes/         change packages: <origin>.patch / .tar.gz / .json
  artifacts/       test logs and board output
```

The lifecycle scripts under `scripts/platform/` implement the handoff:
`sync-worktree.sh`, `collect-changes.sh`, `apply-changes.sh`, `run-tests.sh`.
They are generic; project-specific behavior belongs in `projects/<name>/test.sh`
and `projects/<name>/review.sh`.

## Limits and deliberate omissions

- A prose plan needs one model call at save time. Without a credential the
  scheduler accepts JSON rules only (or import rules compiled elsewhere). The
  compiler's quality depends on the model, so the UI always shows the compiled
  rules; confirm them before activating.
- Folder exclusion covers every task that claims through the scheduler and
  compares `workdir` path prefixes. It does not stop an agent from touching
  directories its instruction names but that are not its workdir; express those
  limits through the role's `allowed_paths`.
- The change-package handoff assumes the builders share `/work` (single host).
  Across hosts, use the existing artifact channel (`upstream_artifacts`) in a
  plan stage that uploads the patch; a dedicated stage is a plan change, not a
  code change.
- Compiled chains are all EXECUTE stages; there is no implicit APPROVE gate.
  A plan that needs a human gate should be authored as a workflow template with
  an APPROVE phase and started by `POST /v1/workflows`.
- The admin app covers roles, assignment and plans; editing workflow templates and
  approval gates still lives in the existing design docs. The API and
  `platformctl` remain supported alongside it.
