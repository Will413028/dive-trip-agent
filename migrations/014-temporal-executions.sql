-- Additive executor boundary. Existing runs remain owned by the ADK runtime.
ALTER TABLE agent_runs ADD COLUMN executor text NOT NULL DEFAULT 'adk'
  CHECK (executor IN ('adk', 'temporal-v1'));

CREATE TABLE planning_executions (
  run_id uuid PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
  workflow_id text NOT NULL UNIQUE,
  workflow_started boolean NOT NULL DEFAULT false,
  catalog_snapshot jsonb NOT NULL CHECK (jsonb_typeof(catalog_snapshot)='array'),
  model_steps integer NOT NULL DEFAULT 0 CHECK (model_steps BETWEEN 0 AND 7),
  tool_steps integer NOT NULL DEFAULT 0 CHECK (tool_steps BETWEEN 0 AND 6),
  latest_validation_call text,
  final_call_id text,
  committed_receipt jsonb CHECK (committed_receipt IS NULL OR jsonb_typeof(committed_receipt)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- This execution journal is separate from the immutable financial model_calls ledger.
-- A started model step without a completed result is never redispatched.
CREATE TABLE planning_model_steps (
  run_id uuid NOT NULL REFERENCES planning_executions(run_id) ON DELETE CASCADE,
  activity_id text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 7),
  completed boolean NOT NULL DEFAULT false,
  arguments_rejected boolean NOT NULL DEFAULT false CHECK (NOT arguments_rejected OR completed),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (run_id, activity_id),
  UNIQUE (run_id, ordinal)
);

CREATE TABLE planning_tool_calls (
  run_id uuid NOT NULL REFERENCES planning_executions(run_id) ON DELETE CASCADE,
  call_id text NOT NULL,
  name text NOT NULL CHECK (name IN
    ('find_destinations','find_items','calculate_budget','validate_changes','propose_changes')),
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 6),
  args jsonb NOT NULL CHECK (jsonb_typeof(args)='object'),
  completed boolean NOT NULL DEFAULT false,
  result jsonb,
  validation_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (run_id,call_id),
  UNIQUE (run_id,ordinal),
  CHECK ((result IS NOT NULL)=completed),
  CHECK (validation_id IS NULL OR (name='validate_changes' AND completed))
);
