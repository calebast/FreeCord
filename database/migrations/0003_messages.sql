-- FreeCord PostgreSQL migration 0003: persistent text messages.

BEGIN;

CREATE TABLE messages (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id  UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    author_id   UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    content     TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    edited_at   TIMESTAMPTZ,
    deleted_at  TIMESTAMPTZ,
    CONSTRAINT messages_content_check CHECK (length(btrim(content)) BETWEEN 1 AND 4000),
    CONSTRAINT messages_edited_at_check CHECK (edited_at IS NULL OR edited_at >= created_at),
    CONSTRAINT messages_deleted_at_check CHECK (deleted_at IS NULL OR deleted_at >= created_at)
);

CREATE INDEX messages_channel_created_idx ON messages (channel_id, created_at DESC, id DESC);
CREATE INDEX messages_author_idx ON messages (author_id, created_at DESC);

INSERT INTO schema_migrations (version) VALUES ('0003_messages');

COMMIT;
