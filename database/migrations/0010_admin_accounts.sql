-- FreeCord PostgreSQL migration 0010: narrowly scoped account administration.

BEGIN;

INSERT INTO permissions (key, description) VALUES
    ('members.password.reset', 'Replace a lower-ranked member password and revoke their sessions'),
    ('members.deactivate', 'Deactivate and anonymize a lower-ranked member account'),
    ('voice.restrictions.manage', 'Clear persistent voice restrictions for lower-ranked members')
ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description;

-- Owners retain every permission. Built-in administrators receive these
-- operational recovery permissions, while custom roles must be granted them
-- explicitly through the existing hierarchy-safe role editor.
INSERT INTO role_permissions (role_id, permission_key, granted)
SELECT r.id, p.key, TRUE
FROM roles r
CROSS JOIN permissions p
WHERE r.kind = 'owner'
  AND p.key IN ('members.password.reset', 'members.deactivate', 'voice.restrictions.manage')
ON CONFLICT (role_id, permission_key) DO UPDATE SET granted = EXCLUDED.granted;

INSERT INTO role_permissions (role_id, permission_key, granted)
SELECT r.id, p.key, TRUE
FROM roles r
CROSS JOIN permissions p
WHERE r.kind = 'admin'
  AND p.key IN ('members.password.reset', 'members.deactivate', 'voice.restrictions.manage')
ON CONFLICT (role_id, permission_key) DO UPDATE SET granted = EXCLUDED.granted;

INSERT INTO schema_migrations (version)
VALUES ('0010_admin_accounts')
ON CONFLICT (version) DO NOTHING;

COMMIT;
