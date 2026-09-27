CREATE TABLE proposals (
  id uuid PRIMARY KEY,
  trip_id uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  base_version integer NOT NULL,
  draft jsonb NOT NULL CHECK (jsonb_typeof(draft) = 'object'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'rejected', 'stale')),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (trip_id, base_version) REFERENCES trip_versions(trip_id, version)
);
CREATE INDEX proposals_trip_id_idx ON proposals(trip_id);

CREATE TABLE mutation_receipts (
  owner_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  operation text NOT NULL CHECK (operation IN ('apply', 'restore')),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  trip_id uuid REFERENCES trips(id) ON DELETE CASCADE,
  response jsonb CHECK (jsonb_typeof(response) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, request_id)
);
