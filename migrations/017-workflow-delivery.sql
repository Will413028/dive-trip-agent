-- The product commit is the durable outbox. Delivery ACKs never replace receipts.
ALTER TABLE planning_executions
  ADD COLUMN decision_delivered boolean NOT NULL DEFAULT false,
  ADD COLUMN cancellation_requested boolean NOT NULL DEFAULT false,
  ADD COLUMN cancellation_delivered boolean NOT NULL DEFAULT false,
  ADD COLUMN next_delivery_at timestamptz NOT NULL DEFAULT clock_timestamp();
CREATE INDEX planning_executions_delivery ON planning_executions(next_delivery_at,run_id)
  WHERE NOT workflow_started OR (committed_receipt IS NOT NULL AND NOT decision_delivered)
    OR (cancellation_requested AND NOT cancellation_delivered);
