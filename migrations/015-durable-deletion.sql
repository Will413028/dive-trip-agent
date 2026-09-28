ALTER TABLE trips ADD COLUMN deletion_requested_at timestamptz;

-- Survives content deletion; contains only a bounded operational receipt.
-- No FK cascade may remove a pending purge when an owner expires.
CREATE TABLE trip_deletion_jobs (
  trip_id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('deleting','deleted')),
  workflow_ids jsonb NOT NULL CHECK (jsonb_typeof(workflow_ids)='array'),
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts>=0),
  completed_at timestamptz,
  CHECK ((status='deleted')=(completed_at IS NOT NULL)),
  CHECK (status<>'deleted' OR workflow_ids='[]'::jsonb)
);
CREATE INDEX trip_deletion_jobs_pending ON trip_deletion_jobs(next_attempt_at,trip_id)
  WHERE status='deleting';
