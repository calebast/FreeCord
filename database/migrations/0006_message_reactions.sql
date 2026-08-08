-- FreeCord PostgreSQL migration 0006: message emoji reactions.

BEGIN;

CREATE TABLE message_reactions (
    message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji      TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (message_id, user_id, emoji),
    CONSTRAINT message_reactions_emoji_check CHECK (length(emoji) BETWEEN 1 AND 32)
);

CREATE INDEX message_reactions_message_idx ON message_reactions (message_id);

INSERT INTO schema_migrations (version) VALUES ('0006_message_reactions');

COMMIT;
