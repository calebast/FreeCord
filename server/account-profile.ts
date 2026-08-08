import type { PasswordHasher } from "./auth.js";
import type { DatabaseBoundary } from "./database.js";

export function validateDisplayName(input: unknown): string {
  const displayName = typeof input === "string" ? input.trim() : "";
  if (!displayName || displayName.length > 100 || /[\u0000-\u001f\u007f]/u.test(displayName)) {
    throw new Error("bad_request");
  }
  return displayName;
}

export async function updateOwnDisplayName(
  database: DatabaseBoundary,
  userId: string,
  input: unknown,
): Promise<void> {
  const displayName = validateDisplayName(input);
  const result = await database.query<{ id: string }>(
    `UPDATE users SET display_name = $1, updated_at = now()
      WHERE id = $2 AND is_active
      RETURNING id`,
    [displayName, userId],
  );
  if (!result.rows[0]) throw new Error("unauthorized");
}

export interface ChangePasswordInput {
  currentPassword: string;
  newPassword: string;
}

export function validatePasswordChange(input: unknown): ChangePasswordInput {
  const value = input as Partial<ChangePasswordInput> | null;
  if (!value || typeof value.currentPassword !== "string" || typeof value.newPassword !== "string"
    || value.currentPassword.length < 1 || value.currentPassword.length > 1024
    || value.newPassword.length < 12 || value.newPassword.length > 1024
    || value.currentPassword === value.newPassword) {
    throw new Error("bad_request");
  }
  return { currentPassword: value.currentPassword, newPassword: value.newPassword };
}

export async function changeOwnPassword(
  database: DatabaseBoundary,
  passwordHasher: PasswordHasher,
  userId: string,
  currentSessionId: string,
  input: unknown,
): Promise<void> {
  if (!database.transaction) throw new Error("database_transaction_not_configured");
  const value = validatePasswordChange(input);
  await database.transaction(async (transaction) => {
    const current = await transaction.query<{ password_hash: string }>(
      `SELECT password_hash FROM users WHERE id = $1 AND is_active FOR UPDATE`,
      [userId],
    );
    const passwordHash = current.rows[0]?.password_hash;
    if (!passwordHash || !await passwordHasher.verify(value.currentPassword, passwordHash)) {
      throw new Error("invalid_credentials");
    }
    const nextHash = await passwordHasher.hash(value.newPassword);
    await transaction.query(
      `UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2 AND is_active`,
      [nextHash, userId],
    );
    await transaction.query(
      `UPDATE user_sessions
          SET revoked_at = COALESCE(revoked_at, now()),
              revocation_reason = COALESCE(revocation_reason, 'password_changed')
        WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL`,
      [userId, currentSessionId],
    );
  });
}
