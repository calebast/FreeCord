-- FreeCord PostgreSQL migration 0009: community audit events and permission.
--
-- Audit metadata is intentionally a small JSON object. Application code must
-- not place secrets, message envelopes, file contents, or invite tokens in it.

BEGIN;

CREATE TABLE IF NOT EXISTS audit_events (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    community_id   UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    -- Keep the historical actor UUID even if that account is later removed.
    -- The insert trigger below validates membership without making deletion
    -- mutate an append-only row through an ON DELETE foreign-key action.
    actor_user_id  UUID,
    action         VARCHAR(80) NOT NULL,
    target_type    VARCHAR(40),
    target_id      UUID,
    metadata       JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT audit_events_action_check
        CHECK (action ~ '^[a-z][a-z0-9_.-]{0,79}$'),
    CONSTRAINT audit_events_target_check
        CHECK ((target_type IS NULL) = (target_id IS NULL)),
    CONSTRAINT audit_events_target_type_check
        CHECK (target_type IS NULL OR target_type ~ '^[a-z][a-z0-9_.-]{0,39}$'),
    CONSTRAINT audit_events_metadata_check
        CHECK (
            jsonb_typeof(metadata) = 'object'
            AND octet_length(metadata::TEXT) <= 16384
        )
);

-- Supports stable keyset pagination with:
--   WHERE community_id = $1
--     AND (created_at, id) < ($2, $3)
--   ORDER BY created_at DESC, id DESC
CREATE INDEX IF NOT EXISTS audit_events_community_cursor_idx
    ON audit_events (community_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS audit_events_actor_cursor_idx
    ON audit_events (community_id, actor_user_id, created_at DESC, id DESC)
    WHERE actor_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS audit_events_action_cursor_idx
    ON audit_events (community_id, action, created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION enforce_audit_event_actor()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.actor_user_id IS NOT NULL AND NOT EXISTS (
        SELECT 1
        FROM community_members cm
        WHERE cm.community_id = NEW.community_id
          AND cm.user_id = NEW.actor_user_id
    ) THEN
        RAISE EXCEPTION 'audit event actor must be a member of the event community'
            USING ERRCODE = 'foreign_key_violation';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS audit_events_actor_trigger ON audit_events;
CREATE TRIGGER audit_events_actor_trigger
    BEFORE INSERT ON audit_events
    FOR EACH ROW EXECUTE FUNCTION enforce_audit_event_actor();

CREATE OR REPLACE FUNCTION prevent_audit_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'audit events are append-only'
        USING ERRCODE = 'check_violation';
END;
$$;

DROP TRIGGER IF EXISTS audit_events_immutable_trigger ON audit_events;
CREATE TRIGGER audit_events_immutable_trigger
    BEFORE UPDATE OR DELETE ON audit_events
    FOR EACH ROW EXECUTE FUNCTION prevent_audit_event_mutation();

DROP TRIGGER IF EXISTS audit_events_no_truncate_trigger ON audit_events;
CREATE TRIGGER audit_events_no_truncate_trigger
    BEFORE TRUNCATE ON audit_events
    FOR EACH STATEMENT EXECUTE FUNCTION prevent_audit_event_mutation();

INSERT INTO permissions (key, description)
VALUES ('audit.view', 'View the community audit log')
ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description;

INSERT INTO role_permissions (role_id, permission_key, granted)
SELECT r.id, 'audit.view', TRUE
FROM roles r
WHERE r.kind IN ('owner', 'admin')
ON CONFLICT (role_id, permission_key) DO UPDATE SET granted = EXCLUDED.granted;

INSERT INTO schema_migrations (version)
VALUES ('0009_audit_events')
ON CONFLICT (version) DO NOTHING;

COMMIT;
