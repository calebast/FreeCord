-- FreeCord PostgreSQL migration 0008: custom roles, media metadata, custom
-- emotes, attachments, and auditable voice moderation.
--
-- Media bytes are deliberately not stored in PostgreSQL. object_key identifies
-- an object in the server-configured S3-compatible bucket; clients must never
-- be allowed to choose it directly.

BEGIN;

-- Classify built-in roles without removing the existing is_default column,
-- which remains part of the compatibility contract for older application code.
ALTER TABLE roles
    ADD COLUMN IF NOT EXISTS kind VARCHAR(16) NOT NULL DEFAULT 'custom',
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;

UPDATE roles
SET kind = CASE
    WHEN kind <> 'custom' THEN kind
    WHEN is_default THEN 'default'
    WHEN lower(name) = 'owner' THEN 'owner'
    WHEN lower(name) = 'admin' THEN 'admin'
    ELSE 'custom'
END,
updated_at = COALESCE(updated_at, created_at, now());

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'roles'::regclass
          AND conname = 'roles_kind_check'
    ) THEN
        ALTER TABLE roles
            ADD CONSTRAINT roles_kind_check
            CHECK (kind IN ('owner', 'admin', 'default', 'custom'));
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'roles'::regclass
          AND conname = 'roles_default_kind_check'
    ) THEN
        ALTER TABLE roles
            ADD CONSTRAINT roles_default_kind_check
            CHECK (is_default = (kind = 'default'));
    END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS roles_owner_per_community_idx
    ON roles (community_id) WHERE kind = 'owner';
CREATE UNIQUE INDEX IF NOT EXISTS roles_admin_per_community_idx
    ON roles (community_id) WHERE kind = 'admin';
CREATE INDEX IF NOT EXISTS roles_kind_lookup_idx
    ON roles (community_id, kind, position DESC, id);

-- Keep the pre-0008 bootstrap path compatible: it inserts the owner role by
-- its reserved name before auth_bootstrap is recorded. New custom-role APIs
-- must still send an explicit kind and must reserve these built-in names.
CREATE OR REPLACE FUNCTION classify_builtin_role_on_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.is_default THEN
        NEW.kind := 'default';
    ELSIF NEW.kind = 'custom' AND lower(NEW.name) = 'owner' THEN
        NEW.kind := 'owner';
    ELSIF NEW.kind = 'custom' AND lower(NEW.name) = 'admin' THEN
        NEW.kind := 'admin';
    END IF;
    NEW.updated_at := COALESCE(NEW.updated_at, now());
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS roles_classify_builtin_insert_trigger ON roles;
CREATE TRIGGER roles_classify_builtin_insert_trigger
    BEFORE INSERT ON roles
    FOR EACH ROW EXECUTE FUNCTION classify_builtin_role_on_insert();

CREATE OR REPLACE FUNCTION protect_builtin_roles()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.kind IN ('owner', 'admin', 'default') THEN
            RAISE EXCEPTION 'built-in role % cannot be deleted', OLD.kind
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN OLD;
    END IF;

    IF OLD.kind IN ('owner', 'admin', 'default')
       AND (NEW.kind IS DISTINCT FROM OLD.kind
            OR NEW.community_id IS DISTINCT FROM OLD.community_id
            OR NEW.is_default IS DISTINCT FROM OLD.is_default) THEN
        RAISE EXCEPTION 'built-in role identity cannot be changed'
            USING ERRCODE = 'check_violation';
    END IF;
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS roles_protect_builtin_trigger ON roles;
CREATE TRIGGER roles_protect_builtin_trigger
    BEFORE UPDATE OR DELETE ON roles
    FOR EACH ROW EXECUTE FUNCTION protect_builtin_roles();

ALTER TABLE member_roles
    ADD COLUMN IF NOT EXISTS assigned_by UUID REFERENCES users(id) ON DELETE SET NULL;

