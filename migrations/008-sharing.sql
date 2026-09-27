CREATE TABLE trip_shares (
  id uuid PRIMARY KEY,
  trip_id uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  FOREIGN KEY (trip_id,version) REFERENCES trip_versions(trip_id,version)
);
CREATE INDEX trip_shares_trip_idx ON trip_shares(trip_id);
