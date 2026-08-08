-- FreeCord PostgreSQL migration 0002: authentication milestone.
-- Bootstrap credentials are supplied by the deployment and are never stored;
-- auth_bootstrap records only that the one-time initialization was completed.

BEGIN;

CREATE TABLE auth_bootstrap (
    singleton_key       BOOLEAN PRIMARY KEY DEFAULT TRUE,
    initialized_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    initialized_user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
    CONSTRAINT auth_bootstrap_singleton_key_check CHECK (singleton_key)
);

CREATE TABLE invites (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    created_by   UUID REFERENCES users(id) ON DELETE SET NULL,
    token_hash   TEXT NOT NULL UNIQUE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at   TIMESTAMPTZ NOT NULL,
    used_at      TIMESTAMPTZ,
    used_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    revoked_at   TIMESTAMPTZ,
    revoked_by   UUID REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT invites_expiry_check CHECK (expires_at > created_at),
    CONSTRAINT invites_used_actor_check CHECK ((used_at IS NULL) = (used_by IS NULL)),
    CONSTRAINT invites_revoked_actor_check CHECK ((revoked_at IS NULL) = (revoked_by IS NULL)),
    CONSTRAINT invites_terminal_state_check CHECK (used_at IS NULL OR revoked_at IS NULL),
    CONSTRAINT invites_used_after_creation_check CHECK (used_at IS NULL OR used_at >= created_at),
    CONSTRAINT invites_revoked_after_creation_check CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE INDEX invites_active_idx ON invites (community_id, expires_at)
    WHERE used_at IS NULL AND revoked_at IS NULL;
CREATE INDEX invites_creator_idx ON invites (created_by, created_at DESC);

CREATE OR REPLACE FUNCTION prevent_invite_reuse()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.used_at IS NOT NULL
       AND (NEW.used_at IS DISTINCT FROM OLD.used_at OR NEW.used_by IS DISTINCT FROM OLD.used_by) THEN
        RAISE EXCEPTION 'invite % has already been used', OLD.id
            USING ERRCODE = 'unique_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER invites_single_use_trigger
    BEFORE UPDATE OF used_at, used_by ON invites
    FOR EACH ROW EXECUTE FUNCTION prevent_invite_reuse();

ALTER TABLE user_sessions
    ADD COLUMN rotation_family_id UUID NOT NULL DEFAULT gen_random_uuid(),
    ADD COLUMN rotated_at TIMESTAMPTZ,
    ADD COLUMN replaced_by_session_id UUID,
    ADD COLUMN revocation_reason VARCHAR(64);

ALTER TABLE user_sessions
    ADD CONSTRAINT user_sessions_rotation_family_check
        CHECK (rotation_family_id IS NOT NULL),
    ADD CONSTRAINT user_sessions_rotated_at_check
        CHECK (rotated_at IS NULL OR rotated_at >= created_at),
    ADD CONSTRAINT user_sessions_rotation_revocation_check
        CHECK (rotated_at IS NULL OR revoked_at IS NOT NULL),
    ADD CONSTRAINT user_sessions_replacement_check
        CHECK (replaced_by_session_id IS NULL OR rotated_at IS NOT NULL),
    ADD CONSTRAINT user_sessions_revocation_reason_check
        CHECK (revocation_reason IS NULL OR length(revocation_reason) BETWEEN 1 AND 64),
    ADD CONSTRAINT user_sessions_replaced_by_fk
        FOREIGN KEY (replaced_by_session_id) REFERENCES user_sessions(id) ON DELETE SET NULL;

CREATE INDEX user_sessions_rotation_family_idx
    ON user_sessions (user_id, rotation_family_id, created_at);
CREATE INDEX user_sessions_revoked_idx
    ON user_sessions (user_id, revoked_at, expires_at);

DROP INDEX user_sessions_user_active_idx;
CREATE INDEX user_sessions_user_active_idx ON user_sessions (user_id, expires_at)
    WHERE revoked_at IS NULL AND rotated_at IS NULL;

CREATE INDEX community_members_active_idx
    ON community_members (community_id, user_id)
    WHERE NOT is_banned;
CREATE INDEX users_active_idx ON users (id) WHERE is_active;

-- A session or membership cannot be created for a disabled account. The
-- separate deactivation trigger revokes existing sessions immediately.
CREATE OR REPLACE FUNCTION enforce_active_auth_user()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    active_user BOOLEAN;
BEGIN
    SELECT is_active INTO active_user FROM users WHERE id = NEW.user_id;
    IF active_user IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION 'user % must be active for authentication or membership', NEW.user_id
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER user_sessions_active_user_trigger
    BEFORE INSERT OR UPDATE OF user_id ON user_sessions
    FOR EACH ROW EXECUTE FUNCTION enforce_active_auth_user();

CREATE TRIGGER community_members_active_user_trigger
    BEFORE INSERT OR UPDATE OF user_id ON community_members
    FOR EACH ROW EXECUTE FUNCTION enforce_active_auth_user();

CREATE OR REPLACE FUNCTION revoke_sessions_for_disabled_user()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.is_active AND NOT NEW.is_active THEN
        UPDATE user_sessions
        SET revoked_at = COALESCE(revoked_at, now()),
            revocation_reason = COALESCE(revocation_reason, 'user_disabled')
        WHERE user_id = NEW.id
          AND revoked_at IS NULL;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER users_disable_sessions_trigger
    AFTER UPDATE OF is_active ON users
    FOR EACH ROW EXECUTE FUNCTION revoke_sessions_for_disabled_user();

-- Rotation links must stay within one user and one token family.
CREATE OR REPLACE FUNCTION enforce_session_rotation_link()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    replacement RECORD;
BEGIN
    IF NEW.replaced_by_session_id IS NOT NULL THEN
        SELECT user_id, rotation_family_id, created_at
        INTO replacement
        FROM user_sessions
        WHERE id = NEW.replaced_by_session_id;
        IF NOT FOUND
           OR replacement.user_id <> NEW.user_id
           OR replacement.rotation_family_id <> NEW.rotation_family_id
           OR replacement.created_at < NEW.created_at THEN
            RAISE EXCEPTION 'session replacement must be a later session in the same rotation family'
                USING ERRCODE = 'foreign_key_violation';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER user_sessions_rotation_link_trigger
    BEFORE INSERT OR UPDATE OF user_id, rotation_family_id, replaced_by_session_id
    ON user_sessions
    FOR EACH ROW EXECUTE FUNCTION enforce_session_rotation_link();

INSERT INTO schema_migrations (version)
VALUES ('0002_authentication')
ON CONFLICT (version) DO NOTHING;

COMMIT;
