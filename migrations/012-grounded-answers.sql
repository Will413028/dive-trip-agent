-- Existing runs retain their historical contract and are never resumed or
-- reclassified as grounded successes. New writers must explicitly opt into v1.
ALTER TABLE agent_runs ADD COLUMN answer_contract_version integer NOT NULL DEFAULT 0
  CHECK (answer_contract_version IN (0, 1));
-- Bind the public proposal reference to the authenticated native gate, without
-- copying private ADK state or keeping a second proposal payload.
ALTER TABLE agent_runs ADD COLUMN proposal_tool_call_id text
  CHECK (length(proposal_tool_call_id) BETWEEN 1 AND 128);

-- Rejection does not create a trip version. Freeze the observed version in the
-- decision transaction; NULL on historical rows is intentionally not backfilled.
ALTER TABLE proposals ADD COLUMN rejection_version integer
  CHECK (rejection_version IS NULL OR (rejection_version > 0 AND status = 'rejected'));

CREATE UNIQUE INDEX agent_run_answer_identity ON agent_run_events
  (run_id, (event->'value'->>'answerId'))
  WHERE event->>'type' = 'CUSTOM' AND event->>'name' = 'dive_trip.answer.v1';
