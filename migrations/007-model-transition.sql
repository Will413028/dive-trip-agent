-- Preserve historical admissions and immutable 006. New runtime refuses to
-- resume old-model runs; old unknown usage remains conservatively reserved.
ALTER TABLE agent_invocations DROP CONSTRAINT agent_invocations_model_check;
ALTER TABLE agent_invocations ADD CONSTRAINT agent_invocations_model_check
  CHECK (model IN ('gemini-2.5-flash', 'gemini-3.1-flash-lite'));
