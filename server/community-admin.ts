import type { CommunityRoleMetadata } from "./contracts.js";
import type { DatabaseBoundary } from "./database.js";
import { effectiveAccess, mayGrantPermissions, requirePermission } from "./authorization.js";
import { writeAuditEvent } from "./audit-log.js";

type Row = Record<string, unknown>;

export interface RoleInput {
  name: string;
  description: string;
  position?: number;
  permissions: string[];
}

export function validateRoleInput(input: unknown, partial = false): Partial<RoleInput> {
  if (!input || typeof input !== "object") throw new Error("bad_request");
  const value = input as Record<string, unknown>;
  const output: Partial<RoleInput> = {};
  if (!partial || "name" in value) {
    if (typeof value.name !== "string") throw new Error("bad_request");
    const name = value.name.trim();
    if (!name || name.length > 64 || /[\u0000-\u001f\u007f]/u.test(name)) throw new Error("bad_request");
    if (["owner", "admin", "member", "default"].includes(name.toLowerCase())) throw new Error("bad_request");
    output.name = name;
  }
  if (!partial || "description" in value) {
    if (value.description != null && typeof value.description !== "string") throw new Error("bad_request");
    const description = typeof value.description === "string" ? value.description.trim() : "";
    if (description.length > 500) throw new Error("bad_request");
    output.description = description;
  }
  if ("position" in value) {
    if (!Number.isInteger(value.position) || Number(value.position) < 0 || Number(value.position) > 9999) throw new Error("bad_request");
    output.position = Number(value.position);
  }
  if (!partial || "permissions" in value) {
    if (!Array.isArray(value.permissions) || value.permissions.length > 100
      || value.permissions.some((permission) => typeof permission !== "string" || !/^[a-z][a-z0-9_.-]{0,79}$/u.test(permission))) {
      throw new Error("bad_request");
    }
    output.permissions = [...new Set(value.permissions as string[])];
  }
  if (partial && Object.keys(output).length === 0) throw new Error("bad_request");
  return output;
}

function roleFromRow(row: Row): CommunityRoleMetadata {
  const kind = String(row.kind);
  return {
    id: String(row.id),
    name: String(row.name),
    description: String(row.description ?? ""),
    position: Number(row.position),
    kind: kind === "owner" || kind === "admin" || kind === "default" ? kind : "custom",
    permissions: Array.isArray(row.permissions) ? row.permissions.map(String) : [],
  };
}

const roleSelect = `r.id, r.name, r.description, r.position, r.kind,
  COALESCE(array_agg(DISTINCT rp.permission_key) FILTER (WHERE rp.granted), ARRAY[]::varchar[]) AS permissions`;

export async function listPermissions(database: DatabaseBoundary, userId: string) {
  const access = await requirePermission(database, userId, "roles.view");
  const result = await database.query<{ key: string; description: string }>(
    `SELECT key, description FROM permissions ORDER BY key`,
  );
  return { permissions: result.rows, currentUserPermissions: access.permissions, isOwner: access.isOwner };
}

export async function listRoles(database: DatabaseBoundary, userId: string) {
  const access = await requirePermission(database, userId, "roles.view");
  const result = await database.query<Row>(
    `SELECT ${roleSelect}
       FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id
      WHERE r.community_id = $1
      GROUP BY r.id ORDER BY r.position DESC, lower(r.name), r.id`,
    [access.communityId],
  );
  return { roles: result.rows.map(roleFromRow) };
}

async function ensureKnownPermissions(database: DatabaseBoundary, permissions: string[]): Promise<void> {
  if (!permissions.length) return;
  const result = await database.query<{ key: string }>(`SELECT key FROM permissions WHERE key = ANY($1::varchar[])`, [permissions]);
  if (result.rows.length !== permissions.length) throw new Error("bad_request");
}

