-- Group trip deposits (PayPal sandbox demo). Amounts are USD minor units.
CREATE TABLE deposit_bookings (
  id uuid PRIMARY KEY,
  workspace_hash text NOT NULL CHECK (workspace_hash ~ '^[a-f0-9]{64}$'),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  starts_on date NOT NULL,
  trip_days int NOT NULL CHECK (trip_days BETWEEN 1 AND 14),
  site_lat numeric(8,5) NOT NULL CHECK (site_lat BETWEEN -90 AND 90),
  site_lon numeric(8,5) NOT NULL CHECK (site_lon BETWEEN -180 AND 180),
  deposit_minor int NOT NULL CHECK (deposit_minor > 0),
  policy jsonb NOT NULL CHECK (jsonb_typeof(policy) = 'object'),
  mandate jsonb NOT NULL CHECK (jsonb_typeof(mandate) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX deposit_bookings_workspace ON deposit_bookings (workspace_hash);

-- The policy and mandate a booking was created with never change.
CREATE FUNCTION deposit_bookings_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.policy IS DISTINCT FROM OLD.policy OR NEW.mandate IS DISTINCT FROM OLD.mandate
     OR NEW.deposit_minor <> OLD.deposit_minor OR NEW.trip_days <> OLD.trip_days THEN
    RAISE EXCEPTION 'DEPOSIT_BOOKING_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER deposit_bookings_immutable BEFORE UPDATE ON deposit_bookings
  FOR EACH ROW EXECUTE FUNCTION deposit_bookings_immutable();

CREATE TABLE deposit_divers (
  id uuid PRIMARY KEY,
  booking_id uuid NOT NULL REFERENCES deposit_bookings ON DELETE CASCADE,
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 60),
  seeded boolean NOT NULL,
  state text NOT NULL CHECK (state IN ('pending', 'authorized', 'captured', 'voided')),
  order_id text,
  authorization_id text,
  authorization_expires_at timestamptz,
  capture_id text,
  authorized_minor int NOT NULL DEFAULT 0 CHECK (authorized_minor >= 0),
  captured_minor int NOT NULL DEFAULT 0 CHECK (captured_minor >= 0),
  refunded_minor int NOT NULL DEFAULT 0 CHECK (refunded_minor BETWEEN 0 AND captured_minor),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (booking_id, display_name),
  CHECK (state = 'pending' OR authorization_id IS NOT NULL),
  CHECK (state <> 'captured' OR capture_id IS NOT NULL)
);

CREATE TABLE deposit_settlements (
  id uuid PRIMARY KEY,
  booking_id uuid NOT NULL REFERENCES deposit_bookings ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('ai', 'no_ai', 'organizer')),
  facts jsonb NOT NULL CHECK (jsonb_typeof(facts) = 'object'),
  plan jsonb NOT NULL CHECK (jsonb_typeof(plan) = 'array'),
  within_mandate boolean NOT NULL,
  reasons jsonb NOT NULL CHECK (jsonb_typeof(reasons) = 'array'),
  status text NOT NULL CHECK (status IN ('proposed', 'approved', 'rejected', 'executed')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  decided_at timestamptz,
  CHECK ((status = 'proposed') = (decided_at IS NULL))
);

-- Every PayPal write is stored before it is sent; the request id makes retries safe.
CREATE TABLE deposit_money_commands (
  id uuid PRIMARY KEY,
  booking_id uuid NOT NULL REFERENCES deposit_bookings ON DELETE CASCADE,
  diver_id uuid NOT NULL REFERENCES deposit_divers ON DELETE CASCADE,
  settlement_id uuid REFERENCES deposit_settlements ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('authorize', 'capture', 'void', 'refund')),
  amount_minor int NOT NULL CHECK (amount_minor >= 0),
  final_capture boolean NOT NULL DEFAULT false,
  request_id text NOT NULL UNIQUE CHECK (length(request_id) BETWEEN 8 AND 108),
  invoice_id text NOT NULL UNIQUE CHECK (length(invoice_id) BETWEEN 8 AND 127),
  status text NOT NULL CHECK (status IN ('pending', 'succeeded', 'rejected', 'unknown')),
  attempts int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  error_code text,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  CHECK ((status IN ('succeeded', 'rejected')) = (completed_at IS NOT NULL))
);
-- At most one live (non-rejected) command of each kind per diver and settlement.
CREATE UNIQUE INDEX deposit_money_commands_once ON deposit_money_commands
  (diver_id, kind, COALESCE(settlement_id, '00000000-0000-0000-0000-000000000000'))
  WHERE status <> 'rejected';

-- Cancellation evidence the settlement cites: operator notices, alerts, forecasts,
-- and clearly labelled simulated storms. Evidence is data, never instructions.
CREATE TABLE deposit_evidence (
  id uuid PRIMARY KEY,
  booking_id uuid NOT NULL REFERENCES deposit_bookings ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('notice', 'alert', 'forecast', 'simulated')),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  data jsonb CHECK (data IS NULL OR (jsonb_typeof(data) = 'object'
    AND octet_length(data::text) <= 32768)),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Append-only audit timeline; rows are removed only with their booking.
CREATE TABLE deposit_timeline (
  id bigserial PRIMARY KEY,
  booking_id uuid NOT NULL REFERENCES deposit_bookings ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind ~ '^[a-z_]{3,40}$'),
  detail jsonb NOT NULL CHECK (jsonb_typeof(detail) = 'object'
    AND octet_length(detail::text) <= 8192),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION deposit_timeline_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'DEPOSIT_TIMELINE_APPEND_ONLY';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER deposit_timeline_append_only BEFORE UPDATE ON deposit_timeline
  FOR EACH ROW EXECUTE FUNCTION deposit_timeline_append_only();
