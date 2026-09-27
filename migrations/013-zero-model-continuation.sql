-- Native confirmation receipts reserve capacity without authorizing model cost.
-- Preserve historical positive reservations/invocations and immutable receipts.
ALTER TABLE quota_reservations DROP CONSTRAINT quota_reservations_max_cost_micros_check;
ALTER TABLE quota_reservations ADD CONSTRAINT quota_reservations_max_cost_micros_check
  CHECK (max_cost_micros BETWEEN 0 AND 9007199254740991);

ALTER TABLE agent_invocations DROP CONSTRAINT agent_invocations_max_cost_micros_check;
ALTER TABLE agent_invocations ADD CONSTRAINT agent_invocations_max_cost_micros_check
  CHECK (max_cost_micros BETWEEN 0 AND 9007199254740991);
ALTER TABLE agent_invocations ADD CONSTRAINT agent_invocations_zero_cost_resume_check
  CHECK (max_cost_micros > 0 OR kind = 'resume');
