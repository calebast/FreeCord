-- FreeCord PostgreSQL migration 0007: selectable user status.
-- Presence (online/offline) remains derived from active sessions; this field
-- represents the user's selected availability state.

BEGIN;

ALTER TABLE users DROP CONSTRAINT users_status_check;
UPDATE users SET status = 'active' WHERE status IN ('online', 'offline');
ALTER TABLE users ALTER COLUMN status SET DEFAULT 'active';
ALTER TABLE users ADD CONSTRAINT users_status_check CHECK (status IN ('active', 'away', 'busy'));

INSERT INTO schema_migrations (version)
VALUES ('0007_status')
ON CONFLICT (version) DO NOTHING;

COMMIT;
