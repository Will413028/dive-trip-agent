-- A diver joins once; each authorize command is one attempt to place the deposit hold,
-- paid either through the buyer's PayPal checkout order or the server's sandbox test
-- card. The order belongs to the attempt, so a later attempt can replace a checkout the
-- buyer never finished without touching the diver. Creating an AUTHORIZE order moves
-- no money, so a checkout attempt is stored together with its order. sent_at marks the
-- first time the command went to PayPal; only a checkout attempt that was never sent
-- may be replaced.
--
-- The earlier rows cannot say which way an authorize was paid, so refuse to guess:
-- a revision is deployed by the rebuild (deploy/deposits-demo/nightly-rebuild.sh with
-- DEMO_NEXT_REVISION), which migrates an empty database.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM deposit_money_commands) THEN
    RAISE EXCEPTION 'DEPOSIT_HOLD_ATTEMPTS_NEED_A_FRESH_DATABASE';
  END IF;
END $$;

ALTER TABLE deposit_divers DROP COLUMN order_id;

ALTER TABLE deposit_money_commands
  ADD COLUMN method text CHECK (method IN ('checkout', 'test_card')),
  ADD COLUMN order_id text CHECK (order_id ~ '^[A-Z0-9]{8,32}$'),
  ADD COLUMN sent_at timestamptz,
  ADD CONSTRAINT deposit_money_commands_method
    CHECK ((kind = 'authorize') = (method IS NOT NULL)),
  ADD CONSTRAINT deposit_money_commands_order
    CHECK (COALESCE(method = 'checkout', false) = (order_id IS NOT NULL)),
  ADD CONSTRAINT deposit_money_commands_sent
    CHECK (status IN ('pending', 'rejected') OR sent_at IS NOT NULL);
