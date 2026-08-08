-- FreeCord PostgreSQL migration 0004: encrypted message payloads.

BEGIN;

ALTER TABLE messages
    ALTER COLUMN content DROP NOT NULL,
    ADD COLUMN ciphertext TEXT,
    ADD COLUMN nonce TEXT,
    ADD CONSTRAINT messages_payload_check CHECK (
      (ciphertext IS NOT NULL AND nonce IS NOT NULL AND content IS NULL)
      OR (ciphertext IS NULL AND nonce IS NULL AND content IS NOT NULL)
    );

INSERT INTO schema_migrations (version) VALUES ('0004_encrypted_messages');

COMMIT;
