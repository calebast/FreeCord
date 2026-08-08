import test from "node:test";
import assert from "node:assert/strict";
import { Argon2PasswordHasher } from "./passwords.js";
import { createInterfaceAuthService, hashOpaqueToken, type CredentialRecord, type CredentialStore, type InviteRecord, type InviteStore, type SessionRecord, type SessionStore } from "./auth.js";
import type { AuthenticatedUser, AuthSession } from "./contracts.js";

const user: AuthenticatedUser = { id: "user-1", username: "alice", displayName: "Alice", role: "member", status: "active" };

class MemoryCredentials implements CredentialStore {
  records = new Map([[user.username, { user, passwordHash: "" } satisfies CredentialRecord]]);
  async findByUsername(username: string) { return this.records.get(username.toLowerCase()); }
  async findByUserId(id: string) { return id === user.id ? user : undefined; }
  async createUser(input: { username: string; displayName: string; passwordHash: string }) {
    if (this.records.has(input.username)) throw new Error("conflict");
    const created = { ...user, id: "user-2", username: input.username, displayName: input.displayName };
    this.records.set(created.username, { user: created, passwordHash: input.passwordHash });
    return created;
  }
}

class MemorySessions implements SessionStore {
  records = new Map<string, SessionRecord>();
  next = 1;
  async create(input: { userId: string; deviceName?: string; refreshTokenHash: string; expiresAt: string }) {
    const session = { id: `session-${this.next++}`, userId: input.userId, createdAt: new Date().toISOString(), expiresAt: input.expiresAt, refreshTokenHash: input.refreshTokenHash, ...(input.deviceName ? { deviceName: input.deviceName } : {}) };
    this.records.set(session.id, session);
    return session;
  }
  async findByRefreshTokenHash(hash: string) { return [...this.records.values()].find((record) => record.refreshTokenHash === hash); }
  async revoke(id: string) { const record = this.records.get(id); if (record) record.revokedAt = new Date().toISOString(); }
  async revokeIfActive(id: string, _replacement?: string) { const record = this.records.get(id); if (!record || record.revokedAt) return false; record.revokedAt = new Date().toISOString(); return true; }
  async revokeAll(userId: string) { for (const record of this.records.values()) if (record.userId === userId) record.revokedAt = new Date().toISOString(); }
  async revokeFamily(sessionId: string) { const record = this.records.get(sessionId); if (record) await this.revokeAll(record.userId); }
  async findByAccessToken(_token: string): Promise<{ user: AuthenticatedUser; session: AuthSession } | undefined> { return undefined; }
}

class MemoryInvites implements InviteStore {
  invite: InviteRecord = { id: "invite-1", tokenHash: hashOpaqueToken("invite-secret"), expiresAt: new Date(Date.now() + 60_000).toISOString() };
  async findByTokenHash(hash: string) { return hash === this.invite.tokenHash && !this.invite.usedAt ? this.invite : undefined; }
  async markUsed(id: string, usedAt: string) { if (id !== this.invite.id || this.invite.usedAt) return false; this.invite.usedAt = usedAt; return true; }
}

const accessTokens = { issue: async (_user: AuthenticatedUser, session: AuthSession) => ({ token: `access-${session.id}`, expiresInSeconds: 60 }) };

test("Argon2id hashes verify without storing the password", async () => {
  const hasher = new Argon2PasswordHasher();
  const encoded = await hasher.hash("a sufficiently long password");
  assert.match(encoded, /^\$argon2id\$/);
  assert.equal(await hasher.verify("a sufficiently long password", encoded), true);
  assert.equal(await hasher.verify("wrong password", encoded), false);
});

test("registration consumes an invite and refresh reuse revokes the session family", async () => {
  const passwords = new Argon2PasswordHasher();
  const credentials = new MemoryCredentials();
  credentials.records.get("alice")!.passwordHash = await passwords.hash("correct horse battery staple");
  const sessions = new MemorySessions();
  const invites = new MemoryInvites();
  const auth = createInterfaceAuthService({ credentials, sessions, invites, passwords, accessTokens, refreshTokenTtlSeconds: 3600 });

  const registered = await auth.register!({ inviteToken: "invite-secret", username: "bob", password: "correct horse battery staple", displayName: "Bob" }, { requestId: "test" });
  assert.equal(registered.user.username, "bob");
  await assert.rejects(() => auth.register!({ inviteToken: "invite-secret", username: "carol", password: "correct horse battery staple" }, { requestId: "test" }), /invalid_invite/);

  const loggedIn = await auth.login({ username: "alice", password: "correct horse battery staple" }, { requestId: "test" });
  const rotated = await auth.refresh({ refreshToken: loggedIn.refreshToken }, { requestId: "test" });
  assert.notEqual(rotated.refreshToken, loggedIn.refreshToken);
  await assert.rejects(() => auth.refresh({ refreshToken: loggedIn.refreshToken }, { requestId: "test" }), /invalid_refresh_token/);
  assert.ok([...sessions.records.values()].filter((record) => record.userId === user.id).every((record) => record.revokedAt));
});

test("logout can revoke the current rotating session with its refresh credential", async () => {
  const passwords = new Argon2PasswordHasher();
  const credentials = new MemoryCredentials();
  credentials.records.get("alice")!.passwordHash = await passwords.hash("correct horse battery staple");
  const sessions = new MemorySessions();
  const auth = createInterfaceAuthService({ credentials, sessions, passwords, accessTokens, refreshTokenTtlSeconds: 3600 });
  const loggedIn = await auth.login({ username: "alice", password: "correct horse battery staple" }, { requestId: "login" });

  await auth.logout({ refreshToken: loggedIn.refreshToken }, { requestId: "logout" });

  await assert.rejects(() => auth.refresh({ refreshToken: loggedIn.refreshToken }, { requestId: "refresh" }), /invalid_refresh_token/);
  assert.equal([...sessions.records.values()].filter((record) => record.userId === user.id).every((record) => Boolean(record.revokedAt)), true);
});

test("logout with a rotated predecessor revokes its replacement family", async () => {
  const passwords = new Argon2PasswordHasher();
  const credentials = new MemoryCredentials();
  credentials.records.get("alice")!.passwordHash = await passwords.hash("correct horse battery staple");
  const sessions = new MemorySessions();
  const auth = createInterfaceAuthService({ credentials, sessions, passwords, accessTokens, refreshTokenTtlSeconds: 3600 });
  const loggedIn = await auth.login({ username: "alice", password: "correct horse battery staple" }, { requestId: "login" });
  const rotated = await auth.refresh({ refreshToken: loggedIn.refreshToken }, { requestId: "refresh" });

  await auth.logout({ refreshToken: loggedIn.refreshToken }, { requestId: "logout" });

  await assert.rejects(() => auth.refresh({ refreshToken: rotated.refreshToken }, { requestId: "replacement" }), /invalid_refresh_token/);
});
