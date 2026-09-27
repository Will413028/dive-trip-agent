-- Preserve references used by intermediate operations, not only final entries.
ALTER TABLE proposals ADD COLUMN catalog_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(catalog_snapshot) = 'array');