-- The existing bootstrap transaction assigns the owner role immediately before
-- it records auth_bootstrap. Permit exactly that first assignment, then bind
-- the protected owner role to the recorded installation owner.
CREATE OR REPLACE FUNCTION protect_owner_role_assignment()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    bootstrap_user_id UUID;
    old_is_owner BOOLEAN := FALSE;
    new_is_owner BOOLEAN := FALSE;
BEGIN
    IF TG_OP IN ('UPDATE', 'DELETE') THEN
        SELECT EXISTS (SELECT 1 FROM roles WHERE id = OLD.role_id AND kind = 'owner')
        INTO old_is_owner;
    END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') THEN
        SELECT EXISTS (SELECT 1 FROM roles WHERE id = NEW.role_id AND kind = 'owner')
        INTO new_is_owner;
    END IF;

    IF TG_OP = 'DELETE' THEN
        IF old_is_owner THEN
            RAISE EXCEPTION 'owner role assignment is protected'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN OLD;
    END IF;

    IF TG_OP = 'UPDATE' AND old_is_owner
       AND (NEW.role_id IS DISTINCT FROM OLD.role_id OR NEW.user_id IS DISTINCT FROM OLD.user_id) THEN
        RAISE EXCEPTION 'owner role assignment is protected'
            USING ERRCODE = 'check_violation';
    END IF;

    IF NOT new_is_owner THEN
        RETURN NEW;
    END IF;

    SELECT initialized_user_id INTO bootstrap_user_id FROM auth_bootstrap LIMIT 1;
    IF TG_OP = 'INSERT' AND bootstrap_user_id IS NULL AND NOT EXISTS (
        SELECT 1
        FROM member_roles mr
        JOIN roles r ON r.id = mr.role_id
        WHERE r.kind = 'owner'
    ) THEN
        RETURN NEW;
    END IF;

    IF bootstrap_user_id IS NULL OR NEW.user_id <> bootstrap_user_id THEN
        RAISE EXCEPTION 'owner role assignment is protected'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS member_roles_protect_owner_trigger ON member_roles;
CREATE TRIGGER member_roles_protect_owner_trigger
    BEFORE INSERT OR UPDATE OF role_id, user_id OR DELETE ON member_roles
    FOR EACH ROW EXECUTE FUNCTION protect_owner_role_assignment();

INSERT INTO permissions (key, description) VALUES
    ('invites.manage', 'Create and revoke community invitations'),
    ('roles.view', 'View community roles and their permissions'),
    ('roles.manage', 'Create, update, and delete delegable roles'),
    ('roles.assign', 'Assign delegable roles to community members'),
    ('channels.text.create', 'Create text channels'),
    ('channels.voice.create', 'Create voice channels'),
    ('voice.mute', 'Force-mute voice participants'),
    ('voice.disconnect', 'Disconnect voice participants'),
    ('voice.move', 'Request that voice participants move channels'),
    ('emotes.create', 'Create community emotes'),
    ('emotes.manage', 'Update and remove community emotes'),
    ('attachments.create', 'Upload message attachments')
ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description;

-- Preserve the meaning of existing broad grants while making the new keys
-- independently assignable to custom roles.
INSERT INTO role_permissions (role_id, permission_key, granted)
SELECT rp.role_id, granular.key, TRUE
FROM role_permissions rp
CROSS JOIN LATERAL (
    SELECT unnest(CASE rp.permission_key
        WHEN 'channels.manage' THEN ARRAY['channels.text.create', 'channels.voice.create']::TEXT[]
        WHEN 'voice.moderate' THEN ARRAY['voice.mute', 'voice.disconnect', 'voice.move']::TEXT[]
        WHEN 'roles.manage' THEN ARRAY['roles.view', 'roles.assign']::TEXT[]
        ELSE ARRAY[]::TEXT[]
    END) AS key
) granular
WHERE rp.granted
  AND rp.permission_key IN ('channels.manage', 'voice.moderate', 'roles.manage')
