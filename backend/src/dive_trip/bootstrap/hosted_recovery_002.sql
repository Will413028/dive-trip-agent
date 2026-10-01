ALTER TABLE hosted_control ADD COLUMN recovery_phase text NOT NULL DEFAULT 'serving'
  CHECK(recovery_phase IN ('serving','maintenance','reconciling'));
ALTER TABLE hosted_control ADD COLUMN recovery_initialized boolean NOT NULL DEFAULT false;
ALTER TABLE hosted_control ADD COLUMN recovery_checkpoint uuid;
ALTER TABLE hosted_control ADD COLUMN recovery_checkpoint_epoch timestamptz;
ALTER TABLE hosted_control ADD CONSTRAINT hosted_journal_capacity
  CHECK(last_sequence<=100000);
CREATE UNIQUE INDEX hosted_one_trip_delete ON hosted_recovery_journal(trip_id)
  WHERE kind='delete-trip';
CREATE UNIQUE INDEX hosted_one_share_revoke ON hosted_recovery_journal(share_id)
  WHERE kind='revoke-share';
CREATE OR REPLACE FUNCTION hosted_record_decision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ordinal bigint; phase text;
BEGIN
  SELECT recovery_phase INTO STRICT phase FROM hosted_control WHERE singleton FOR UPDATE;
  IF TG_TABLE_NAME='trips' THEN
    IF EXISTS(SELECT 1 FROM hosted_recovery_journal WHERE kind='delete-trip' AND trip_id=NEW.id) THEN
      RETURN NEW;
    END IF;
  ELSE
    IF EXISTS(SELECT 1 FROM hosted_recovery_journal WHERE kind='revoke-share' AND share_id=NEW.id AND trip_id=NEW.trip_id) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF phase='maintenance' THEN
    RAISE EXCEPTION 'HOSTED_RECOVERY_MAINTENANCE';
  END IF;
  UPDATE hosted_control SET last_sequence=last_sequence+1
    WHERE singleton RETURNING last_sequence INTO ordinal;
  IF TG_TABLE_NAME='trips' THEN
    INSERT INTO hosted_recovery_journal(sequence,kind,trip_id)
      VALUES(ordinal,'delete-trip',NEW.id);
  ELSE
    INSERT INTO hosted_recovery_journal(sequence,kind,trip_id,share_id)
      VALUES(ordinal,'revoke-share',NEW.trip_id,NEW.id);
  END IF;
  RETURN NEW;
END $$;

-- Hosted fixture execution has no model accounting. This recovery format must
-- never be used to rewind a database containing charge or invocation history.
CREATE FUNCTION hosted_reject_model_accounting() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'HOSTED_FIXTURE_MODEL_ACCOUNTING_FORBIDDEN';
END $$;
CREATE TRIGGER hosted_no_model_accounting BEFORE INSERT ON quota_reservations
  FOR EACH ROW EXECUTE FUNCTION hosted_reject_model_accounting();
CREATE TRIGGER hosted_no_model_accounting BEFORE INSERT ON quota_daily_totals
  FOR EACH ROW EXECUTE FUNCTION hosted_reject_model_accounting();
CREATE TRIGGER hosted_no_model_accounting BEFORE INSERT ON agent_invocations
  FOR EACH ROW EXECUTE FUNCTION hosted_reject_model_accounting();
CREATE TRIGGER hosted_no_model_accounting BEFORE INSERT ON model_calls
  FOR EACH ROW EXECUTE FUNCTION hosted_reject_model_accounting();
