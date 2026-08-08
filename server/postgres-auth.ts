import { createHmac, timingSafeEqual } from "node:crypto";
import type { DatabaseBoundary } from "./database.js";
import { createInviteToken, hashOpaqueToken, type CredentialRecord, type CredentialStore, type InviteRecord, type InviteStore, type SessionRecord, type SessionStore, type AccessTokenIssuer } from "./auth.js";
import type { AuthenticatedUser, AuthSession, CommunityRole, CommunityRoleMetadata, UserStatus } from "./contracts.js";

type Row = Record<string, unknown>;

function text(value: unknown): string { return String(value); }
function optionalText(value: unknown): string | undefined { return value == null ? undefined : String(value); }
function userFromRow(row: Row): AuthenticatedUser {
  const role = String(row.role ?? "member");
  const status = String(row.status ?? "active");
  const roles = Array.isArray(row.roles) ? row.roles.map((value): CommunityRoleMetadata => {
    const item = value as Row;
    const kind = String(item.kind);
    return {
      id: text(item.id), name: text(item.name), description: text(item.description ?? ""), position: Number(item.position),
      kind: kind === "owner" || kind === "admin" || kind === "default" ? kind : "custom",
      permissions: Array.isArray(item.permissions) ? item.permissions.map(text) : [],
    };
  }) : [];
  const permissions = Array.isArray(row.permissions) ? row.permissions.map(text) : [];
  const avatarId = optionalText(row.avatar_id);
  return {
    id: text(row.id), username: text(row.username), displayName: text(row.display_name),
    role: (role === "owner" || role === "admin" ? role : "member") as CommunityRole,
    status: (status === "busy" || status === "away" ? status : "active") as UserStatus,
    roles, permissions, isOwner: row.is_owner === true,
    ...(avatarId ? { avatar: {
      id: avatarId,
      contentType: text(row.avatar_content_type),
      ...(row.avatar_width == null ? {} : { width: Number(row.avatar_width) }),
      ...(row.avatar_height == null ? {} : { height: Number(row.avatar_height) }),
      version: new Date(text(row.avatar_ready_at ?? row.avatar_updated_at)).toISOString(),
    } } : {}),
  };
}
function sessionFromRow(row: Row): SessionRecord {
  const deviceName = optionalText(row.device_name);
  const revokedAt = optionalText(row.revoked_at);
  return {
    id: text(row.id), userId: text(row.user_id), createdAt: new Date(text(row.created_at)).toISOString(),
    expiresAt: new Date(text(row.expires_at)).toISOString(),
    ...(deviceName ? { deviceName } : {}),
    refreshTokenHash: text(row.refresh_token_hash),
    ...(revokedAt ? { revokedAt: new Date(revokedAt).toISOString() } : {}),
  };
}

const userSelect = `
  SELECT u.id, u.username, u.display_name, u.password_hash, u.status,
         CASE WHEN EXISTS (SELECT 1 FROM auth_bootstrap ab WHERE ab.initialized_user_id = u.id) THEN 'owner'
              WHEN EXISTS (SELECT 1 FROM community_members cm2 JOIN member_roles mr2 ON mr2.community_id = cm2.community_id AND mr2.user_id = cm2.user_id
                           JOIN roles r2 ON r2.id = mr2.role_id WHERE cm2.user_id = u.id AND r2.kind = 'admin') THEN 'admin'
              ELSE 'member' END AS role,
         EXISTS (SELECT 1 FROM auth_bootstrap ab WHERE ab.initialized_user_id = u.id) AS is_owner,
         COALESCE((SELECT jsonb_agg(jsonb_build_object(
                    'id', r.id, 'name', r.name, 'description', r.description, 'position', r.position, 'kind', r.kind,
                    'permissions', COALESCE((SELECT jsonb_agg(rp.permission_key ORDER BY rp.permission_key)
                                              FROM role_permissions rp WHERE rp.role_id = r.id AND rp.granted), '[]'::jsonb)
                  ) ORDER BY r.position DESC, lower(r.name), r.id)
                    FROM community_members cm3 JOIN member_roles mr3 ON mr3.community_id = cm3.community_id AND mr3.user_id = cm3.user_id
                    JOIN roles r ON r.id = mr3.role_id WHERE cm3.user_id = u.id), '[]'::jsonb) AS roles,
         COALESCE((SELECT array_agg(DISTINCT rp.permission_key ORDER BY rp.permission_key)
                     FROM community_members cm4 JOIN member_roles mr4 ON mr4.community_id = cm4.community_id AND mr4.user_id = cm4.user_id
                     JOIN role_permissions rp ON rp.role_id = mr4.role_id AND rp.granted
                    WHERE cm4.user_id = u.id), ARRAY[]::varchar[]) AS permissions,
         avatar.id AS avatar_id, avatar.content_type AS avatar_content_type,
         avatar.width AS avatar_width, avatar.height AS avatar_height,
         avatar.ready_at AS avatar_ready_at, profile.updated_at AS avatar_updated_at
  FROM users u
  LEFT JOIN user_profiles profile ON profile.user_id = u.id
  LEFT JOIN media_objects avatar ON avatar.id = profile.avatar_media_id AND avatar.state = 'ready'
`;

