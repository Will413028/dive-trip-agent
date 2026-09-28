-- Retired ADK runs retain their original status and evidence. They no longer
-- occupy the active slot of the new writer, which never resumes ADK history.
DROP INDEX agent_runs_one_active_trip;
CREATE UNIQUE INDEX agent_runs_one_active_trip ON agent_runs(trip_id, executor)
  WHERE status IN ('running','awaiting_confirmation');