export async function createRole(database: DatabaseBoundary, actorId: string, input: RoleInput) {
  if (!database.transaction) throw new Error("database_transaction_not_configured");
  return database.transaction(async (transaction) => {
    const actor = await requirePermission(transaction, actorId, "roles.manage");
    if (!mayGrantPermissions(actor, input.permissions)) throw new Error("forbidden");
    await ensureKnownPermissions(transaction, input.permissions);
    const position = input.position ?? Math.max(0, actor.highestPosition - 1);
    if (!actor.isOwner && position >= actor.highestPosition) throw new Error("forbidden");
    const inserted = await transaction.query<Row>(
      `INSERT INTO roles (community_id, name, description, position, kind, created_by, updated_at)
       VALUES ($1, $2, $3, $4, 'custom', $5, now())
       RETURNING id, name, description, position, kind`,
      [actor.communityId, input.name, input.description, position, actorId],
    );
    const role = inserted.rows[0];
    if (!role) throw new Error("internal_error");
    if (input.permissions.length) {
      await transaction.query(
        `INSERT INTO role_permissions (role_id, permission_key, granted)
         SELECT $1, unnest($2::varchar[]), true`,
        [role.id, input.permissions],
      );
    }
    await writeAuditEvent(transaction, {
      communityId: actor.communityId,
      actorId,
      action: "role.created",
      targetType: "role",
      targetId: String(role.id),
      metadata: { name: input.name, position, permissionCount: input.permissions.length },
    });
    return { role: roleFromRow({ ...role, permissions: input.permissions }) };
  });
}

export async function updateRole(database: DatabaseBoundary, actorId: string, roleId: string, patch: Partial<RoleInput>) {
  if (!database.transaction) throw new Error("database_transaction_not_configured");
  return database.transaction(async (transaction) => {
    const actor = await requirePermission(transaction, actorId, "roles.manage");
    if (patch.permissions && !mayGrantPermissions(actor, patch.permissions)) throw new Error("forbidden");
    if (patch.permissions) await ensureKnownPermissions(transaction, patch.permissions);
    const existing = await transaction.query<Row>(
      `SELECT id, name, description, position, kind FROM roles WHERE id = $1 AND community_id = $2 FOR UPDATE`,
      [roleId, actor.communityId],
    );
    const role = existing.rows[0];
    if (!role) throw new Error("not_found");
    if (String(role.kind) !== "custom") throw new Error("forbidden");
    if (!actor.isOwner && Number(role.position) >= actor.highestPosition) throw new Error("forbidden");
    const position = patch.position ?? Number(role.position);
    if (!actor.isOwner && position >= actor.highestPosition) throw new Error("forbidden");
    const updated = await transaction.query<Row>(
      `UPDATE roles SET name = $1, description = $2, position = $3, updated_at = now()
        WHERE id = $4 AND community_id = $5
        RETURNING id, name, description, position, kind`,
      [patch.name ?? role.name, patch.description ?? role.description, position, roleId, actor.communityId],
    );
    if (patch.permissions) {
      await transaction.query(`DELETE FROM role_permissions WHERE role_id = $1`, [roleId]);
      if (patch.permissions.length) {
        await transaction.query(
          `INSERT INTO role_permissions (role_id, permission_key, granted)
           SELECT $1, unnest($2::varchar[]), true`,
          [roleId, patch.permissions],
        );
      }
    }
    const permissions = patch.permissions ?? (await transaction.query<{ permission_key: string }>(
      `SELECT permission_key FROM role_permissions WHERE role_id = $1 AND granted ORDER BY permission_key`, [roleId],
    )).rows.map((item) => item.permission_key);
    await writeAuditEvent(transaction, {
      communityId: actor.communityId,
      actorId,
      action: "role.updated",
      targetType: "role",
      targetId: roleId,
      metadata: { name: String(updated.rows[0]?.name ?? role.name), position, permissionCount: permissions.length },
    });
    return { role: roleFromRow({ ...updated.rows[0], permissions }) };
  });
}