export class PostgresCredentialStore implements CredentialStore {
  constructor(private readonly database: DatabaseBoundary) {}
  async findByUsername(username: string): Promise<CredentialRecord | undefined> {
    const result = await this.database.query<Row>(`${userSelect} WHERE lower(u.username) = lower($1) AND u.is_active`, [username.trim()]);
    const row = result.rows[0];
    return row ? { user: userFromRow(row), passwordHash: text(row.password_hash) } : undefined;
  }
  async findByUserId(userId: string): Promise<AuthenticatedUser | undefined> {
    const result = await this.database.query<Row>(`${userSelect} WHERE u.id = $1 AND u.is_active`, [userId]);
    return result.rows[0] ? userFromRow(result.rows[0]) : undefined;
  }

  async updateStatus(userId: string, status: UserStatus): Promise<AuthenticatedUser | undefined> {
    const result = await this.database.query<Row>(
      `UPDATE users SET status = $1, updated_at = now()
        WHERE id = $2 AND is_active
        RETURNING id`, [status, userId],
    );
    return result.rows[0] ? this.findByUserId(userId) : undefined;
  }
  async createUser(input: { username: string; displayName: string; passwordHash: string }): Promise<AuthenticatedUser> {
    try {
      const result = await this.database.query<Row>(
        `WITH inserted AS (
           INSERT INTO users (username, display_name, password_hash)
           VALUES ($1, $2, $3) RETURNING id, username, display_name
         ), community AS (SELECT id FROM communities ORDER BY created_at LIMIT 1),
         member AS (INSERT INTO community_members (community_id, user_id)
           SELECT community.id, inserted.id FROM community CROSS JOIN inserted ON CONFLICT DO NOTHING RETURNING user_id)
         SELECT inserted.id, inserted.username, inserted.display_name, 'member' AS role FROM inserted`,
        [input.username, input.displayName, input.passwordHash],
      );
      if (!result.rows[0]) throw new Error("conflict");
      return userFromRow(result.rows[0]);
    } catch (error) {
      if (isUniqueViolation(error)) throw new Error("conflict");
      throw error;
    }
  }
  async createUserWithInvite(input: { inviteId: string; username: string; displayName: string; passwordHash: string }): Promise<AuthenticatedUser> {
    try {
      const result = await this.database.query<Row>(
        `WITH claimed AS (
           SELECT id FROM invites
           WHERE id = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()
           FOR UPDATE
         ), inserted AS (
           INSERT INTO users (username, display_name, password_hash)
           SELECT $2, $3, $4 FROM claimed RETURNING id, username, display_name
         ), community AS (SELECT id FROM communities ORDER BY created_at LIMIT 1),
         member AS (INSERT INTO community_members (community_id, user_id)
           SELECT community.id, inserted.id FROM community CROSS JOIN inserted ON CONFLICT DO NOTHING RETURNING user_id)
         , assigned_role AS (INSERT INTO member_roles (community_id, user_id, role_id)
           SELECT community.id, inserted.id, roles.id
           FROM community CROSS JOIN inserted JOIN roles ON roles.community_id = community.id AND roles.is_default
           RETURNING user_id)
         , consumed AS (
           UPDATE invites SET used_at = now(), used_by = (SELECT id FROM inserted)
           WHERE id = (SELECT id FROM claimed)
           RETURNING id
         )
         SELECT inserted.id, inserted.username, inserted.display_name, 'member' AS role FROM inserted`,
        [input.inviteId, input.username, input.displayName, input.passwordHash],
      );
      if (!result.rows[0]) throw new Error("invalid_invite");
      return userFromRow(result.rows[0]);
    } catch (error) {
      if (isUniqueViolation(error)) throw new Error("conflict");
      throw error;
    }
  }
}

