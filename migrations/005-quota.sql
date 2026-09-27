-- Product quota ledger, in USD microdollars (not trip TWD).
-- Keep receipts across calendar days and session deletion; never cascade usage away.
CREATE TABLE quota_global_lock (id integer PRIMARY KEY CHECK (id = 1));
INSERT INTO quota_global_lock VALUES (1);
CREATE TABLE quota_days (day date PRIMARY KEY);
CREATE TABLE quota_ips (ip_key text PRIMARY KEY CHECK (ip_key ~ '^[0-9a-f]{64}$'));
CREATE TABLE quota_session_days (
  owner_id uuid NOT NULL,
  day date NOT NULL,
  PRIMARY KEY (owner_id, day)
);
CREATE TABLE quota_reservations (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  ip_key text NOT NULL CHECK (ip_key ~ '^[0-9a-f]{64}$'),
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128 AND btrim(request_id) <> ''),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  day date NOT NULL,
  reserved_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  max_cost_micros bigint NOT NULL CHECK (max_cost_micros BETWEEN 1 AND 9007199254740991),
  charged_cost_micros bigint NOT NULL CHECK (charged_cost_micros BETWEEN 0 AND 9007199254740991),
  actual_cost_micros bigint CHECK (actual_cost_micros BETWEEN 0 AND 9007199254740991),
  status text NOT NULL CHECK (status IN ('reserved', 'expired', 'settled')),
  settled_at timestamptz,
  UNIQUE (owner_id, request_id),
  CHECK (expires_at > reserved_at),
  CHECK ((status = 'settled') = (settled_at IS NOT NULL)),
  CHECK (status = 'settled' OR actual_cost_micros IS NULL),
  CHECK (charged_cost_micros = COALESCE(actual_cost_micros, max_cost_micros))
);
CREATE INDEX quota_reservations_day_idx ON quota_reservations(day);
CREATE INDEX quota_reservations_ip_time_idx ON quota_reservations(ip_key, reserved_at);
CREATE INDEX quota_reservations_owner_day_idx ON quota_reservations(owner_id, day);
CREATE INDEX quota_reservations_active_idx ON quota_reservations(expires_at) WHERE status = 'reserved';