ON CONFLICT (role_id, permission_key) DO UPDATE SET granted = EXCLUDED.granted;

-- Members who can write messages may upload an attachment for those messages.
INSERT INTO role_permissions (role_id, permission_key, granted)
SELECT role_id, 'attachments.create', TRUE
FROM role_permissions
WHERE permission_key = 'messages.write' AND granted
ON CONFLICT (role_id, permission_key) DO UPDATE SET granted = EXCLUDED.granted;

-- The installation owner receives every permission. The built-in admin is
-- seeded with delegable management permissions but cannot act as the owner.
INSERT INTO role_permissions (role_id, permission_key, granted)
SELECT r.id, p.key, TRUE
FROM roles r
CROSS JOIN permissions p
WHERE r.kind = 'owner'
ON CONFLICT (role_id, permission_key) DO UPDATE SET granted = EXCLUDED.granted;

INSERT INTO role_permissions (role_id, permission_key, granted)
SELECT r.id, p.key, TRUE
FROM roles r
JOIN permissions p ON p.key IN (
    'invites.manage', 'roles.view', 'roles.manage', 'roles.assign',
    'channels.manage', 'channels.text.create', 'channels.voice.create',
    'voice.moderate', 'voice.mute', 'voice.disconnect', 'voice.move',
    'emotes.create', 'emotes.manage', 'attachments.create'
)
WHERE r.kind = 'admin'
ON CONFLICT (role_id, permission_key) DO UPDATE SET granted = EXCLUDED.granted;

CREATE TABLE IF NOT EXISTS media_objects (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    community_id   UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    uploaded_by    UUID REFERENCES users(id) ON DELETE SET NULL,
    purpose        VARCHAR(24) NOT NULL,
    object_key     TEXT NOT NULL UNIQUE,
    state          VARCHAR(16) NOT NULL DEFAULT 'pending',
    encrypted      BOOLEAN NOT NULL,
    byte_size      BIGINT,
    sha256         BYTEA,
    content_type   VARCHAR(160),
    width          INTEGER,
    height         INTEGER,
    duration_ms    BIGINT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    ready_at       TIMESTAMPTZ,
    deleted_at     TIMESTAMPTZ,
    CONSTRAINT media_objects_purpose_check
        CHECK (purpose IN ('message', 'avatar', 'emote')),
    CONSTRAINT media_objects_state_check
        CHECK (state IN ('pending', 'ready', 'failed', 'deleted')),
    CONSTRAINT media_objects_encryption_check
        CHECK (purpose = 'message'
            OR (purpose IN ('avatar', 'emote') AND NOT encrypted)),
    CONSTRAINT media_objects_byte_size_check
        CHECK (byte_size IS NULL OR byte_size > 0),
    CONSTRAINT media_objects_sha256_check
        CHECK (sha256 IS NULL OR octet_length(sha256) = 32),
    CONSTRAINT media_objects_dimensions_check
        CHECK ((width IS NULL OR width > 0) AND (height IS NULL OR height > 0)),
    CONSTRAINT media_objects_duration_check
        CHECK (duration_ms IS NULL OR duration_ms >= 0),
    CONSTRAINT media_objects_ready_check
        CHECK ((state = 'ready' AND ready_at IS NOT NULL AND byte_size IS NOT NULL
                AND sha256 IS NOT NULL AND content_type IS NOT NULL)
            OR state <> 'ready'),
    CONSTRAINT media_objects_deleted_check
        CHECK ((state = 'deleted' AND deleted_at IS NOT NULL) OR state <> 'deleted')
);

CREATE INDEX IF NOT EXISTS media_objects_community_state_idx
    ON media_objects (community_id, state, created_at DESC);
CREATE INDEX IF NOT EXISTS media_objects_uploader_idx
    ON media_objects (uploaded_by, created_at DESC);

