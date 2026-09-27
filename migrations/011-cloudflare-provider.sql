-- Additive binding only: never rewrite old model calls, evidence or quotas.
ALTER TABLE agent_invocations ADD COLUMN account_id text;
ALTER TABLE agent_invocations ADD CONSTRAINT agent_invocations_account_check CHECK (
  (provider = 'cloudflare' AND account_id IS NOT NULL AND length(account_id) = 32 AND account_id ~ '^[a-f0-9]{32}$')
  OR (provider <> 'cloudflare' AND account_id IS NULL)
);
ALTER TABLE agent_invocations DROP CONSTRAINT agent_invocations_provider_check;
ALTER TABLE agent_invocations ADD CONSTRAINT agent_invocations_provider_check
  CHECK (provider IN ('gemini', 'openrouter', 'cloudflare'));
ALTER TABLE agent_invocations DROP CONSTRAINT agent_invocations_model_check;
ALTER TABLE agent_invocations ADD CONSTRAINT agent_invocations_model_check CHECK (
  (provider = 'gemini' AND model IN ('gemini-2.5-flash', 'gemini-3.1-flash-lite'))
  OR (provider = 'openrouter' AND model ~ '^[a-z0-9-]+/[a-z0-9._-]+:free$')
  OR (provider = 'cloudflare' AND model = '@cf/google/gemma-4-26b-a4b-it')
);
