-- 005 remains immutable. Session quota counts logical runs; IP limits still
-- count each provider invocation, including a confirmation continuation.
ALTER TABLE quota_reservations ADD COLUMN logical_run_id uuid;
CREATE INDEX quota_reservations_logical_idx ON quota_reservations(owner_id,day,logical_run_id);

CREATE TABLE agent_invocations (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES agent_runs(id),
  reservation_id uuid NOT NULL UNIQUE REFERENCES quota_reservations(id),
  kind text NOT NULL CHECK (kind IN ('start','resume')),
  provider text NOT NULL CHECK (provider='gemini'),
  model text NOT NULL CHECK (model='gemini-2.5-flash'),
  max_cost_micros bigint NOT NULL CHECK (max_cost_micros BETWEEN 1 AND 9007199254740991),
  status text NOT NULL CHECK (status IN ('active','expired','settled')),
  prior_model_calls integer NOT NULL CHECK (prior_model_calls BETWEEN 0 AND 7),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (run_id,kind)
);
CREATE UNIQUE INDEX agent_invocations_one_active ON agent_invocations(run_id) WHERE status='active';

-- No prompt, API key, raw provider payload or generated text belongs here.
CREATE TABLE model_calls (
  invocation_id uuid NOT NULL REFERENCES agent_invocations(id),
  run_id uuid NOT NULL REFERENCES agent_runs(id),
  call_id text NOT NULL CHECK (length(call_id) BETWEEN 1 AND 128 AND btrim(call_id) <> ''),
  status text NOT NULL CHECK (status IN ('started','completed')),
  usage jsonb CHECK (usage IS NULL OR jsonb_typeof(usage)='object'),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  PRIMARY KEY (invocation_id,call_id),
  UNIQUE (run_id,call_id),
  CHECK ((status='completed')=(completed_at IS NOT NULL)),
  CHECK (status='completed' OR usage IS NULL)
);