CREATE TABLE IF NOT EXISTS user_profiles (
    user_id          UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    avatar_media_id  UUID UNIQUE REFERENCES media_objects(id) ON DELETE SET NULL,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION enforce_profile_avatar_media()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.avatar_media_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM media_objects mo
        WHERE mo.id = NEW.avatar_media_id
          AND mo.purpose = 'avatar'
          AND mo.state = 'ready'
          AND mo.uploaded_by = NEW.user_id
    ) THEN
        RAISE EXCEPTION 'profile avatar must be a ready avatar uploaded by that user'
            USING ERRCODE = 'foreign_key_violation';
    END IF;
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS user_profiles_avatar_trigger ON user_profiles;
CREATE TRIGGER user_profiles_avatar_trigger
    BEFORE INSERT OR UPDATE OF avatar_media_id ON user_profiles
    FOR EACH ROW EXECUTE FUNCTION enforce_profile_avatar_media();

CREATE TABLE IF NOT EXISTS custom_emotes (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    community_id  UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    name          VARCHAR(48) NOT NULL,
    media_id      UUID NOT NULL UNIQUE REFERENCES media_objects(id) ON DELETE RESTRICT,
    created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at    TIMESTAMPTZ,
    CONSTRAINT custom_emotes_name_check CHECK (name ~ '^[A-Za-z0-9_]{2,48}$'),
    CONSTRAINT custom_emotes_deleted_check CHECK (deleted_at IS NULL OR deleted_at >= created_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS custom_emotes_active_name_idx
    ON custom_emotes (community_id, lower(name)) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS custom_emotes_community_idx
    ON custom_emotes (community_id, created_at, id);

CREATE OR REPLACE FUNCTION enforce_custom_emote_media()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM media_objects mo
        WHERE mo.id = NEW.media_id
          AND mo.community_id = NEW.community_id
          AND mo.purpose = 'emote'
          AND mo.state = 'ready'
    ) THEN
        RAISE EXCEPTION 'custom emote must reference ready emote media in the same community'
            USING ERRCODE = 'foreign_key_violation';
    END IF;
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS custom_emotes_media_trigger ON custom_emotes;
CREATE TRIGGER custom_emotes_media_trigger
    BEFORE INSERT OR UPDATE OF community_id, media_id, name, deleted_at ON custom_emotes
    FOR EACH ROW EXECUTE FUNCTION enforce_custom_emote_media();

-- Keep the existing emoji column and route behavior intact. A reaction now has
-- an opaque ID and exactly one of a Unicode emoji or custom emote reference.
ALTER TABLE message_reactions
    ADD COLUMN IF NOT EXISTS id UUID DEFAULT gen_random_uuid(),
    ADD COLUMN IF NOT EXISTS custom_emote_id UUID REFERENCES custom_emotes(id) ON DELETE RESTRICT;

UPDATE message_reactions SET id = gen_random_uuid() WHERE id IS NULL;
ALTER TABLE message_reactions ALTER COLUMN id SET NOT NULL;

DO $$
DECLARE
    current_primary_key TEXT;
BEGIN
    SELECT conname INTO current_primary_key
    FROM pg_constraint
    WHERE conrelid = 'message_reactions'::regclass AND contype = 'p';

    IF current_primary_key IS NOT NULL
       AND pg_get_constraintdef((
            SELECT oid FROM pg_constraint
            WHERE conrelid = 'message_reactions'::regclass AND conname = current_primary_key
       )) NOT LIKE 'PRIMARY KEY (id)%' THEN
        EXECUTE format('ALTER TABLE message_reactions DROP CONSTRAINT %I', current_primary_key);
        current_primary_key := NULL;
    END IF;

    IF current_primary_key IS NULL THEN
        ALTER TABLE message_reactions
            ADD CONSTRAINT message_reactions_pkey PRIMARY KEY (id);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'message_reactions'::regclass
          AND conname = 'message_reactions_target_check'
    ) THEN
        ALTER TABLE message_reactions
            ADD CONSTRAINT message_reactions_target_check
            CHECK ((emoji IS NOT NULL)::INTEGER + (custom_emote_id IS NOT NULL)::INTEGER = 1);
    END IF;
