-- Additive provider binding. Existing Gemini rows and their historical model
-- identifiers remain valid; a run cannot mix provider/model bindings.
ALTER TABLE agent_invocations DROP CONSTRAINT agent_invocations_provider_check;
ALTER TABLE agent_invocations ADD CONSTRAINT agent_invocations_provider_check
  CHECK (provider IN ('gemini', 'openrouter'));
ALTER TABLE agent_invocations DROP CONSTRAINT agent_invocations_model_check;
ALTER TABLE agent_invocations ADD CONSTRAINT agent_invocations_model_check CHECK (
  (provider = 'gemini' AND model IN ('gemini-2.5-flash', 'gemini-3.1-flash-lite'))
  OR (provider = 'openrouter' AND model ~ '^[a-z0-9-]+/[a-z0-9._-]+:free$')
);

-- Provider-specific generation/cost evidence is private accounting only. It
-- intentionally excludes prompts, responses, credentials, IPs and headers.
ALTER TABLE model_calls ADD COLUMN provider_evidence jsonb
  CHECK (provider_evidence IS NULL OR jsonb_typeof(provider_evidence) = 'object');
