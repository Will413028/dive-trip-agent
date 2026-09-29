-- Private, bounded diagnostic for a rejected model step. Historical rows stay NULL.
ALTER TABLE planning_model_steps ADD COLUMN argument_diagnostic jsonb
  CHECK (
    argument_diagnostic IS NULL OR (
      arguments_rejected AND completed
      AND jsonb_typeof(argument_diagnostic) = 'object'
      AND octet_length(argument_diagnostic::text) <= 2048
    )
  );
