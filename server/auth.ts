import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type {
  AuthService,
  AuthenticatedUser,
  AuthSession,
  LoginRequest,
  LoginResponse,
  RegisterRequest,
  LogoutRequest,
  RefreshRequest,
  RequestContext,
  SessionResponse,
} from "./contracts.js";

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(password: string, encodedHash: string): Promise<boolean>;
}

export interface CredentialRecord {
  user: AuthenticatedUser;
  passwordHash: string;
}

export interface CredentialStore {
  findByUsername(username: string): Promise<CredentialRecord | undefined>;
  findByUserId(userId: string): Promise<AuthenticatedUser | undefined>;
  createUser(input: { username: string; displayName: string; passwordHash: string }): Promise<AuthenticatedUser>;
  createUserWithInvite?(input: { inviteId: string; username: string; displayName: string; passwordHash: string }): Promise<AuthenticatedUser>;
}

export interface InviteRecord {
  id: string;
  tokenHash: string;
  expiresAt: string;
  usedAt?: string;
  revokedAt?: string;
}

export interface InviteStore {
  findByTokenHash(hash: string): Promise<InviteRecord | undefined>;
  markUsed(id: string, usedAt: string): Promise<boolean>;
}

export interface SessionRecord extends AuthSession {
  refreshTokenHash: string;
  revokedAt?: string;
}

export interface SessionStore {
  create(input: { userId: string; deviceName?: string; refreshTokenHash: string; expiresAt: string }): Promise<SessionRecord>;
  findByRefreshTokenHash(hash: string): Promise<SessionRecord | undefined>;
  revoke(id: string, replacedBySessionId?: string): Promise<void>;
  findByAccessToken(token: string): Promise<{ user: AuthenticatedUser; session: AuthSession } | undefined>;
  revokeIfActive?(id: string, replacedBySessionId?: string): Promise<boolean>;
  revokeAll?(userId: string): Promise<void>;
  revokeFamily?(sessionId: string): Promise<void>;
  rotate?(input: {
    oldSessionId: string;
    userId: string;
    deviceName?: string;
    refreshTokenHash: string;
    expiresAt: string;
  }): Promise<SessionRecord | undefined>;
}

export interface AccessTokenIssuer {
  issue(user: AuthenticatedUser, session: AuthSession): Promise<{ token: string; expiresInSeconds: number }>;
}

export function hashOpaqueToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function tokensEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createRefreshToken(): string {
  return randomBytes(32).toString("base64url");
}

export function createInviteToken(): string {
  return randomBytes(32).toString("base64url");
}

