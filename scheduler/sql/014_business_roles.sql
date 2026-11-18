-- 014 business roles and allocation plans
--
-- ITSS has a single execution role for workers: role_id = 'builder'.
-- This variant adds a second dimension: business roles (ui-dev, driver-dev,
-- code-review, test-bench, ...). They are configured by the operator and
-- assigned to already-registered builders at runtime. The execution role and
-- all lease/fencing semantics stay unchanged.
--
-- A task may carry business_role; claim eligibility requires the claiming
-- instance to be assigned to that role. NULL business_role keeps the old
-- behaviour (any eligible builder may claim), so existing queues are unaffected.

BEGIN;

CREATE TABLE IF NOT EXISTS business_roles (
  role_key              TEXT PRIMARY KEY,
  project               TEXT NOT NULL DEFAULT '*',
  name                  TEXT NOT NULL,
  description           TEXT NOT NULL DEFAULT '',
  -- Capabilities the machine must declare before the role can be assigned.
  -- Example: {"repo:write"} for code-review, {"board:v851s"} for test-bench.
  required_capabilities TEXT[] NOT NULL DEFAULT '{}',
  -- Informational: paths this role owns. The request builder copies them into
  -- requirements.allowed_paths for change-package collection.
  allowed_paths         TEXT[] NOT NULL DEFAULT '{}',
  -- Default task workdir for the role. {project} and {role} are substituted.
  workdir_template      TEXT,
  enabled               BOOLEAN NOT NULL DEFAULT TRUE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT app_now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT app_now()
);

CREATE INDEX IF NOT EXISTS business_roles_project_idx ON business_roles (project);

-- Operator-owned assignment of registered builders to business roles.
-- Kept separate from role_instances so re-registration never clears it.
CREATE TABLE IF NOT EXISTS instance_roles (
  instance_id TEXT NOT NULL REFERENCES role_instances(instance_id) ON DELETE CASCADE,
  role_key    TEXT NOT NULL REFERENCES business_roles(role_key) ON DELETE CASCADE,
  -- Soft preference when several assigned instances can take the same task.
  weight      INTEGER NOT NULL DEFAULT 100,
  assigned_by TEXT NOT NULL DEFAULT 'operator',
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT app_now(),
  PRIMARY KEY (instance_id, role_key)
);

CREATE INDEX IF NOT EXISTS instance_roles_role_idx ON instance_roles (role_key);

-- A plan is the operator-authored rule set the scheduler executes. The
-- document is validated on write and compiled into workflow templates on
-- activation; allocation itself stays deterministic.
CREATE TABLE IF NOT EXISTS allocation_plans (
  plan_id    TEXT PRIMARY KEY,
  project    TEXT NOT NULL,
  name       TEXT NOT NULL,
  version    INTEGER NOT NULL DEFAULT 1,
  status     TEXT NOT NULL DEFAULT 'DRAFT'
               CHECK (status IN ('DRAFT','ACTIVE','DISABLED')),
  document   JSONB NOT NULL,
  created_by TEXT NOT NULL DEFAULT 'operator',
  created_at TIMESTAMPTZ NOT NULL DEFAULT app_now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT app_now()
);

-- One active plan per project: a request has exactly one rule set to consult.
CREATE UNIQUE INDEX IF NOT EXISTS allocation_plans_one_active
  ON allocation_plans (project) WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS allocation_plans_project_idx
  ON allocation_plans (project, status);

-- Task-level allocation result. requirements still carries the full envelope;
-- the column exists so claim filtering and the console do not parse JSON.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS business_role TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS plan_id TEXT;

CREATE INDEX IF NOT EXISTS tasks_business_role_idx
  ON tasks (business_role, status);

COMMIT;
