import type { DatabaseBoundary } from "./database.js";

type Row = Record<string, unknown>;

export interface EffectiveAccess {
  communityId: string;
  isOwner: boolean;
  highestPosition: number;
  permissions: string[];
}

export interface ChannelPermissionAccess {
  communityId: string;
  channelId: string;
  channelType: "text" | "voice";
  isOwner: boolean;
  allowed: boolean;
}

export async function effectiveAccess(database: DatabaseBoundary, userId: string): Promise<EffectiveAccess> {
  const result = await database.query<Row>(
    `SELECT cm.community_id,
            EXISTS (SELECT 1 FROM auth_bootstrap ab WHERE ab.initialized_user_id = $1) AS is_owner,
            COALESCE(MAX(r.position), 0)::int AS highest_position,
            COALESCE(array_agg(DISTINCT rp.permission_key) FILTER (WHERE rp.granted), ARRAY[]::varchar[]) AS permissions
       FROM community_members cm
       LEFT JOIN member_roles mr ON mr.community_id = cm.community_id AND mr.user_id = cm.user_id
       LEFT JOIN roles r ON r.community_id = mr.community_id AND r.id = mr.role_id
       LEFT JOIN role_permissions rp ON rp.role_id = r.id
      WHERE cm.user_id = $1
        AND NOT (cm.is_banned AND (cm.banned_until IS NULL OR cm.banned_until > now()))
      GROUP BY cm.community_id`,
    [userId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("forbidden");
  return {
    communityId: String(row.community_id),
    isOwner: row.is_owner === true,
    highestPosition: Number(row.highest_position) || 0,
    permissions: Array.isArray(row.permissions) ? row.permissions.map(String) : [],
  };
}

export async function requirePermission(database: DatabaseBoundary, userId: string, permission: string): Promise<EffectiveAccess> {
  const access = await effectiveAccess(database, userId);
  if (!access.isOwner && !access.permissions.includes(permission)) throw new Error("forbidden");
  return access;
}

/**
 * Resolve one permission for one channel. The highest-position assigned role
 * with an explicit channel override wins. At an equal position a deny wins.
 * When no override exists, apply the same rule to community role permissions.
 * The installation owner is never denied.
 */
export async function resolveChannelPermission(
  database: DatabaseBoundary,
  userId: string,
  channelId: string,
  permission: string,
  expectedType?: "text" | "voice",
): Promise<ChannelPermissionAccess> {
  const result = await database.query<Row>(
    `SELECT c.community_id, c.id AS channel_id, c.type AS channel_type,
            EXISTS (SELECT 1 FROM auth_bootstrap ab WHERE ab.initialized_user_id = $1) AS is_owner,
            COALESCE(
              (SELECT cpo.granted
                 FROM channel_permission_overrides cpo
                 JOIN member_roles mr ON mr.community_id = cpo.community_id
                  AND mr.role_id = cpo.role_id AND mr.user_id = $1
                 JOIN roles r ON r.community_id = mr.community_id AND r.id = mr.role_id
                WHERE cpo.community_id = c.community_id AND cpo.channel_id = c.id
                  AND cpo.permission_key = $3
                ORDER BY r.position DESC, cpo.granted ASC, r.id
                LIMIT 1),
              (SELECT rp.granted
                 FROM member_roles mr
                 JOIN roles r ON r.community_id = mr.community_id AND r.id = mr.role_id
                 JOIN role_permissions rp ON rp.role_id = r.id AND rp.permission_key = $3
                WHERE mr.community_id = c.community_id AND mr.user_id = $1
                ORDER BY r.position DESC, rp.granted ASC, r.id
                LIMIT 1),
              false
            ) AS role_allowed
       FROM channels c
       JOIN community_members cm ON cm.community_id = c.community_id AND cm.user_id = $1
       JOIN users u ON u.id = cm.user_id AND u.is_active
      WHERE c.id = $2 AND NOT c.is_archived
        AND ($4::varchar IS NULL OR c.type = $4)
        AND NOT (cm.is_banned AND (cm.banned_until IS NULL OR cm.banned_until > now()))`,
    [userId, channelId, permission, expectedType ?? null],
  );
  const row = result.rows[0];
  if (!row) throw new Error("not_found");
  const isOwner = row.is_owner === true;
  return {
    communityId: String(row.community_id),
    channelId: String(row.channel_id),
    channelType: String(row.channel_type) as "text" | "voice",
    isOwner,
    allowed: isOwner || row.role_allowed === true,
  };
}

export async function requireChannelPermission(
  database: DatabaseBoundary,
  userId: string,
  channelId: string,
  permission: string,
  expectedType?: "text" | "voice",
): Promise<ChannelPermissionAccess> {
  const access = await resolveChannelPermission(database, userId, channelId, permission, expectedType);
  if (!access.allowed) throw new Error("forbidden");
  return access;
}

export function mayGrantPermissions(actor: EffectiveAccess, requested: readonly string[]): boolean {
  return actor.isOwner || requested.every((permission) => actor.permissions.includes(permission));
}