export async function deleteRole(database: DatabaseBoundary, actorId: string, roleId: string): Promise<void> {
  if (!database.transaction) throw new Error("database_transaction_not_configured");
  await database.transaction(async (transaction) => {
    const actor = await requirePermission(transaction, actorId, "roles.manage");
    const result = await transaction.query<Row>(
      `DELETE FROM roles WHERE id = $1 AND community_id = $2 AND kind = 'custom'
         AND ($3::boolean OR position < $4)
       RETURNING id, name`,
      [roleId, actor.communityId, actor.isOwner, actor.highestPosition],
    );
    if (!result.rows[0]) throw new Error("not_found");
    await writeAuditEvent(transaction, {
      communityId: actor.communityId,
      actorId,
      action: "role.deleted",
      targetType: "role",
      targetId: roleId,
      metadata: { name: String(result.rows[0].name) },
    });
  });
}

export async function assignRole(database: DatabaseBoundary, actorId: string, userId: string, roleId: string, assign: boolean): Promise<void> {
  if (!database.transaction) throw new Error("database_transaction_not_configured");
  await database.transaction(async (transaction) => {
    await transaction.query(
      `SELECT user_id FROM community_members
        WHERE user_id IN ($1, $2) ORDER BY user_id FOR UPDATE`,
      [actorId, userId],
    );
    const actor = await requirePermission(transaction, actorId, "roles.assign");
    await transaction.query(
      `SELECT role_id FROM member_roles
        WHERE community_id = $1 AND user_id IN ($2, $3)
        ORDER BY user_id, role_id FOR UPDATE`,
      [actor.communityId, actorId, userId],
    );
    const target = await transaction.query<Row>(
      `SELECT cm.user_id,
              EXISTS (SELECT 1 FROM auth_bootstrap ab WHERE ab.initialized_user_id = cm.user_id) AS is_owner,
              COALESCE((SELECT MAX(r.position) FROM member_roles mr JOIN roles r ON r.id = mr.role_id
                         WHERE mr.community_id = cm.community_id AND mr.user_id = cm.user_id), 0)::int AS highest_position
         FROM community_members cm
        WHERE cm.community_id = $1 AND cm.user_id = $2
        FOR UPDATE OF cm`,
      [actor.communityId, userId],
    );
    const roleResult = await transaction.query<Row>(
      `SELECT id, position, kind FROM roles WHERE community_id = $1 AND id = $2 FOR UPDATE`,
      [actor.communityId, roleId],
    );
    const member = target.rows[0];
    const role = roleResult.rows[0];
    if (!member || !role) throw new Error("not_found");
    if (member.is_owner === true || String(role.kind) === "owner") throw new Error("forbidden");
    if (!actor.isOwner && (Number(member.highest_position) >= actor.highestPosition || Number(role.position) >= actor.highestPosition)) throw new Error("forbidden");
    if (!actor.isOwner) {
      const grants = await transaction.query<{ permission_key: string }>(
        `SELECT permission_key FROM role_permissions WHERE role_id = $1 AND granted`, [roleId],
      );
      if (!mayGrantPermissions(actor, grants.rows.map((item) => item.permission_key))) throw new Error("forbidden");
    }
    if (assign) {
      await transaction.query(
        `INSERT INTO member_roles (community_id, user_id, role_id, assigned_by)
         VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [actor.communityId, userId, roleId, actorId],
      );
    } else {
      if (String(role.kind) === "default") throw new Error("forbidden");
      await transaction.query(
        `DELETE FROM member_roles WHERE community_id = $1 AND user_id = $2 AND role_id = $3`,
        [actor.communityId, userId, roleId],
      );
    }
    await writeAuditEvent(transaction, {
      communityId: actor.communityId,
      actorId,
      action: assign ? "member_role.assigned" : "member_role.removed",
      targetType: "user",
      targetId: userId,
      metadata: { roleId },
    });
  });
}
