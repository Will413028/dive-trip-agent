CREATE TABLE sessions (
  id uuid PRIMARY KEY,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 days')
);

CREATE TABLE trips (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  current_version integer NOT NULL CHECK (current_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 days')
);
CREATE INDEX trips_owner_id_idx ON trips(owner_id);

CREATE TABLE trip_versions (
  trip_id uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (trip_id, version)
);

-- A trip can never commit with a dangling current version.
ALTER TABLE trips ADD CONSTRAINT trips_current_version_fk
  FOREIGN KEY (id, current_version) REFERENCES trip_versions(trip_id, version)
  DEFERRABLE INITIALLY DEFERRED;
