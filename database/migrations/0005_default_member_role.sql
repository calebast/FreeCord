-- FreeCord PostgreSQL migration 0005: default member permissions.

BEGIN;

INSERT INTO roles (community_id, name, description, position, is_default)
SELECT id, 'member', 'Standard community member', 0, TRUE
FROM communities c
WHERE NOT EXISTS (
    SELECT 1 FROM roles r
    WHERE r.community_id = c.id AND lower(r.name) = 'member'
);

INSERT INTO role_permissions (role_id, permission_key, granted)
SELECT r.id, p.key, TRUE
FROM roles r
JOIN permissions p ON p.key IN (
    'community.view', 'members.view', 'channels.view',
    'messages.read', 'messages.write', 'voice.connect', 'voice.speak'
)
WHERE r.is_default
ON CONFLICT (role_id, permission_key) DO UPDATE SET granted = EXCLUDED.granted;

INSERT INTO member_roles (community_id, user_id, role_id)
SELECT cm.community_id, cm.user_id, r.id
FROM community_members cm
JOIN roles r ON r.community_id = cm.community_id AND r.is_default
WHERE NOT EXISTS (
    SELECT 1 FROM member_roles mr
    WHERE mr.community_id = cm.community_id AND mr.user_id = cm.user_id
)
ON CONFLICT DO NOTHING;

INSERT INTO schema_migrations (version)
VALUES ('0005_default_member_role')
ON CONFLICT (version) DO NOTHING;

COMMIT;
