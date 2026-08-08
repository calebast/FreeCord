-- FreeCord PostgreSQL migration 0001: initial single-community foundation.
-- Apply to a new database with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f database/migrations/0001_initial.sql
--
-- This migration intentionally has no legacy SQLite compatibility layer. A
-- self-hosted installation starts with a clean database and one community.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS schema_migrations (
    version        TEXT PRIMARY KEY,
    applied_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE communities (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name           VARCHAR(100) NOT NULL,
    slug           VARCHAR(100) NOT NULL,
    singleton_key  BOOLEAN NOT NULL DEFAULT TRUE,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT communities_singleton_key CHECK (singleton_key)
);

CREATE UNIQUE INDEX communities_singleton_idx ON communities (singleton_key);
CREATE UNIQUE INDEX communities_slug_idx ON communities (lower(slug));

CREATE TABLE users (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username           VARCHAR(64) NOT NULL,
    display_name       VARCHAR(100) NOT NULL,
    password_hash      TEXT NOT NULL,
    status             VARCHAR(32) NOT NULL DEFAULT 'offline',
    is_active          BOOLEAN NOT NULL DEFAULT TRUE,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT users_status_check CHECK (status IN ('online', 'away', 'busy', 'offline'))
);

CREATE UNIQUE INDEX users_username_idx ON users (lower(username));

CREATE TABLE user_sessions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    refresh_token_hash  TEXT NOT NULL,
    device_name         VARCHAR(120),
    user_agent          TEXT,
    ip_address          INET,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at          TIMESTAMPTZ NOT NULL,
    revoked_at          TIMESTAMPTZ,
    CONSTRAINT user_sessions_expiry_check CHECK (expires_at > created_at),
    CONSTRAINT user_sessions_revocation_check CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE UNIQUE INDEX user_sessions_refresh_token_idx ON user_sessions (refresh_token_hash);
CREATE INDEX user_sessions_user_active_idx ON user_sessions (user_id, expires_at)
    WHERE revoked_at IS NULL;

CREATE TABLE permissions (
    key         VARCHAR(80) PRIMARY KEY,
    description TEXT NOT NULL
);

CREATE TABLE roles (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    community_id   UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    name           VARCHAR(64) NOT NULL,
    description    TEXT NOT NULL DEFAULT '',
    position       INTEGER NOT NULL DEFAULT 0,
    is_default     BOOLEAN NOT NULL DEFAULT FALSE,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT roles_position_check CHECK (position >= 0)
);

-- The community_id column is part of this key so cross-community role
-- assignments can be rejected by a composite foreign key below.
ALTER TABLE roles
    ADD CONSTRAINT roles_community_id_id_unique UNIQUE (community_id, id);

CREATE UNIQUE INDEX roles_name_per_community_idx ON roles (community_id, lower(name));
CREATE UNIQUE INDEX roles_default_per_community_idx ON roles (community_id) WHERE is_default;

CREATE TABLE role_permissions (
    role_id        UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    permission_key VARCHAR(80) NOT NULL REFERENCES permissions(key) ON DELETE CASCADE,
    granted        BOOLEAN NOT NULL DEFAULT TRUE,
    PRIMARY KEY (role_id, permission_key)
);

CREATE TABLE community_members (
    community_id  UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    nickname      VARCHAR(100),
    joined_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    is_banned     BOOLEAN NOT NULL DEFAULT FALSE,
    banned_until  TIMESTAMPTZ,
    PRIMARY KEY (community_id, user_id),
    CONSTRAINT community_members_ban_expiry_check CHECK (NOT is_banned OR banned_until IS NULL OR banned_until > joined_at)
);

CREATE INDEX community_members_user_idx ON community_members (user_id);

CREATE TABLE member_roles (
    community_id UUID NOT NULL,
    user_id      UUID NOT NULL,
    role_id      UUID NOT NULL,
    assigned_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id, user_id, role_id),
    CONSTRAINT member_roles_member_fk
        FOREIGN KEY (community_id, user_id)
        REFERENCES community_members (community_id, user_id)
        ON DELETE CASCADE,
    -- A role may only be assigned to a member in the role's community.
    CONSTRAINT member_roles_role_fk
        FOREIGN KEY (community_id, role_id)
        REFERENCES roles (community_id, id)
        ON DELETE CASCADE
);

CREATE INDEX member_roles_role_idx ON member_roles (role_id);

CREATE TABLE channels (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    community_id  UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    name          VARCHAR(100) NOT NULL,
    type          VARCHAR(16) NOT NULL,
    position      INTEGER NOT NULL DEFAULT 0,
    is_archived   BOOLEAN NOT NULL DEFAULT FALSE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT channels_type_check CHECK (type IN ('text', 'voice')),
    CONSTRAINT channels_position_check CHECK (position >= 0)
);

