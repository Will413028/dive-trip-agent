CREATE TABLE hosted_control (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  instance_id uuid NOT NULL DEFAULT gen_random_uuid(),
  last_sequence bigint NOT NULL DEFAULT 0 CHECK(last_sequence >= 0)
);
INSERT INTO hosted_control(singleton) VALUES(true);
CREATE TABLE hosted_recovery_journal (
  sequence bigint PRIMARY KEY,
  kind text NOT NULL CHECK(kind IN ('delete-trip','revoke-share')),
  trip_id uuid NOT NULL,
  share_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK((kind='delete-trip' AND share_id IS NULL)
    OR (kind='revoke-share' AND share_id IS NOT NULL))
);
CREATE FUNCTION hosted_recovery_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'HOSTED_RECOVERY_IMMUTABLE';
END $$;
CREATE TRIGGER hosted_recovery_no_update_delete
  BEFORE UPDATE OR DELETE ON hosted_recovery_journal
  FOR EACH ROW EXECUTE FUNCTION hosted_recovery_immutable();
CREATE TRIGGER hosted_recovery_no_truncate
  BEFORE TRUNCATE ON hosted_recovery_journal
  FOR EACH STATEMENT EXECUTE FUNCTION hosted_recovery_immutable();
CREATE FUNCTION hosted_record_decision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ordinal bigint;
BEGIN
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
CREATE TRIGGER hosted_delete_decision AFTER UPDATE OF deletion_requested_at ON trips
  FOR EACH ROW WHEN(OLD.deletion_requested_at IS NULL AND NEW.deletion_requested_at IS NOT NULL)
  EXECUTE FUNCTION hosted_record_decision();
CREATE TRIGGER hosted_revoke_decision AFTER UPDATE OF revoked_at ON trip_shares
  FOR EACH ROW WHEN(OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL)
  EXECUTE FUNCTION hosted_record_decision();
CREATE TABLE hosted_ingress_nonces (
  nonce text PRIMARY KEY CHECK(nonce ~ '^[a-f0-9]{32}$'),
  expires_at timestamptz NOT NULL
);
CREATE TABLE hosted_ip_windows (
  client_hash text NOT NULL,
  minute bigint NOT NULL,
  count integer NOT NULL CHECK(count > 0),
  PRIMARY KEY(client_hash,minute)
);
CREATE TABLE hosted_limits (
  singleton boolean PRIMARY KEY CHECK(singleton),
  global_per_minute integer NOT NULL CHECK(global_per_minute BETWEEN 1 AND 10000),
  client_per_minute integer NOT NULL CHECK(client_per_minute BETWEEN 1 AND global_per_minute),
  sessions integer NOT NULL CHECK(sessions BETWEEN 1 AND 10000),
  trips integer NOT NULL CHECK(trips BETWEEN 1 AND 10000),
  owner_trips integer NOT NULL CHECK(owner_trips BETWEEN 1 AND trips)
);
CREATE FUNCTION hosted_capacity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE limits hosted_limits%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(724931,1);
  SELECT * INTO STRICT limits FROM hosted_limits WHERE singleton;
  IF TG_TABLE_NAME='sessions' THEN
    IF (SELECT count(*) FROM sessions)>=limits.sessions THEN
      RAISE EXCEPTION 'HOSTED_CAPACITY_REACHED';
    END IF;
  ELSE
    IF (SELECT count(*) FROM trips)>=limits.trips
       OR (SELECT count(*) FROM trips WHERE owner_id=NEW.owner_id)>=limits.owner_trips THEN
      RAISE EXCEPTION 'HOSTED_CAPACITY_REACHED';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hosted_session_capacity BEFORE INSERT ON sessions
  FOR EACH ROW EXECUTE FUNCTION hosted_capacity_guard();
CREATE TRIGGER hosted_trip_capacity BEFORE INSERT ON trips
  FOR EACH ROW EXECUTE FUNCTION hosted_capacity_guard();
