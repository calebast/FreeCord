import { randomBytes } from "node:crypto";
import type { PasswordHasher } from "./auth.js";
import type { DatabaseBoundary } from "./database.js";
import { requirePermission, type EffectiveAccess } from "./authorization.js";
import { writeAuditEvent } from "./audit-log.js";

type Row = Record<string, unknown>;

interface ManagedTarget {
  access: EffectiveAccess;
  userId: string;
}

function validateReplacementPassword(input: unknown): string {
  const password = (input as { newPassword?: unknown } | null)?.newPassword;
  if (typeof password !== "string" || password.length < 12 || password.length > 1024) throw new Error("bad_request");
  return password;
}

async function requireManagedTarget(
  database: DatabaseBoundary,
  actorId: string,
  targetId: string,
  permission: string,
): Promise<ManagedTarget> {
  if (actorId === targetId) throw new Error("forbidden");
  const access = await requirePermission(database, actorId, permission);
  await database.query(
    `SELECT user_id FROM community_members
      WHERE community_id = $1 AND user_id IN ($2, $3)
      ORDER BY user_id FOR UPDATE`,
    [access.communityId, actorId, targetId],
  );
  await database.query(
    `SELECT role_id FROM member_roles
      WHERE community_id = $1 AND user_id IN ($2, $3)
      ORDER BY user_id, role_id FOR UPDATE`,
    [access.communityId, actorId, targetId],
  );
  const result = await database.query<Row>(
    `SELECT cm.user_id, u.is_active,
            EXISTS (SELECT 1 FROM auth_bootstrap ab WHERE ab.initialized_user_id = cm.user_id) AS is_owner,
            EXISTS (SELECT 1 FROM member_roles mr JOIN roles r ON r.id = mr.role_id
                     WHERE mr.community_id = cm.community_id AND mr.user_id = cm.user_id AND r.kind = 'admin') AS is_admin,
            COALESCE((SELECT MAX(r.position) FROM member_roles mr JOIN roles r ON r.id = mr.role_id
                       WHERE mr.community_id = cm.community_id AND mr.user_id = cm.user_id), 0)::int AS highest_position
       FROM community_members cm
       JOIN users u ON u.id = cm.user_id
      WHERE cm.community_id = $1 AND cm.user_id = $2
      FOR UPDATE OF cm, u`,
    [access.communityId, targetId],
  );
  const target = result.rows[0];
  if (!target || target.is_active !== true) throw new Error("not_found");
  if (target.is_owner === true || (!access.isOwner && (target.is_admin === true || Number(target.highest_position) >= access.highestPosition))) {
    throw new Error("forbidden");
  }
  return { access, userId: String(target.user_id) };
}

export async function resetMemberPassword(
  database: DatabaseBoundary,
  passwordHasher: PasswordHasher,
  actorId: string,
  targetId: string,
  input: unknown,
): Promise<{ communityId: string }> {
  if (!database.transaction) throw new Error("database_transaction_not_configured");
  const replacement = validateReplacementPassword(input);
  await requirePermission(database, actorId, "members.password.reset");
  const passwordHash = await passwordHasher.hash(replacement);
  return database.transaction(async (transaction) => {
    const target = await requireManagedTarget(transaction, actorId, targetId, "members.password.reset");
    const updated = await transaction.query<Row>(
      `UPDATE users SET password_hash = $1, updated_at = now()
        WHERE id = $2 AND is_active RETURNING id`,
      [passwordHash, target.userId],
    );
    if (!updated.rows[0]) throw new Error("conflict");
    await transaction.query(
      `UPDATE user_sessions
          SET revoked_at = COALESCE(revoked_at, now()),
              revocation_reason = COALESCE(revocation_reason, 'admin_password_reset')
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [target.userId],
    );
    await writeAuditEvent(transaction, {
      communityId: target.access.communityId,
      actorId,
      action: "account.password_reset",
      targetType: "user",
      targetId: target.userId,
    });
    return { communityId: target.access.communityId };
  });
}

export async function clearMemberVoiceRestrictions(
  database: DatabaseBoundary,
  actorId: string,
  targetId: string,
): Promise<{ communityId: string; cleared: number }> {
  if (!database.transaction) throw new Error("database_transaction_not_configured");
  return database.transaction(async (transaction) => {
    const target = await requireManagedTarget(transaction, actorId, targetId, "voice.restrictions.manage");
    const deleted = await transaction.query<{ channel_id: string }>(
      `DELETE FROM voice_participant_moderation
        WHERE community_id = $1 AND user_id = $2
        RETURNING channel_id`,
      [target.access.communityId, target.userId],
    );
    await writeAuditEvent(transaction, {
      communityId: target.access.communityId,
      actorId,
      action: "voice.restrictions_cleared",
      targetType: "user",
      targetId: target.userId,
      metadata: { clearedEntries: deleted.rows.length, reconnectRequired: true },
    });
    return { communityId: target.access.communityId, cleared: deleted.rows.length };
  });
}

export async function deactivateMemberAccount(
  database: DatabaseBoundary,
  passwordHasher: PasswordHasher,
  actorId: string,
  targetId: string,
): Promise<{ communityId: string }> {
  if (!database.transaction) throw new Error("database_transaction_not_configured");
  await requirePermission(database, actorId, "members.deactivate");
  const disabledPasswordHash = await passwordHasher.hash(randomBytes(32).toString("base64url"));
  return database.transaction(async (transaction) => {
    const target = await requireManagedTarget(transaction, actorId, targetId, "members.deactivate");
    await transaction.query(`DELETE FROM message_reactions WHERE user_id = $1`, [target.userId]);
    await transaction.query(`DELETE FROM user_profiles WHERE user_id = $1`, [target.userId]);
    await transaction.query(`DELETE FROM voice_participant_moderation WHERE community_id = $1 AND user_id = $2`, [target.access.communityId, target.userId]);
    await transaction.query(`DELETE FROM member_roles WHERE community_id = $1 AND user_id = $2`, [target.access.communityId, target.userId]);
    const updated = await transaction.query<Row>(
      `UPDATE users
          SET username = 'deleted-' || replace(id::text, '-', ''),
              display_name = 'Deleted User', password_hash = $1,
              status = 'offline', is_active = false, updated_at = now()
        WHERE id = $2 AND is_active
        RETURNING id`,
      [disabledPasswordHash, target.userId],
    );
    if (!updated.rows[0]) throw new Error("conflict");
    await writeAuditEvent(transaction, {
      communityId: target.access.communityId,
      actorId,
      action: "account.deactivated",
      targetType: "user",
      targetId: target.userId,
      metadata: { usernameReleased: true, sessionsRevoked: true },
    });
    return { communityId: target.access.communityId };
  });
}