-- Supports community-scoped composite foreign keys for channel ACLs and
-- LiveKit bindings, while the UUID primary key remains the public identity.
ALTER TABLE channels
    ADD CONSTRAINT channels_community_id_id_unique UNIQUE (community_id, id);

CREATE UNIQUE INDEX channels_name_per_community_idx ON channels (community_id, lower(name));
CREATE INDEX channels_order_idx ON channels (community_id, type, position, id);

-- Minimal channel ACL layer for V1. A row overrides one permission for one
-- community role on one channel. Authorization code decides the precedence
-- between this row and the role's community-wide permission.
CREATE TABLE channel_permission_overrides (
    community_id  UUID NOT NULL,
    channel_id    UUID NOT NULL,
    role_id       UUID NOT NULL,
    permission_key VARCHAR(80) NOT NULL REFERENCES permissions(key) ON DELETE CASCADE,
    granted       BOOLEAN NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (channel_id, role_id, permission_key),
    CONSTRAINT channel_permission_overrides_channel_fk
        FOREIGN KEY (community_id, channel_id)
        REFERENCES channels (community_id, id)
        ON DELETE CASCADE,
    CONSTRAINT channel_permission_overrides_role_fk
        FOREIGN KEY (community_id, role_id)
        REFERENCES roles (community_id, id)
        ON DELETE CASCADE
);

CREATE INDEX channel_permission_overrides_community_idx
    ON channel_permission_overrides (community_id, channel_id);

-- PostgreSQL CHECK constraints cannot inspect the referenced channel row, so
-- enforce that every LiveKit binding points to a voice channel in a trigger.
CREATE OR REPLACE FUNCTION enforce_voice_channel_binding_type()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM channels
        WHERE community_id = NEW.community_id
          AND id = NEW.channel_id
          AND type = 'voice'
    ) THEN
        RAISE EXCEPTION 'voice_channel_bindings.channel_id must reference a voice channel'
            USING ERRCODE = 'foreign_key_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TABLE voice_channel_bindings (
    community_id     UUID NOT NULL,
    channel_id       UUID PRIMARY KEY,
    livekit_room_id  TEXT NOT NULL UNIQUE,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT voice_channel_bindings_room_id_check CHECK (length(livekit_room_id) BETWEEN 1 AND 255),
    CONSTRAINT voice_channel_bindings_channel_fk
        FOREIGN KEY (community_id, channel_id)
        REFERENCES channels (community_id, id)
        ON DELETE CASCADE
);

CREATE TRIGGER voice_channel_bindings_type_trigger
    BEFORE INSERT OR UPDATE OF community_id, channel_id
    ON voice_channel_bindings
    FOR EACH ROW
    EXECUTE FUNCTION enforce_voice_channel_binding_type();

-- Prevent a voice channel from being changed to text while it has a binding.
CREATE OR REPLACE FUNCTION prevent_bound_channel_type_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.type <> 'voice'
       AND EXISTS (SELECT 1 FROM voice_channel_bindings WHERE channel_id = NEW.id) THEN
        RAISE EXCEPTION 'a channel with a LiveKit binding must remain a voice channel'
            USING ERRCODE = 'foreign_key_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER channels_bound_type_trigger
    BEFORE UPDATE OF type
    ON channels
    FOR EACH ROW
    WHEN (OLD.type IS DISTINCT FROM NEW.type)
    EXECUTE FUNCTION prevent_bound_channel_type_change();

-- Seed the permission vocabulary. Roles are community-scoped; permissions are
-- reusable immutable keys shared by the authorization layer.
INSERT INTO permissions (key, description) VALUES
    ('community.view', 'View the community and its visible channels'),
    ('community.manage', 'Manage community settings'),
    ('members.view', 'View community members'),
    ('members.manage', 'Manage membership and bans'),
    ('roles.manage', 'Create, update, and assign roles'),
    ('channels.view', 'View a channel'),
    ('channels.manage', 'Create, update, and archive channels'),
    ('messages.read', 'Read messages in text channels'),
    ('messages.write', 'Create messages in text channels'),
    ('messages.manage', 'Edit or delete other users messages'),
    ('voice.connect', 'Join voice channels'),
    ('voice.speak', 'Publish microphone audio in voice channels'),
    ('voice.moderate', 'Mute, move, or remove voice participants')
ON CONFLICT (key) DO NOTHING;

INSERT INTO schema_migrations (version)
VALUES ('0001_initial')
ON CONFLICT (version) DO NOTHING;

COMMIT;
