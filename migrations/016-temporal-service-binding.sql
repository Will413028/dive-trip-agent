-- A product schema must reconnect to its original Temporal service/namespace.
-- Recreating a dev server must never silently replace existing durable history.
CREATE TABLE temporal_service_binding (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  cluster_id uuid NOT NULL,
  namespace_id uuid NOT NULL,
  namespace text NOT NULL CHECK (length(namespace) BETWEEN 1 AND 128),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
