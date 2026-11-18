-- 015 natural-language role descriptions and allocation plans
--
-- The operator describes a role's work in plain language instead of filling in
-- capabilities/paths/workdir. `operation_prompt` is appended to every agent
-- instruction the role executes, so the description reaches the agent itself.
--
-- An allocation plan may also be authored as prose. `document_text` keeps the
-- operator's words; `document` holds the rules the plan compiler derived from
-- them. Matching stays deterministic — compilation happens once, when the plan
-- is saved/activated, never per request.

BEGIN;

ALTER TABLE business_roles ADD COLUMN IF NOT EXISTS operation_prompt TEXT NOT NULL DEFAULT '';

ALTER TABLE allocation_plans ADD COLUMN IF NOT EXISTS document_text TEXT NOT NULL DEFAULT '';

COMMIT;