END;
$$;

ALTER TABLE message_reactions ALTER COLUMN emoji DROP NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'message_reactions'::regclass
          AND conname = 'message_reactions_unicode_unique'
    ) THEN
        ALTER TABLE message_reactions
            ADD CONSTRAINT message_reactions_unicode_unique
            UNIQUE (message_id, user_id, emoji);
    END IF;
END;
$$;
CREATE UNIQUE INDEX IF NOT EXISTS message_reactions_custom_unique_idx
    ON message_reactions (message_id, user_id, custom_emote_id) WHERE custom_emote_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS message_reactions_custom_emote_idx
    ON message_reactions (custom_emote_id) WHERE custom_emote_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS message_attachments (
    message_id  UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    media_id    UUID NOT NULL UNIQUE REFERENCES media_objects(id) ON DELETE RESTRICT,
    position    SMALLINT NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (message_id, media_id),
    CONSTRAINT message_attachments_position_check CHECK (position >= 0),
    CONSTRAINT message_attachments_message_position_unique UNIQUE (message_id, position)
);

CREATE OR REPLACE FUNCTION enforce_message_attachment_media()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM messages m
        JOIN channels c ON c.id = m.channel_id
        JOIN media_objects mo ON mo.id = NEW.media_id
        WHERE m.id = NEW.message_id
          AND mo.community_id = c.community_id
          AND mo.purpose = 'message'
          AND mo.state = 'ready'
    ) THEN
        RAISE EXCEPTION 'message attachment must reference ready encrypted media in the message community'
            USING ERRCODE = 'foreign_key_violation';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS message_attachments_media_trigger ON message_attachments;
CREATE TRIGGER message_attachments_media_trigger
    BEFORE INSERT OR UPDATE OF message_id, media_id ON message_attachments
    FOR EACH ROW EXECUTE FUNCTION enforce_message_attachment_media();

CREATE TABLE IF NOT EXISTS voice_participant_moderation (
    community_id             UUID NOT NULL,
    channel_id               UUID NOT NULL,
    user_id                  UUID NOT NULL,
    microphone_forced_muted  BOOLEAN NOT NULL DEFAULT FALSE,
    reconnect_blocked_until  TIMESTAMPTZ,
    updated_by               UUID,
    reason                   VARCHAR(500),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (channel_id, user_id),
    CONSTRAINT voice_participant_moderation_channel_fk
        FOREIGN KEY (community_id, channel_id)
        REFERENCES channels (community_id, id) ON DELETE CASCADE,
    CONSTRAINT voice_participant_moderation_member_fk
        FOREIGN KEY (community_id, user_id)
        REFERENCES community_members (community_id, user_id) ON DELETE CASCADE,
    CONSTRAINT voice_participant_moderation_actor_fk
        FOREIGN KEY (updated_by)
        REFERENCES users (id) ON DELETE SET NULL,
    CONSTRAINT voice_participant_moderation_reason_check
        CHECK (reason IS NULL OR length(btrim(reason)) BETWEEN 1 AND 500)
);

CREATE INDEX IF NOT EXISTS voice_participant_moderation_blocked_idx
    ON voice_participant_moderation (channel_id, reconnect_blocked_until)
    WHERE reconnect_blocked_until IS NOT NULL;