export function createInterfaceAuthService(dependencies: {
  credentials: CredentialStore;
  invites?: InviteStore;
  sessions: SessionStore;
  passwords: PasswordHasher;
  accessTokens: AccessTokenIssuer;
  refreshTokenTtlSeconds: number;
}): AuthService & { authenticate(context: RequestContext): Promise<SessionResponse> } {
  const loginResponse = async (user: AuthenticatedUser, session: AuthSession, refreshToken: string): Promise<LoginResponse> => {
    const access = await dependencies.accessTokens.issue(user, session);
    return { accessToken: access.token, refreshToken, expiresInSeconds: access.expiresInSeconds, user, session };
  };
  const authenticate = async (context: RequestContext): Promise<SessionResponse> => {
    if (!context.accessToken) throw new Error("unauthorized");
    const session = await dependencies.sessions.findByAccessToken(context.accessToken);
    if (!session) throw new Error("unauthorized");
    return session;
  };

  return {
    async login(input: LoginRequest): Promise<LoginResponse> {
      if (!input || typeof input.username !== "string" || typeof input.password !== "string") throw new Error("bad_request");
      const record = await dependencies.credentials.findByUsername(input.username);
      if (!record || !(await dependencies.passwords.verify(input.password, record.passwordHash))) {
        throw new Error("invalid_credentials");
      }
      const refreshToken = createRefreshToken();
      const sessionInput = {
        userId: record.user.id,
        refreshTokenHash: hashOpaqueToken(refreshToken),
        expiresAt: new Date(Date.now() + dependencies.refreshTokenTtlSeconds * 1000).toISOString(),
        ...(input.deviceName ? { deviceName: input.deviceName } : {}),
      };
      const session = await dependencies.sessions.create(sessionInput);
      return loginResponse(record.user, session, refreshToken);
    },
    async register(input: RegisterRequest): Promise<LoginResponse> {
      if (!dependencies.invites || typeof input?.inviteToken !== "string" || !input.inviteToken) throw new Error("bad_request");
      validateAccountInput(input.username, input.password, input.displayName);
      const invite = await dependencies.invites.findByTokenHash(hashOpaqueToken(input.inviteToken));
      if (!invite || invite.usedAt || invite.revokedAt || new Date(invite.expiresAt).getTime() <= Date.now()) {
        throw new Error("invalid_invite");
      }
      const createInput = {
        username: normalizeUsername(input.username),
        displayName: input.displayName?.trim() || input.username.trim(),
        passwordHash: await dependencies.passwords.hash(input.password),
      };
      const user = dependencies.credentials.createUserWithInvite
        ? await dependencies.credentials.createUserWithInvite({ ...createInput, inviteId: invite.id })
        : await dependencies.credentials.createUser(createInput).then(async (created) => {
          if (!await dependencies.invites!.markUsed(invite.id, new Date().toISOString())) throw new Error("invalid_invite");
          return created;
        });
      const refreshToken = createRefreshToken();
      const session = await dependencies.sessions.create({
        userId: user.id,
        refreshTokenHash: hashOpaqueToken(refreshToken),
        expiresAt: new Date(Date.now() + dependencies.refreshTokenTtlSeconds * 1000).toISOString(),
        ...(input.deviceName ? { deviceName: input.deviceName } : {}),
      });
      return loginResponse(user, session, refreshToken);
    },
    async refresh(input: RefreshRequest): Promise<LoginResponse> {
      if (!input || typeof input.refreshToken !== "string" || input.refreshToken.length < 20) throw new Error("invalid_refresh_token");
      const oldSession = await dependencies.sessions.findByRefreshTokenHash(hashOpaqueToken(input.refreshToken));
      if (!oldSession) {
        throw new Error("invalid_refresh_token");
      }
      if (oldSession.revokedAt) {
        await dependencies.sessions.revokeAll?.(oldSession.userId);
        throw new Error("invalid_refresh_token");
      }
      if (new Date(oldSession.expiresAt).getTime() <= Date.now()) throw new Error("invalid_refresh_token");
      const user = await dependencies.credentials.findByUserId(oldSession.userId);
      if (!user) throw new Error("invalid_refresh_token");
      const refreshToken = createRefreshToken();
      const sessionInput = {
        userId: oldSession.userId,
        refreshTokenHash: hashOpaqueToken(refreshToken),
        expiresAt: new Date(Date.now() + dependencies.refreshTokenTtlSeconds * 1000).toISOString(),
        ...(oldSession.deviceName ? { deviceName: oldSession.deviceName } : {}),
      };
      const session = dependencies.sessions.rotate
        ? await dependencies.sessions.rotate({ oldSessionId: oldSession.id, ...sessionInput })
        : await (async () => {
          const created = await dependencies.sessions.create(sessionInput);
          const rotated = dependencies.sessions.revokeIfActive
            ? await dependencies.sessions.revokeIfActive(oldSession.id, created.id)
            : (await dependencies.sessions.revoke(oldSession.id, created.id), true);
          if (!rotated) {
            await dependencies.sessions.revoke(created.id);
            return undefined;
          }
          return created;
        })();
      if (!session) {
        await dependencies.sessions.revokeAll?.(oldSession.userId);
        throw new Error("invalid_refresh_token");
      }
      return loginResponse(user, session, refreshToken);
    },
    async logout(input: LogoutRequest, context: RequestContext): Promise<void> {
      if (!input || typeof input !== "object") throw new Error("bad_request");
      const current = context.accessToken ? await dependencies.sessions.findByAccessToken(context.accessToken) : undefined;
      if (input.refreshToken) {
        const session = await dependencies.sessions.findByRefreshTokenHash(hashOpaqueToken(input.refreshToken));
        if (!session || (current && session.userId !== current.user.id)) throw new Error("unauthorized");
        if (dependencies.sessions.revokeFamily) await dependencies.sessions.revokeFamily(session.id);
        else if (session.revokedAt && dependencies.sessions.revokeAll) await dependencies.sessions.revokeAll(session.userId);
        else await dependencies.sessions.revoke(session.id);
        if (!current) return;
      }
      if (!current) throw new Error("unauthorized");
      await dependencies.sessions.revoke(current.session.id);
    },
    async getSession(context: RequestContext): Promise<SessionResponse> {
      return authenticate(context);
    },
    authenticate,
  };
}

function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

function validateAccountInput(username: string, password: string, displayName?: string): void {
  if (typeof username !== "string" || !/^[a-z0-9][a-z0-9_.-]{2,63}$/i.test(username.trim())) throw new Error("bad_request");
  if (typeof password !== "string" || password.length < 12 || password.length > 1024) throw new Error("bad_request");
  if (displayName !== undefined && (typeof displayName !== "string" || displayName.trim().length > 100)) throw new Error("bad_request");
}
