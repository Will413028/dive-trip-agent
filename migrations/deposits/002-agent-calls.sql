-- Settlement agent call log: the daily live-call cap and "Recorded AI result" replays.
-- Rows outlive their booking so a workspace reset cannot reset the daily cap.
CREATE TABLE deposit_agent_calls (
  id uuid PRIMARY KEY,
  booking_id uuid REFERENCES deposit_bookings ON DELETE SET NULL,
  day date NOT NULL,
  -- live: a model run counted against the cap; recorded: replay of an earlier live
  -- result for identical evidence; capped: cap reached and nothing to replay.
  mode text NOT NULL CHECK (mode IN ('live', 'recorded', 'capped')),
  status text NOT NULL CHECK (status IN ('started', 'succeeded', 'failed')),
  input_digest text NOT NULL CHECK (input_digest ~ '^[a-f0-9]{64}$'),
  model text CHECK (model IS NULL OR length(model) BETWEEN 1 AND 120),
  replay_of uuid REFERENCES deposit_agent_calls ON DELETE SET NULL,
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[A-Za-z_]{3,80}$'),
  result jsonb CHECK (result IS NULL OR (jsonb_typeof(result) = 'object'
    AND octet_length(result::text) <= 16384)),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  CHECK ((status = 'started') = (finished_at IS NULL)),
  CHECK (mode = 'live' OR status <> 'started'),
  CHECK (mode = 'recorded' OR replay_of IS NULL),
  CHECK (status <> 'succeeded' OR result IS NOT NULL)
);
CREATE INDEX deposit_agent_calls_live_day ON deposit_agent_calls (day) WHERE mode = 'live';
CREATE INDEX deposit_agent_calls_replay ON deposit_agent_calls (input_digest, created_at)
  WHERE mode = 'live' AND status = 'succeeded';

ALTER TABLE deposit_settlements
  ADD COLUMN agent_call_id uuid REFERENCES deposit_agent_calls ON DELETE SET NULL;