CREATE TABLE IF NOT EXISTS voice_moderation_actions (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    community_id            UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    actor_user_id           UUID NOT NULL,
    target_user_id          UUID NOT NULL,
    source_channel_id       UUID NOT NULL,
    destination_channel_id  UUID,
    action                  VARCHAR(32) NOT NULL,
    succeeded               BOOLEAN NOT NULL,
    result                  VARCHAR(500),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT voice_moderation_actions_actor_fk
        FOREIGN KEY (community_id, actor_user_id)
        REFERENCES community_members (community_id, user_id) ON DELETE RESTRICT,
    CONSTRAINT voice_moderation_actions_target_fk
        FOREIGN KEY (community_id, target_user_id)
        REFERENCES community_members (community_id, user_id) ON DELETE RESTRICT,
    CONSTRAINT voice_moderation_actions_source_fk
        FOREIGN KEY (community_id, source_channel_id)
        REFERENCES channels (community_id, id) ON DELETE RESTRICT,
    CONSTRAINT voice_moderation_actions_destination_fk
        FOREIGN KEY (community_id, destination_channel_id)
        REFERENCES channels (community_id, id) ON DELETE RESTRICT,
    CONSTRAINT voice_moderation_actions_action_check
        CHECK (action IN ('mute', 'unmute_allowed', 'disconnect', 'move_requested')),
    CONSTRAINT voice_moderation_actions_move_check
        CHECK ((action = 'move_requested' AND destination_channel_id IS NOT NULL)
            OR (action <> 'move_requested' AND destination_channel_id IS NULL)),
    CONSTRAINT voice_moderation_actions_result_check
        CHECK (result IS NULL OR length(btrim(result)) BETWEEN 1 AND 500)
);

CREATE INDEX IF NOT EXISTS voice_moderation_actions_target_idx
    ON voice_moderation_actions (community_id, target_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS voice_moderation_actions_channel_idx
    ON voice_moderation_actions (source_channel_id, created_at DESC);

CREATE OR REPLACE FUNCTION enforce_voice_moderation_channels()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM channels c
        WHERE c.id = NEW.channel_id
          AND c.community_id = NEW.community_id
          AND c.type = 'voice'
    ) THEN
        RAISE EXCEPTION 'voice moderation state must reference a voice channel'
            USING ERRCODE = 'foreign_key_violation';
    END IF;
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS voice_participant_moderation_channel_trigger ON voice_participant_moderation;
CREATE TRIGGER voice_participant_moderation_channel_trigger
    BEFORE INSERT OR UPDATE OF community_id, channel_id, microphone_forced_muted,
        reconnect_blocked_until, updated_by, reason
    ON voice_participant_moderation
    FOR EACH ROW EXECUTE FUNCTION enforce_voice_moderation_channels();

CREATE OR REPLACE FUNCTION enforce_voice_moderation_action_channels()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM channels c
        WHERE c.id = NEW.source_channel_id
          AND c.community_id = NEW.community_id
          AND c.type = 'voice'
    ) OR (
        NEW.destination_channel_id IS NOT NULL
        AND NOT EXISTS (
            SELECT 1 FROM channels c
            WHERE c.id = NEW.destination_channel_id
              AND c.community_id = NEW.community_id
              AND c.type = 'voice'
        )
    ) THEN
        RAISE EXCEPTION 'voice moderation actions must reference voice channels'
            USING ERRCODE = 'foreign_key_violation';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS voice_moderation_actions_channel_trigger ON voice_moderation_actions;
CREATE TRIGGER voice_moderation_actions_channel_trigger
    BEFORE INSERT ON voice_moderation_actions
    FOR EACH ROW EXECUTE FUNCTION enforce_voice_moderation_action_channels();

CREATE OR REPLACE FUNCTION prevent_voice_moderation_action_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'voice moderation audit rows are append-only'
        USING ERRCODE = 'check_violation';
END;
$$;

DROP TRIGGER IF EXISTS voice_moderation_actions_immutable_trigger ON voice_moderation_actions;
CREATE TRIGGER voice_moderation_actions_immutable_trigger
    BEFORE UPDATE OR DELETE ON voice_moderation_actions
    FOR EACH ROW EXECUTE FUNCTION prevent_voice_moderation_action_mutation();

INSERT INTO schema_migrations (version)
VALUES ('0008_roles_profiles_media')
ON CONFLICT (version) DO NOTHING;

COMMIT;
