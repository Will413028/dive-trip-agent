-- Server-selected evaluation input is immutable for the logical execution.
-- Historical executions retain their original no-fault context.
ALTER TABLE planning_executions ADD COLUMN evaluation_fault text
  CHECK (evaluation_fault IS NULL OR evaluation_fault='catalog-timeout');
