CREATE TABLE agent_runs (
  id uuid PRIMARY KEY,
  trip_id uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128 AND btrim(request_id) <> ''),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  base_version integer NOT NULL,
  message text NOT NULL CHECK (length(message) BETWEEN 1 AND 4000 AND btrim(message) <> ''),
  status text NOT NULL CHECK (status IN ('running','awaiting_confirmation','succeeded','failed','interrupted')),
  lease_expires_at timestamptz,
  proposal_id uuid REFERENCES proposals(id),
  interrupt_id text CHECK (length(interrupt_id) BETWEEN 1 AND 128),
  decision boolean,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (trip_id, request_id),
  FOREIGN KEY (trip_id, base_version) REFERENCES trip_versions(trip_id, version),
  CHECK ((status = 'running') = (lease_expires_at IS NOT NULL)),
  CHECK (status <> 'awaiting_confirmation' OR (interrupt_id IS NOT NULL AND decision IS NULL)),
  CHECK (decision IS NULL OR interrupt_id IS NOT NULL)
);
CREATE UNIQUE INDEX agent_runs_one_active_trip ON agent_runs(trip_id)
  WHERE status IN ('running','awaiting_confirmation');

CREATE TABLE agent_run_events (
  run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  sequence integer NOT NULL CHECK (sequence > 0),
  event jsonb NOT NULL CHECK (jsonb_typeof(event) = 'object'),
  PRIMARY KEY (run_id, sequence)
);