export class PostgresInviteStore implements InviteStore {
  constructor(private readonly database: DatabaseBoundary) {}
  async findByTokenHash(tokenHash: string): Promise<InviteRecord | undefined> {
    const result = await this.database.query<Row>(
      `SELECT id, token_hash, expires_at, used_at, revoked_at FROM invites
       WHERE token_hash = $1 AND used_at IS NULL AND revoked_at IS NULL`, [tokenHash]);
    const row = result.rows[0];
    return row ? { id: text(row.id), tokenHash: text(row.token_hash), expiresAt: new Date(text(row.expires_at)).toISOString(), ...(optionalText(row.used_at) ? { usedAt: new Date(text(row.used_at)).toISOString() } : {}), ...(optionalText(row.revoked_at) ? { revokedAt: new Date(text(row.revoked_at)).toISOString() } : {}) } : undefined;
  }
  async markUsed(id: string, usedAt: string): Promise<boolean> {
    const result = await this.database.query<Row>(`UPDATE invites SET used_at = $2 WHERE id = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now() RETURNING id`, [id, usedAt]);
    return result.rows.length === 1;
  }

  async create(input: { communityId: string; createdBy: string; expiresAt: string }): Promise<{ token: string; expiresAt: string }> {
    const token = createInviteToken();
    await this.database.query(
      `INSERT INTO invites (community_id, created_by, token_hash, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [input.communityId, input.createdBy, hashOpaqueToken(token), input.expiresAt],
    );
    return { token, expiresAt: input.expiresAt };
  }
}

export class PostgresSessionStore implements SessionStore {
  constructor(private readonly database: DatabaseBoundary, private readonly accessTokens: PostgresAccessTokenIssuer) {}
  async create(input: { userId: string; deviceName?: string; refreshTokenHash: string; expiresAt: string }): Promise<SessionRecord> {
    const result = await this.database.query<Row>(`INSERT INTO user_sessions (user_id, refresh_token_hash, device_name, expires_at) VALUES ($1, $2, $3, $4) RETURNING *`, [input.userId, input.refreshTokenHash, input.deviceName ?? null, input.expiresAt]);
    return sessionFromRow(result.rows[0]!);
  }
  async findByRefreshTokenHash(hash: string): Promise<SessionRecord | undefined> {
    const result = await this.database.query<Row>(`SELECT * FROM user_sessions WHERE refresh_token_hash = $1`, [hash]);
    return result.rows[0] ? sessionFromRow(result.rows[0]) : undefined;
  }
  async revoke(id: string, replacedBySessionId?: string): Promise<void> {
    await this.database.query(`UPDATE user_sessions SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1`, [id]);
    void replacedBySessionId;
  }
  async revokeIfActive(id: string, replacedBySessionId?: string): Promise<boolean> {
    const result = await this.database.query<Row>(`UPDATE user_sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL AND expires_at > now() RETURNING id`, [id]);
    void replacedBySessionId;
    return result.rows.length === 1;
  }
  async revokeAll(userId: string): Promise<void> { await this.database.query(`UPDATE user_sessions SET revoked_at = COALESCE(revoked_at, now()) WHERE user_id = $1 AND revoked_at IS NULL`, [userId]); }
  async revokeFamily(sessionId: string): Promise<void> {
    await this.database.query(
      `UPDATE user_sessions SET revoked_at = COALESCE(revoked_at, now()), revocation_reason = COALESCE(revocation_reason, 'logout')
       WHERE rotation_family_id = (SELECT rotation_family_id FROM user_sessions WHERE id = $1)`,
      [sessionId],
    );
  }
  async rotate(input: { oldSessionId: string; userId: string; deviceName?: string; refreshTokenHash: string; expiresAt: string }): Promise<SessionRecord | undefined> {
    if (!this.database.transaction) throw new Error("database_transaction_not_configured");
    return this.database.transaction(async (transaction) => {
      const current = await transaction.query<Row>(
        `SELECT * FROM user_sessions WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [input.oldSessionId, input.userId],
      );
      const old = current.rows[0];
      if (!old || old.revoked_at || new Date(text(old.expires_at)).getTime() <= Date.now()) return undefined;
      const replacement = await transaction.query<Row>(
        `INSERT INTO user_sessions (user_id, refresh_token_hash, device_name, expires_at, rotation_family_id)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [input.userId, input.refreshTokenHash, input.deviceName ?? null, input.expiresAt, old.rotation_family_id],
      );
      const session = replacement.rows[0];
      if (!session) throw new Error("session_rotation_failed");
      await transaction.query(
        `UPDATE user_sessions SET revoked_at = now(), rotated_at = now(), replaced_by_session_id = $2,
         revocation_reason = 'rotated' WHERE id = $1 AND revoked_at IS NULL`,
        [input.oldSessionId, session.id],
      );
      return sessionFromRow(session);
    });
  }
  async findByAccessToken(token: string): Promise<{ user: AuthenticatedUser; session: AuthSession } | undefined> {
    const claims = this.accessTokens.verify(token);
    if (!claims) return undefined;
    const sessionResult = await this.database.query<Row>(`SELECT * FROM user_sessions WHERE id = $1 AND revoked_at IS NULL AND expires_at > now()`, [claims.sessionId]);
    const sessionRow = sessionResult.rows[0];
    if (!sessionRow || text(sessionRow.user_id) !== claims.userId) return undefined;
    await this.database.query(`UPDATE user_sessions SET last_used_at = now() WHERE id = $1`, [claims.sessionId]);
    const user = await new PostgresCredentialStore(this.database).findByUserId(claims.userId);
    return user ? { user, session: sessionFromRow(sessionRow) } : undefined;
  }
}

export interface AccessClaims { sessionId: string; userId: string; expiresAt: number }
export class PostgresAccessTokenIssuer implements AccessTokenIssuer {
  constructor(private readonly secret: string, private readonly ttlSeconds: number) {}
  async issue(user: AuthenticatedUser, session: AuthSession): Promise<{ token: string; expiresInSeconds: number }> {
    const expiresAt = Math.floor(Date.now() / 1000) + this.ttlSeconds;
    const payload = Buffer.from(JSON.stringify({ sid: session.id, uid: user.id, exp: expiresAt }), "utf8").toString("base64url");
    return { token: `${payload}.${this.sign(payload)}`, expiresInSeconds: this.ttlSeconds };
  }
  verify(token: string): AccessClaims | undefined {
    const [payload, signature] = token.split(".");
    if (!payload || !signature) return undefined;
    const expected = this.sign(payload);
    const a = Buffer.from(signature); const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;
    try {
      const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { sid?: unknown; uid?: unknown; exp?: unknown };
      if (typeof data.sid !== "string" || typeof data.uid !== "string" || typeof data.exp !== "number" || data.exp <= Math.floor(Date.now() / 1000)) return undefined;
      return { sessionId: data.sid, userId: data.uid, expiresAt: data.exp };
    } catch { return undefined; }
  }
  private sign(payload: string): string { return createHmac("sha256", this.secret).update(payload).digest("base64url"); }
}

export async function bootstrapInitialAdmin(database: DatabaseBoundary, username: string, passwordHash: string): Promise<void> {
  if (!database.transaction) throw new Error("database_transaction_not_configured");
  await database.transaction(async (transaction) => {
    await transaction.query("SELECT pg_advisory_xact_lock(hashtext('freecord:initial-admin'))");
    const initialized = await transaction.query<Row>(
      `(SELECT 1 FROM auth_bootstrap LIMIT 1) UNION ALL (SELECT 1 FROM users LIMIT 1)`,
    );
    if (initialized.rows.length > 0) return;
    const community = await transaction.query<Row>("SELECT id FROM communities ORDER BY created_at, id LIMIT 1");
    const communityId = community.rows[0]?.id;
    if (!communityId) throw new Error("community_not_initialized");
    const created = await transaction.query<Row>(
      `INSERT INTO users (username, display_name, password_hash) VALUES ($1, $1, $2) RETURNING id`,
      [username, passwordHash],
    );
    const userId = created.rows[0]?.id;
    if (!userId) throw new Error("bootstrap_failed");
    await transaction.query(
      `INSERT INTO community_members (community_id, user_id) VALUES ($1, $2)`,
      [communityId, userId],
    );
    await transaction.query(
      `INSERT INTO roles (community_id, name, description, position, is_default)
       VALUES ($1, 'owner', 'Installation owner', 100, false)
       ON CONFLICT DO NOTHING`,
      [communityId],
    );
    await transaction.query(
      `INSERT INTO role_permissions (role_id, permission_key, granted)
       SELECT r.id, p.key, TRUE
       FROM roles r CROSS JOIN permissions p
       WHERE r.community_id = $1 AND lower(r.name) = 'owner'
       ON CONFLICT (role_id, permission_key) DO UPDATE SET granted = EXCLUDED.granted`,
      [communityId],
    );
    await transaction.query(
      `INSERT INTO member_roles (community_id, user_id, role_id)
       SELECT $1, $2, id FROM roles WHERE community_id = $1 AND lower(name) = 'owner'`,
      [communityId, userId],
    );
    await transaction.query(
      `INSERT INTO auth_bootstrap (initialized_user_id) VALUES ($1)`,
      [userId],
    );
  });
}

function isUniqueViolation(error: unknown): boolean { return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "23505"); }
