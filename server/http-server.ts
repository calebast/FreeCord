import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { loadConfig, type ServerConfig } from "./env.js";
import { createDatabase, type DatabaseBoundary } from "./database.js";
import { createLocalApi, type LocalApi } from "./local-adapter.js";
import type { AuthenticatedUser, AddReactionRequest, CommunityMembersResponse, CommunityRoleMetadata, CreateChannelRequest, CreateInviteRequest, CreateMessageRequest, EditMessageRequest, Message, MessageAttachment, MessageReaction, MessagesResponse, RequestContext, UserStatus } from "./contracts.js";
import { Argon2PasswordHasher } from "./passwords.js";
import type { PasswordHasher } from "./auth.js";
import { PostgresAccessTokenIssuer, PostgresCredentialStore, PostgresInviteStore, PostgresSessionStore, bootstrapInitialAdmin } from "./postgres-auth.js";
import { createInterfaceAuthService } from "./auth.js";
import { InMemoryRateLimiter, type RateLimiter } from "./rate-limiter.js";
import { OfficialLiveKitTokenIssuer, PostgresChannelAuthorizer } from "./postgres-voice.js";
import { effectiveAccess, requireChannelPermission, requirePermission, resolveChannelPermission } from "./authorization.js";
import { assignRole, createRole, deleteRole, listPermissions, listRoles, updateRole, validateRoleInput, type RoleInput } from "./community-admin.js";
import { MediaService, writeMediaResponse } from "./media.js";
import { createRoomAdmin, VoiceModerationService } from "./voice-moderation.js";
import { updateOwnDisplayName, validateDisplayName, validatePasswordChange } from "./account-profile.js";
import { RealtimeBroker } from "./realtime.js";
import { listAuditEvents, writeAuditEvent } from "./audit-log.js";
import { listSharedFiles } from "./server-files.js";
import { clearMemberVoiceRestrictions, deactivateMemberAccount, resetMemberPassword } from "./account-admin.js";

export interface ApiRuntime {
  api: LocalApi;
  database: DatabaseBoundary;
  config: ServerConfig;
  authenticate?(context: RequestContext): Promise<AuthenticatedUser>;
  ready?: Promise<void>;
  rateLimiter?: RateLimiter;
  chatRateLimiter?: RateLimiter;
  media?: MediaService;
  voiceModeration?: VoiceModerationService;
  passwordHasher?: PasswordHasher;
  realtime?: RealtimeBroker;
}

function json(response: ServerResponse, status: number, body: unknown, requestId: string): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-request-id", requestId);
  response.end(JSON.stringify(body));
}

function errorCode(error: unknown): number {
  if (error instanceof Error && error.message === "rate_limited") return 429;
  if (error instanceof SyntaxError || error instanceof Error && ["request_body_too_large", "bad_request"].includes(error.message)) return 400;
  if (error instanceof Error && ["unauthorized", "invalid_credentials", "invalid_refresh_token", "invalid_invite"].includes(error.message)) return 401;
  if (error instanceof Error && error.message === "conflict") return 409;
  if (typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "23505") return 409;
  if (error instanceof Error && error.message === "forbidden") return 403;
  if (error instanceof Error && error.message === "not_found") return 404;
  return 500;
}

function validateStatus(input: unknown): UserStatus {
  const status = (input as { status?: unknown } | null)?.status;
  if (status !== "active" && status !== "busy" && status !== "away") throw new Error("bad_request");
  return status;
}

function validateChannel(input: unknown): CreateChannelRequest {
  const value = input as Partial<CreateChannelRequest> | null;
  if (!value || typeof value.name !== "string" || typeof value.type !== "string") throw new Error("bad_request");
  const name = value.name.trim();
  if (!name || name.length > 100 || /[\u0000-\u001f\u007f]/u.test(name)) throw new Error("bad_request");
  if (value.type !== "text" && value.type !== "voice") throw new Error("bad_request");
  return { name, type: value.type };
}

async function createCommunityChannel(database: DatabaseBoundary, userId: string, input: CreateChannelRequest) {
  if (!database.transaction) throw new Error("database_transaction_not_configured");
  return database.transaction(async (transaction) => {
    const community = await transaction.query<{ id: string }>(
      `SELECT cm.community_id AS id
         FROM community_members cm
        WHERE cm.user_id = $1 AND NOT cm.is_banned
          AND EXISTS (
            SELECT 1 FROM member_roles mr
            JOIN role_permissions rp ON rp.role_id = mr.role_id
            WHERE mr.community_id = cm.community_id AND mr.user_id = $1
              AND rp.permission_key IN ('channels.manage', $2) AND rp.granted
          )
        LIMIT 1`, [userId, input.type === "text" ? "channels.text.create" : "channels.voice.create"],
    );
    const communityId = community.rows[0]?.id;
    if (!communityId) throw new Error("forbidden");

    // Lock the single community row so position allocation is serialized.
    await transaction.query(`SELECT id FROM communities WHERE id = $1 FOR UPDATE`, [communityId]);
    const position = await transaction.query<{ next_position: number }>(
      `SELECT COALESCE(MAX(position), -1) + 1 AS next_position FROM channels WHERE community_id = $1 AND type = $2`,
      [communityId, input.type],
    );
    const channel = await transaction.query<{ id: string; community_id: string; name: string; type: "text" | "voice"; position: number }>(
      `INSERT INTO channels (community_id, name, type, position)
       VALUES ($1, $2, $3, $4)
       RETURNING id, community_id, name, type, position`,
      [communityId, input.name, input.type, position.rows[0]?.next_position ?? 0],
    );
    const created = channel.rows[0];
    if (!created) throw new Error("internal_error");
    if (created.type === "voice") {
      await transaction.query(
        `INSERT INTO voice_channel_bindings (community_id, channel_id, livekit_room_id)
         VALUES ($1, $2, $3)`, [communityId, created.id, `freecord:${communityId}:${created.id}`],
      );
    }
    await writeAuditEvent(transaction, {
      communityId,
      actorId: userId,
      action: "channel.created",
      targetType: "channel",
      targetId: created.id,
      metadata: { name: created.name, type: created.type },
    });
    return { id: created.id, communityId: created.community_id, name: created.name, type: created.type, position: created.position, canRead: true };
  });
}

async function archiveCommunityChannel(database: DatabaseBoundary, userId: string, channelId: string): Promise<{ communityId: string }> {
  if (!database.transaction) throw new Error("database_transaction_not_configured");
  return database.transaction(async (transaction) => {
    const result = await transaction.query<{ id: string; community_id: string; name: string; type: "text" | "voice" }>(
      `UPDATE channels c SET is_archived = true, updated_at = now()
         WHERE c.id = $1
           AND EXISTS (SELECT 1 FROM community_members cm WHERE cm.community_id = c.community_id AND cm.user_id = $2 AND NOT cm.is_banned)
           AND EXISTS (SELECT 1 FROM member_roles mr JOIN role_permissions rp ON rp.role_id = mr.role_id
                      WHERE mr.community_id = c.community_id AND mr.user_id = $2
                        AND rp.permission_key = 'channels.manage' AND rp.granted)
         RETURNING c.id, c.community_id, c.name, c.type`, [channelId, userId],
    );
    const channel = result.rows[0];
    if (!channel) throw new Error("not_found");
    await writeAuditEvent(transaction, {
      communityId: channel.community_id,
      actorId: userId,
      action: "channel.archived",
      targetType: "channel",
      targetId: channel.id,
      metadata: { name: channel.name, type: channel.type },
    });
    return { communityId: channel.community_id };
  });
}

async function updateCommunityChannel(database: DatabaseBoundary, userId: string, channelId: string, nameInput: unknown) {
  const name = validateDisplayName(nameInput);
  if (!database.transaction) throw new Error("database_transaction_not_configured");
  return database.transaction(async (transaction) => {
    const result = await transaction.query<{ id: string; community_id: string; name: string; type: "text" | "voice"; position: number }>(
      `UPDATE channels c SET name = $1, updated_at = now()
         WHERE c.id = $2 AND NOT c.is_archived
           AND EXISTS (SELECT 1 FROM community_members cm WHERE cm.community_id = c.community_id AND cm.user_id = $3 AND NOT cm.is_banned)
           AND EXISTS (SELECT 1 FROM member_roles mr JOIN role_permissions rp ON rp.role_id = mr.role_id
                      WHERE mr.community_id = c.community_id AND mr.user_id = $3
                        AND rp.permission_key = 'channels.manage' AND rp.granted)
         RETURNING c.id, c.community_id, c.name, c.type, c.position`,
      [name, channelId, userId],
    );
    const channel = result.rows[0];
    if (!channel) throw new Error("not_found");
    await writeAuditEvent(transaction, {
      communityId: channel.community_id,
      actorId: userId,
      action: "channel.updated",
      targetType: "channel",
      targetId: channel.id,
      metadata: { name: channel.name, type: channel.type },
    });
    return { id: channel.id, communityId: channel.community_id, name: channel.name, type: channel.type, position: channel.position, canRead: true };
  });
}

async function body(request: IncomingMessage, maxBytes = 2 * 1024 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new Error("request_body_too_large");
    chunks.push(buffer);
  }
  if (!size) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function bearer(request: IncomingMessage): string | undefined {
  const value = request.headers.authorization;
  return value?.startsWith("Bearer ") ? value.slice(7).trim() || undefined : undefined;
}

function mutationRateLimitRoute(pathname: string): string | undefined {
  if (["/v1/auth/login", "/v1/auth/register", "/v1/auth/refresh", "/v1/invites", "/v1/auth/profile/status", "/v1/users/me/profile", "/v1/users/me/password", "/v1/community/channels", "/v1/community/roles", "/v1/media/uploads", "/v1/users/me/avatar", "/v1/community/emotes"].includes(pathname)) return pathname;
  if (/^\/v1\/community\/channels\/[^/]+$/.test(pathname)) return "/v1/community/channels/:channelId";
  if (/^\/v1\/community\/roles\/[^/]+$/.test(pathname)) return "/v1/community/roles/:roleId";
  if (/^\/v1\/community\/members\/[^/]+\/roles\/[^/]+$/.test(pathname)) return "/v1/community/members/:userId/roles/:roleId";
  if (/^\/v1\/community\/members\/[^/]+\/(?:password-reset|deactivate|voice-restrictions)$/.test(pathname)) return "/v1/community/members/:userId/account-administration";
  if (/^\/v1\/community\/emotes\/[^/]+$/.test(pathname)) return "/v1/community/emotes/:emoteId";
  if (/^\/v1\/channels\/[^/]+\/voice-token$/.test(pathname)) return "/v1/channels/:channelId/voice-token";
  if (/^\/v1\/channels\/[^/]+\/voice\/participants\/[^/]+\/(?:mute|disconnect|move)$/.test(pathname)) return "/v1/channels/:channelId/voice/participants/:userId/moderation";
  if (/^\/v1\/channels\/[^/]+\/messages(?:\/[^/]+(?:\/reactions(?:\/[^/]+)?)?)?$/.test(pathname)) return "/v1/channels/:channelId/messages";
  return undefined;
}

async function authorizeTextChannel(database: DatabaseBoundary, userId: string, channelId: string, write: boolean) {
  return requireChannelPermission(database, userId, channelId, write ? "messages.write" : "messages.read", "text");
}

async function authorizeMessageMutation(database: DatabaseBoundary, userId: string, channelId: string, messageId: string) {
  const write = await resolveChannelPermission(database, userId, channelId, "messages.write", "text");
  const result = await database.query<Record<string, unknown>>(
    `SELECT m.author_id FROM messages m WHERE m.id = $1 AND m.channel_id = $2`,
    [messageId, channelId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("not_found");
  const isAuthor = String(row.author_id) === userId;
  const canManage = !isAuthor
    && (await resolveChannelPermission(database, userId, channelId, "messages.manage", "text")).allowed;
  if ((!isAuthor && !canManage) || (!write.allowed && !canManage)) throw new Error("forbidden");
  return { communityId: write.communityId, isAuthor };
}

async function changeOwnPasswordAudited(
  database: DatabaseBoundary,
  passwordHasher: PasswordHasher,
  userId: string,
  currentSessionId: string,
  input: unknown,
): Promise<string> {
  if (!database.transaction) throw new Error("database_transaction_not_configured");
  const value = validatePasswordChange(input);
  return database.transaction(async (transaction) => {
    const access = await effectiveAccess(transaction, userId);
    const current = await transaction.query<{ password_hash: string }>(
      `SELECT password_hash FROM users WHERE id = $1 AND is_active FOR UPDATE`, [userId],
    );
    const passwordHash = current.rows[0]?.password_hash;
    if (!passwordHash || !await passwordHasher.verify(value.currentPassword, passwordHash)) throw new Error("invalid_credentials");
    const nextHash = await passwordHasher.hash(value.newPassword);
    await transaction.query(`UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2 AND is_active`, [nextHash, userId]);
    await transaction.query(
      `UPDATE user_sessions
          SET revoked_at = COALESCE(revoked_at, now()),
              revocation_reason = COALESCE(revocation_reason, 'password_changed')
        WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL`,
      [userId, currentSessionId],
    );
    await writeAuditEvent(transaction, { communityId: access.communityId, actorId: userId, action: "account.password_changed", targetType: "user", targetId: userId });
    return access.communityId;
  });
}

function validateEncryptedPayload(input: unknown): EditMessageRequest {
  const value = input as Partial<EditMessageRequest> | null;
  if (!value || typeof value.ciphertext !== "string" || typeof value.nonce !== "string"
    || value.ciphertext.length < 1 || value.ciphertext.length > 750000
    || value.nonce.length < 1 || value.nonce.length > 100) throw new Error("bad_request");
  return { ciphertext: value.ciphertext, nonce: value.nonce };
}

type ReactionTarget = { kind: "unicode"; value: string } | { kind: "emote"; emoteId: string };

function validateReaction(input: unknown): ReactionTarget {
  const value = input as AddReactionRequest | null;
  if (!value) throw new Error("bad_request");
  const rawUnicode = typeof value.unicode === "string" ? value.unicode : value.emoji;
  const hasUnicode = typeof rawUnicode === "string";
  const hasEmote = typeof value.emoteId === "string";
  if (hasUnicode === hasEmote) throw new Error("bad_request");
  if (hasEmote) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value.emoteId!)) throw new Error("bad_request");
    return { kind: "emote", emoteId: value.emoteId! };
  }
  const emoji = rawUnicode!.normalize("NFC").trim();
  if (!emoji || [...emoji].length > 8 || emoji.length > 32 || /[\u0000-\u001f\u007f]/u.test(emoji)) throw new Error("bad_request");
  return { kind: "unicode", value: emoji };
}

function messageFromRow(row: Record<string, unknown>): Message {
  const editedAt = row.edited_at == null ? undefined : new Date(String(row.edited_at)).toISOString();
  const content = row.content == null ? undefined : String(row.content);
  const ciphertext = row.ciphertext == null ? undefined : String(row.ciphertext);
  const nonce = row.nonce == null ? undefined : String(row.nonce);
  const deletedAt = row.deleted_at == null ? undefined : new Date(String(row.deleted_at)).toISOString();
  const reactions = Array.isArray(row.reactions) ? row.reactions.map((reaction): MessageReaction => {
    const value = reaction as Record<string, unknown>;
    if (value.customEmoteId) {
      return { target: { kind: "emote", emoteId: String(value.customEmoteId) }, count: Number(value.count), reacted: value.reacted === true,
        emote: { id: String(value.customEmoteId), name: String(value.emoteName), animated: false,
          media: { id: String(value.mediaId), contentType: String(value.contentType),
            ...(value.width == null ? {} : { width: Number(value.width) }), ...(value.height == null ? {} : { height: Number(value.height) }),
            version: new Date(String(value.mediaVersion)).toISOString() } } };
    }
    return { emoji: String(value.emoji), target: { kind: "unicode", value: String(value.emoji) }, count: Number(value.count), reacted: value.reacted === true };
  }) : undefined;
  const attachments = Array.isArray(row.attachments) ? row.attachments.map((attachment): MessageAttachment => {
    const value = attachment as Record<string, unknown>;
    return {
      media: {
        id: String(value.mediaId),
        contentType: String(value.contentType),
        ...(value.width == null ? {} : { width: Number(value.width) }),
        ...(value.height == null ? {} : { height: Number(value.height) }),
        version: new Date(String(value.version)).toISOString(),
      },
      byteSize: Number(value.byteSize),
      encrypted: value.encrypted === true,
      position: Number(value.position),
    };
  }) : undefined;
  return {
    id: String(row.id), channelId: String(row.channel_id), authorId: String(row.author_id),
    authorUsername: String(row.author_username), authorDisplayName: String(row.author_display_name),
    ...(content ? { content } : {}), ...(ciphertext ? { ciphertext } : {}), ...(nonce ? { nonce } : {}),
    createdAt: new Date(String(row.created_at)).toISOString(),
    ...(editedAt ? { editedAt } : {}),
    ...(deletedAt ? { deletedAt } : {}),
    ...(reactions?.length ? { reactions } : {}),
    ...(attachments?.length ? { attachments } : {}),
  };
}

function messageSelect(): string {
  return `m.id, m.channel_id, m.author_id, u.username AS author_username,
          u.display_name AS author_display_name,
          CASE WHEN m.deleted_at IS NULL THEN m.content END AS content,
          CASE WHEN m.deleted_at IS NULL THEN m.ciphertext END AS ciphertext,
          CASE WHEN m.deleted_at IS NULL THEN m.nonce END AS nonce,
          m.created_at, m.edited_at, m.deleted_at,
          CASE WHEN m.deleted_at IS NULL THEN
            COALESCE((SELECT json_agg(json_build_object(
                         'emoji', grouped.emoji, 'customEmoteId', grouped.custom_emote_id,
                         'emoteName', grouped.emote_name, 'mediaId', grouped.media_id,
                         'contentType', grouped.content_type, 'width', grouped.width, 'height', grouped.height,
                         'mediaVersion', grouped.media_version,
                         'count', grouped.reaction_count, 'reacted', grouped.reacted)
                       ORDER BY COALESCE(grouped.emoji, grouped.emote_name), grouped.custom_emote_id)
                        FROM (SELECT mr.emoji, mr.custom_emote_id, ce.name AS emote_name, mo.id AS media_id,
                                     mo.content_type, mo.width, mo.height, mo.ready_at AS media_version,
                                     count(*)::int AS reaction_count, bool_or(mr.user_id = $2) AS reacted
                                FROM message_reactions mr
                                LEFT JOIN custom_emotes ce ON ce.id = mr.custom_emote_id
                                LEFT JOIN media_objects mo ON mo.id = ce.media_id AND mo.state = 'ready'
                               WHERE mr.message_id = m.id
                               GROUP BY mr.emoji, mr.custom_emote_id, ce.name, mo.id, mo.content_type, mo.width, mo.height, mo.ready_at) grouped), '[]'::json)
          ELSE '[]'::json END AS reactions,
          CASE WHEN m.deleted_at IS NULL THEN
            COALESCE((SELECT json_agg(json_build_object(
                         'mediaId', mo.id, 'contentType', mo.content_type,
                         'byteSize', mo.byte_size, 'encrypted', mo.encrypted,
                         'width', mo.width, 'height', mo.height,
                         'version', mo.ready_at, 'position', ma.position)
                       ORDER BY ma.position, mo.id)
                        FROM message_attachments ma
                        JOIN media_objects mo ON mo.id = ma.media_id
                         AND mo.state = 'ready' AND mo.deleted_at IS NULL
                       WHERE ma.message_id = m.id), '[]'::json)
          ELSE '[]'::json END AS attachments`;
}

function encodeMessageCursor(row: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify({ id: String(row.id), createdAt: new Date(String(row.created_at)).toISOString() }), "utf8").toString("base64url");
}

function decodeMessageCursor(value: string | null): { id: string; createdAt: string } | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { id?: unknown; createdAt?: unknown };
    if (typeof parsed.id !== "string" || typeof parsed.createdAt !== "string" || Number.isNaN(Date.parse(parsed.createdAt))) throw new Error("bad_cursor");
    return { id: parsed.id, createdAt: new Date(parsed.createdAt).toISOString() };
  } catch {
    throw new Error("bad_request");
  }
}

export function createApiRuntime(overrides: Partial<ApiRuntime> = {}): ApiRuntime {
  const config = loadConfig();
  const database = overrides.database ?? createDatabase(config.databaseUrl, config.databaseSsl);
  const realtime = overrides.realtime ?? new RealtimeBroker(database);
  const passwordHasher = overrides.passwordHasher ?? new Argon2PasswordHasher();
  const media = overrides.media ?? new MediaService(database, config);
  const voiceModeration = overrides.voiceModeration ?? new VoiceModerationService(
    database,
    createRoomAdmin(config.livekitApiUrl, config.livekitApiKey, config.livekitApiSecret),
    config.livekitTokenTtlSeconds,
  );
  let authenticate: ApiRuntime["authenticate"];
  let ready = Promise.resolve();
  const api = overrides.api ?? (() => {
    if (!database.configured || !config.sessionSecret) {
      return createLocalApi({
        auth: { login: async () => { throw new Error("auth_not_configured"); }, refresh: async () => { throw new Error("auth_not_configured"); }, logout: async () => {}, getSession: async () => { throw new Error("auth_not_configured"); } },
        community: { getCommunity: async () => { throw new Error("community_not_configured"); }, listChannels: async () => { throw new Error("community_not_configured"); } },
        channelAuthorizer: { authorizeVoiceJoin: async () => { throw new Error("authorization_not_configured"); } },
        livekit: { issue: async () => { throw new Error("livekit_not_configured"); } },
        version: config.version,
      });
    }
    const tokens = new PostgresAccessTokenIssuer(config.sessionSecret, config.accessTokenTtlSeconds);
    const credentials = new PostgresCredentialStore(database);
    const sessions = new PostgresSessionStore(database, tokens);
    const inviteStore = new PostgresInviteStore(database);
    const auth = createInterfaceAuthService({ credentials, sessions, passwords: passwordHasher, accessTokens: tokens, invites: inviteStore, refreshTokenTtlSeconds: config.refreshTokenTtlSeconds });
    authenticate = async (context) => (await auth.authenticate(context)).user;
    if (config.initialAdminUsername && config.initialAdminPassword) {
      const bootstrapPassword = config.initialAdminPassword;
      delete config.initialAdminPassword;
      ready = passwordHasher.hash(bootstrapPassword).then((hash) => bootstrapInitialAdmin(database, config.initialAdminUsername!, hash));
    }
    const localApi = createLocalApi({ auth,
    community: {
      getCommunity: async (context) => {
        const community = await database.query<{ id: string; name: string }>("SELECT id, name FROM communities ORDER BY created_at, id LIMIT 1");
        if (!community.rows[0] || !context.user) throw new Error("community_not_initialized");
        return { community: { id: community.rows[0].id, name: community.rows[0].name, selfHosted: true }, currentUser: context.user };
      },
      listChannels: async (context) => {
        if (!context.user) throw new Error("unauthorized");
        const result = await database.query<{ id: string; community_id: string; name: string; type: "text" | "voice"; position: number }>(
          `SELECT c.id, c.community_id, c.name, c.type, c.position
           FROM channels c JOIN community_members cm ON cm.community_id = c.community_id AND cm.user_id = $1
           WHERE NOT c.is_archived AND NOT (cm.is_banned AND (cm.banned_until IS NULL OR cm.banned_until > now()))
           ORDER BY c.type, c.position, c.created_at, c.id`,
          [context.user.id],
        );
        const channels = await Promise.all(result.rows.map(async (row) => {
          if (row.type === "text") {
            const read = await resolveChannelPermission(database, context.user!.id, row.id, "messages.read", "text");
            return read.allowed ? { id: row.id, communityId: row.community_id, name: row.name, type: row.type, position: row.position, canRead: true } : undefined;
          }
          const connect = await resolveChannelPermission(database, context.user!.id, row.id, "voice.connect", "voice");
          const publish = await resolveChannelPermission(database, context.user!.id, row.id, "voice.speak", "voice");
          return connect.allowed
            ? { id: row.id, communityId: row.community_id, name: row.name, type: row.type, position: row.position, canRead: true, canConnect: true, canPublish: publish.allowed }
            : undefined;
        }));
        return { channels: channels.filter((channel): channel is NonNullable<typeof channel> => channel !== undefined) };
      },
    },
    channelAuthorizer: new PostgresChannelAuthorizer(database),
    livekit: config.livekitUrl && config.livekitApiKey && config.livekitApiSecret
      ? new OfficialLiveKitTokenIssuer({ url: config.livekitUrl, apiKey: config.livekitApiKey, apiSecret: config.livekitApiSecret, ttlSeconds: config.livekitTokenTtlSeconds })
      : { issue: async () => { throw new Error("livekit_not_configured"); } },
    healthChecks: {
      database: database.configured ? "ok" : "not-configured",
      livekit: config.livekitUrl && config.livekitApiKey && config.livekitApiSecret ? "ok" : "not-configured",
    },
    version: config.version,
    });
    (localApi as LocalApiWithInvite).createInvite = async (createdBy, expiresInSeconds) => {
      if (!database.transaction) throw new Error("database_transaction_not_configured");
      const result = await database.transaction(async (transaction) => {
        const community = await transaction.query<{ id: string }>("SELECT id FROM communities ORDER BY created_at, id LIMIT 1");
        const communityId = community.rows[0]?.id;
        if (!communityId) throw new Error("community_not_initialized");
        const expiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();
        const invite = await new PostgresInviteStore(transaction).create({ communityId, createdBy, expiresAt });
        await writeAuditEvent(transaction, {
          communityId,
          actorId: createdBy,
          action: "invite.created",
          metadata: { expiresAt },
        });
        return { invite, communityId };
      });
      await realtime.publish({ kind: "audit.changed", communityId: result.communityId, actorId: createdBy });
      return result.invite;
    };
    return localApi;
  })();
  return { config, database, api, rateLimiter: new InMemoryRateLimiter({ windowMs: 60_000, max: 60, maxKeys: 10_000 }), chatRateLimiter: new InMemoryRateLimiter({ windowMs: 60_000, max: 180, maxKeys: 10_000 }), media, voiceModeration, realtime, ...(authenticate ? { authenticate } : {}), ready, passwordHasher, ...overrides };
}

export function createHttpServer(runtime: ApiRuntime): Server {
  // JSON/base64 uploads temporarily occupy more memory than their decoded
  // payload. Keep the single-instance Compose API bounded before reading the
  // body; the database reservation in MediaService provides the cross-process
  // quota boundary.
  const activeMediaUploads = new Set<string>();
  const maxConcurrentMediaUploads = 4;
  const realtime = runtime.realtime ?? new RealtimeBroker(runtime.database);
  const server = createServer(async (request, response) => {
    const requestId = randomUUID();
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    response.setHeader("x-content-type-options", "nosniff");
    const origin = request.headers.origin;
    if (origin && runtime.config.allowedOrigins.includes(origin)) {
      response.setHeader("access-control-allow-origin", origin);
      response.setHeader("vary", "Origin");
    }

    if (request.method === "OPTIONS") {
      if (origin && !runtime.config.allowedOrigins.includes(origin)) {
        response.statusCode = 403;
        response.end();
        return;
      }
      response.statusCode = 204;
      response.setHeader("access-control-allow-headers", "authorization, content-type");
      response.setHeader("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
      response.end();
      return;
    }

    try {
      await runtime.ready;
      if (request.method === "GET" && url.pathname === "/health") {
        json(response, 200, runtime.api.health(), requestId);
        return;
      }
      const publicCredentialRoute = request.method === "POST" && ["/v1/auth/login", "/v1/auth/register", "/v1/auth/refresh", "/v1/auth/logout"].includes(url.pathname);
      const suppliedAccessToken = bearer(request);
      const accessToken = publicCredentialRoute ? undefined : suppliedAccessToken;
      const context: RequestContext = { requestId, ...(accessToken ? { accessToken } : {}) };
      if (runtime.authenticate && accessToken) {
        context.user = await runtime.authenticate(context);
      }
      const routeKey = (request.method === "POST" || request.method === "PUT" || request.method === "PATCH" || request.method === "DELETE")
        ? mutationRateLimitRoute(url.pathname) : undefined;
      const routeLimiter = routeKey === "/v1/channels/:channelId/messages" ? runtime.chatRateLimiter ?? runtime.rateLimiter : runtime.rateLimiter;
      if (routeKey && routeLimiter) {
        const actorKey = context.user?.id ?? request.socket.remoteAddress ?? "unknown";
        const key = `${actorKey}:${routeKey}`;
        const result = routeLimiter.consume(key);
        if (!result.allowed) {
          response.setHeader("retry-after", String(result.retryAfterSeconds));
          throw new Error("rate_limited");
        }
      }
      if (request.method === "GET" && url.pathname === "/v1/realtime/events") {
        if (!context.user || !accessToken || !runtime.authenticate) throw new Error("unauthorized");
        const authenticatedUserId = context.user.id;
        await realtime.subscribe(request, response, authenticatedUserId, {
          maxConnectionMs: runtime.config.accessTokenTtlSeconds * 1000,
          revalidate: async () => {
            const current = await runtime.authenticate!({ requestId, accessToken });
            if (current.id !== authenticatedUserId) throw new Error("unauthorized");
          },
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/auth/login") {
        json(response, 200, await runtime.api.auth.login(await body(request) as never, context), requestId);
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/auth/register") {
        json(response, 200, await runtime.api.auth.register(await body(request) as never, context), requestId);
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/invites") {
        if (!context.user) throw new Error("unauthorized");
        await requirePermission(runtime.database, context.user.id, "invites.manage");
        const inviteApi = runtime.api as LocalApiWithInvite;
        if (!inviteApi.createInvite) throw new Error("invites_not_configured");
        const input = await body(request) as CreateInviteRequest;
        const expiresInSeconds = input?.expiresInSeconds ?? 7 * 24 * 60 * 60;
        if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 300 || expiresInSeconds > 30 * 24 * 60 * 60) throw new Error("bad_request");
        json(response, 201, await inviteApi.createInvite(context.user.id, expiresInSeconds), requestId);
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/auth/refresh") {
        json(response, 200, await runtime.api.auth.refresh(await body(request) as never, context), requestId);
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/auth/logout") {
        await runtime.api.auth.logout(await body(request) as never, context);
        response.statusCode = 204;
        response.end();
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/auth/session") {
        json(response, 200, await runtime.api.auth.session(context), requestId);
        return;
      }
      if (request.method === "PATCH" && url.pathname === "/v1/auth/profile/status") {
        if (!context.user) throw new Error("unauthorized");
        const status = validateStatus(await body(request));
        const result = await runtime.database.query(`UPDATE users SET status = $1, updated_at = now() WHERE id = $2 AND is_active RETURNING id`, [status, context.user.id]);
        if (!result.rows[0]) throw new Error("unauthorized");
        const access = await effectiveAccess(runtime.database, context.user.id);
        await realtime.publish({ kind: "members.changed", communityId: access.communityId, actorId: context.user.id });
        json(response, 200, { user: { ...context.user, status } }, requestId);
        return;
      }
      if (request.method === "PATCH" && url.pathname === "/v1/users/me/profile") {
        if (!context.user) throw new Error("unauthorized");
        const input = await body(request) as { displayName?: unknown };
        await updateOwnDisplayName(runtime.database, context.user.id, input?.displayName);
        const user = await new PostgresCredentialStore(runtime.database).findByUserId(context.user.id);
        if (!user) throw new Error("unauthorized");
        const access = await effectiveAccess(runtime.database, context.user.id);
        await realtime.publish({ kind: "members.changed", communityId: access.communityId, actorId: context.user.id });
        json(response, 200, { user }, requestId);
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/users/me/password") {
        if (!context.user || !runtime.passwordHasher) throw new Error("unauthorized");
        const currentSession = await runtime.api.auth.session(context);
        const communityId = await changeOwnPasswordAudited(runtime.database, runtime.passwordHasher, context.user.id, currentSession.session.id, await body(request));
        await realtime.publish({ kind: "audit.changed", communityId, actorId: context.user.id });
        json(response, 200, { ok: true }, requestId);
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/community") {
        json(response, 200, await runtime.api.community.get(context), requestId);
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/community/channels") {
        json(response, 200, await runtime.api.community.channels(context), requestId);
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/community/files") {
        if (!context.user) throw new Error("unauthorized");
        const rawLimit = Number(url.searchParams.get("limit") ?? "50");
        json(response, 200, await listSharedFiles(runtime.database, context.user.id, {
          limit: Number.isInteger(rawLimit) ? rawLimit : 50,
          ...(url.searchParams.get("before") ? { before: url.searchParams.get("before")! } : {}),
          ...(url.searchParams.get("channelId") ? { channelId: url.searchParams.get("channelId")! } : {}),
        }), requestId);
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/community/audit-log") {
        if (!context.user) throw new Error("unauthorized");
        const rawLimit = Number(url.searchParams.get("limit") ?? "50");
        json(response, 200, await listAuditEvents(runtime.database, context.user.id, {
          limit: Number.isInteger(rawLimit) ? rawLimit : 50,
          ...(url.searchParams.get("before") ? { before: url.searchParams.get("before")! } : {}),
        }), requestId);
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/community/permissions") {
        if (!context.user) throw new Error("unauthorized");
        json(response, 200, await listPermissions(runtime.database, context.user.id), requestId);
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/community/roles") {
        if (!context.user) throw new Error("unauthorized");
        json(response, 200, await listRoles(runtime.database, context.user.id), requestId);
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/community/roles") {
        if (!context.user) throw new Error("unauthorized");
        const input = validateRoleInput(await body(request)) as RoleInput;
        const result = await createRole(runtime.database, context.user.id, input);
        const access = await effectiveAccess(runtime.database, context.user.id);
        await Promise.all([
          realtime.publish({ kind: "roles.changed", communityId: access.communityId, actorId: context.user.id }),
          realtime.publish({ kind: "audit.changed", communityId: access.communityId, actorId: context.user.id }),
        ]);
        json(response, 201, result, requestId);
        return;
      }
      const roleMatch = /^\/v1\/community\/roles\/([^/]+)$/.exec(url.pathname);
      if (roleMatch?.[1] && (request.method === "PATCH" || request.method === "DELETE")) {
        if (!context.user) throw new Error("unauthorized");
        const roleId = decodeURIComponent(roleMatch[1]);
        if (request.method === "PATCH") {
          const result = await updateRole(runtime.database, context.user.id, roleId, validateRoleInput(await body(request), true));
          const access = await effectiveAccess(runtime.database, context.user.id);
          await Promise.all([
            realtime.publish({ kind: "roles.changed", communityId: access.communityId, actorId: context.user.id }),
            realtime.publish({ kind: "audit.changed", communityId: access.communityId, actorId: context.user.id }),
          ]);
          json(response, 200, result, requestId);
        } else {
          await deleteRole(runtime.database, context.user.id, roleId);
          const access = await effectiveAccess(runtime.database, context.user.id);
          await Promise.all([
            realtime.publish({ kind: "roles.changed", communityId: access.communityId, actorId: context.user.id }),
            realtime.publish({ kind: "audit.changed", communityId: access.communityId, actorId: context.user.id }),
          ]);
          json(response, 200, { ok: true }, requestId);
        }
        return;
      }
      const memberRoleMatch = /^\/v1\/community\/members\/([^/]+)\/roles\/([^/]+)$/.exec(url.pathname);
      if (memberRoleMatch?.[1] && memberRoleMatch[2] && (request.method === "PUT" || request.method === "DELETE")) {
        if (!context.user) throw new Error("unauthorized");
        await assignRole(runtime.database, context.user.id, decodeURIComponent(memberRoleMatch[1]), decodeURIComponent(memberRoleMatch[2]), request.method === "PUT");
        const access = await effectiveAccess(runtime.database, context.user.id);
        await Promise.all([
          realtime.publish({ kind: "roles.changed", communityId: access.communityId, actorId: context.user.id }),
          realtime.publish({ kind: "members.changed", communityId: access.communityId, actorId: context.user.id }),
          realtime.publish({ kind: "audit.changed", communityId: access.communityId, actorId: context.user.id }),
        ]);
        json(response, 200, { ok: true }, requestId);
        return;
      }
      const memberAdminMatch = /^\/v1\/community\/members\/([^/]+)\/(password-reset|deactivate|voice-restrictions)$/.exec(url.pathname);
      if (memberAdminMatch?.[1] && memberAdminMatch[2]) {
        if (!context.user) throw new Error("unauthorized");
        const targetId = decodeURIComponent(memberAdminMatch[1]);
        const action = memberAdminMatch[2];
        let communityId: string;
        let responseBody: { ok: true; cleared?: number } = { ok: true };
        if (action === "password-reset" && request.method === "POST") {
          if (!runtime.passwordHasher) throw new Error("internal_error");
          ({ communityId } = await resetMemberPassword(runtime.database, runtime.passwordHasher, context.user.id, targetId, await body(request)));
          await Promise.all([
            realtime.publish({ kind: "members.changed", communityId, actorId: context.user.id }),
            realtime.publish({ kind: "audit.changed", communityId, actorId: context.user.id }),
          ]);
        } else if (action === "deactivate" && request.method === "POST") {
          if (!runtime.passwordHasher) throw new Error("internal_error");
          ({ communityId } = await deactivateMemberAccount(runtime.database, runtime.passwordHasher, context.user.id, targetId));
          await Promise.all([
            realtime.publish({ kind: "members.changed", communityId, actorId: context.user.id }),
            realtime.publish({ kind: "roles.changed", communityId, actorId: context.user.id }),
            realtime.publish({ kind: "audit.changed", communityId, actorId: context.user.id }),
          ]);
        } else if (action === "voice-restrictions" && request.method === "DELETE") {
          const cleared = await clearMemberVoiceRestrictions(runtime.database, context.user.id, targetId);
          communityId = cleared.communityId;
          responseBody = { ok: true, cleared: cleared.cleared };
          await realtime.publish({ kind: "audit.changed", communityId, actorId: context.user.id });
        } else {
          throw new Error("not_found");
        }
        json(response, 200, responseBody, requestId);
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/community/channels") {
        if (!context.user) throw new Error("unauthorized");
        const channel = await createCommunityChannel(runtime.database, context.user.id, validateChannel(await body(request)));
        await Promise.all([
          realtime.publish({ kind: "channels.changed", communityId: channel.communityId, actorId: context.user.id }),
          realtime.publish({ kind: "audit.changed", communityId: channel.communityId, actorId: context.user.id }),
        ]);
        json(response, 201, channel, requestId);
        return;
      }
      const channelMutationMatch = /^\/v1\/community\/channels\/([^/]+)$/.exec(url.pathname);
      if (request.method === "PATCH" && channelMutationMatch?.[1]) {
        if (!context.user) throw new Error("unauthorized");
        const input = await body(request) as { name?: unknown };
        const channel = await updateCommunityChannel(runtime.database, context.user.id, decodeURIComponent(channelMutationMatch[1]), input?.name);
        await Promise.all([
          realtime.publish({ kind: "channels.changed", communityId: channel.communityId, actorId: context.user.id }),
          realtime.publish({ kind: "audit.changed", communityId: channel.communityId, actorId: context.user.id }),
        ]);
        json(response, 200, channel, requestId);
        return;
      }
      if (request.method === "DELETE" && channelMutationMatch?.[1]) {
        if (!context.user) throw new Error("unauthorized");
        const archived = await archiveCommunityChannel(runtime.database, context.user.id, decodeURIComponent(channelMutationMatch[1]));
        await Promise.all([
          realtime.publish({ kind: "channels.changed", communityId: archived.communityId, actorId: context.user.id }),
          realtime.publish({ kind: "audit.changed", communityId: archived.communityId, actorId: context.user.id }),
        ]);
        json(response, 200, { ok: true }, requestId);
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/media/giphy/search") {
        if (!context.user) throw new Error("unauthorized");
        const query = (url.searchParams.get("q") ?? "").trim().slice(0, 120);
        const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit") ?? "12") || 12, 25));
        if (!query || !runtime.config.giphyApiKey) {
          json(response, 200, { results: [] }, requestId);
          return;
        }
        const giphyResponse = await fetch(`https://api.giphy.com/v1/gifs/search?api_key=${encodeURIComponent(runtime.config.giphyApiKey)}&q=${encodeURIComponent(query)}&limit=${limit}&rating=pg-13&lang=en`);
        if (!giphyResponse.ok) throw new Error("internal_error");
        const payload = await giphyResponse.json() as { data?: Array<{ id?: string; title?: string; images?: { fixed_width_small?: { url?: string; width?: string; height?: string }; fixed_width?: { url?: string; width?: string; height?: string }; downsized_medium?: { url?: string; width?: string; height?: string }; original?: { url?: string; width?: string; height?: string } } }> };
        const results = (payload.data ?? []).flatMap((gif) => {
          const preview = gif.images?.fixed_width_small?.url ? gif.images.fixed_width_small : gif.images?.fixed_width;
          const display = gif.images?.downsized_medium?.url ? gif.images.downsized_medium : gif.images?.fixed_width?.url ? gif.images.fixed_width : gif.images?.original;
          return gif.id && display?.url ? [{ id: gif.id, title: gif.title ?? "GIF", url: display.url, displayUrl: display.url, previewUrl: preview?.url ?? display.url, width: Number(display.width) || undefined, height: Number(display.height) || undefined }] : [];
        });
        json(response, 200, { results }, requestId);
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/media/uploads") {
        if (!context.user || !runtime.media) throw new Error("unauthorized");
        if (activeMediaUploads.has(context.user.id) || activeMediaUploads.size >= maxConcurrentMediaUploads) throw new Error("rate_limited");
        activeMediaUploads.add(context.user.id);
        const maxJsonBytes = Math.ceil(runtime.config.mediaMaxUploadBytes / 3) * 4 + 16_384;
        try {
          json(response, 201, await runtime.media.upload(context.user.id, await body(request, maxJsonBytes)), requestId);
        } finally {
          activeMediaUploads.delete(context.user.id);
        }
        return;
      }
      const mediaMatch = /^\/v1\/media\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && mediaMatch?.[1]) {
        if (!context.user || !runtime.media) throw new Error("unauthorized");
        const download = await runtime.media.open(context.user.id, decodeURIComponent(mediaMatch[1]), request.headers.range);
        response.setHeader("x-request-id", requestId);
        await writeMediaResponse(response, download);
        return;
      }
      if (url.pathname === "/v1/users/me/avatar" && (request.method === "PUT" || request.method === "DELETE")) {
        if (!context.user || !runtime.media) throw new Error("unauthorized");
        let result: unknown;
        if (request.method === "PUT") {
          const input = await body(request) as { mediaId?: unknown };
          if (typeof input.mediaId !== "string") throw new Error("bad_request");
          result = await runtime.media.setAvatar(context.user.id, input.mediaId);
        } else {
          await runtime.media.removeAvatar(context.user.id);
          result = { ok: true };
        }
        const access = await effectiveAccess(runtime.database, context.user.id);
        await realtime.publish({ kind: "members.changed", communityId: access.communityId, actorId: context.user.id });
        json(response, 200, result, requestId);
        return;
      }
      if (url.pathname === "/v1/community/emotes" && (request.method === "GET" || request.method === "POST")) {
        if (!context.user || !runtime.media) throw new Error("unauthorized");
        const result = request.method === "POST" ? await runtime.media.createEmote(context.user.id, await body(request)) : await runtime.media.listEmotes(context.user.id);
        if (request.method === "POST") {
          const access = await effectiveAccess(runtime.database, context.user.id);
          await Promise.all([
            realtime.publish({ kind: "emotes.changed", communityId: access.communityId, actorId: context.user.id }),
            realtime.publish({ kind: "audit.changed", communityId: access.communityId, actorId: context.user.id }),
          ]);
        }
        json(response, request.method === "POST" ? 201 : 200, result, requestId);
        return;
      }
      const emoteMatch = /^\/v1\/community\/emotes\/([^/]+)$/.exec(url.pathname);
      if (request.method === "DELETE" && emoteMatch?.[1]) {
        if (!context.user || !runtime.media) throw new Error("unauthorized");
        await runtime.media.deleteEmote(context.user.id, decodeURIComponent(emoteMatch[1]));
        const access = await effectiveAccess(runtime.database, context.user.id);
        await Promise.all([
          realtime.publish({ kind: "emotes.changed", communityId: access.communityId, actorId: context.user.id }),
          realtime.publish({ kind: "audit.changed", communityId: access.communityId, actorId: context.user.id }),
        ]);
        json(response, 200, { ok: true }, requestId);
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/community/members") {
        if (!context.user) throw new Error("unauthorized");
        await requirePermission(runtime.database, context.user.id, "members.view");
        const result = await runtime.database.query<Record<string, unknown>>(
          `SELECT u.id, u.username, u.display_name, u.status,
                  CASE WHEN EXISTS (SELECT 1 FROM auth_bootstrap ab WHERE ab.initialized_user_id = u.id) THEN 'owner'
                       WHEN EXISTS (SELECT 1 FROM member_roles mr2 JOIN roles r2 ON r2.id = mr2.role_id
                                    WHERE mr2.community_id = cm.community_id AND mr2.user_id = u.id AND r2.kind = 'admin') THEN 'admin'
                       ELSE 'member' END AS role,
                  EXISTS (SELECT 1 FROM auth_bootstrap ab WHERE ab.initialized_user_id = u.id) AS is_owner,
                  COALESCE((SELECT jsonb_agg(jsonb_build_object(
                    'id', r3.id, 'name', r3.name, 'description', r3.description, 'position', r3.position, 'kind', r3.kind,
                    'permissions', COALESCE((SELECT jsonb_agg(rp3.permission_key ORDER BY rp3.permission_key)
                                              FROM role_permissions rp3 WHERE rp3.role_id = r3.id AND rp3.granted), '[]'::jsonb)
                  ) ORDER BY r3.position DESC, lower(r3.name), r3.id)
                    FROM member_roles mr3 JOIN roles r3 ON r3.id = mr3.role_id
                   WHERE mr3.community_id = cm.community_id AND mr3.user_id = u.id), '[]'::jsonb) AS roles,
                  COALESCE((SELECT array_agg(DISTINCT rp4.permission_key ORDER BY rp4.permission_key)
                              FROM member_roles mr4 JOIN role_permissions rp4 ON rp4.role_id = mr4.role_id AND rp4.granted
                             WHERE mr4.community_id = cm.community_id AND mr4.user_id = u.id), ARRAY[]::varchar[]) AS permissions,
                  avatar.id AS avatar_id, avatar.content_type AS avatar_content_type,
                  avatar.width AS avatar_width, avatar.height AS avatar_height,
                  avatar.ready_at AS avatar_ready_at, profile.updated_at AS avatar_updated_at,
                  EXISTS (SELECT 1 FROM user_sessions us
                          WHERE us.user_id = u.id AND us.revoked_at IS NULL
                            AND us.expires_at > now()
                            AND us.last_used_at > now() - interval '2 minutes') AS online
             FROM users u
             JOIN community_members cm ON cm.user_id = u.id
             LEFT JOIN user_profiles profile ON profile.user_id = u.id
             LEFT JOIN media_objects avatar ON avatar.id = profile.avatar_media_id AND avatar.state = 'ready'
            WHERE cm.community_id = (SELECT community_id FROM community_members WHERE user_id = $1 LIMIT 1)
              AND u.is_active AND NOT cm.is_banned
            ORDER BY online DESC, lower(u.display_name), lower(u.username)`, [context.user.id],
        );
        const members: CommunityMembersResponse = { members: result.rows.map((row) => ({
          id: String(row.id), username: String(row.username), displayName: String(row.display_name),
          role: row.role === "owner" || row.role === "admin" ? row.role : "member", online: row.online === true,
          status: row.status === "busy" || row.status === "away" ? row.status : "active",
          isOwner: row.is_owner === true,
          permissions: Array.isArray(row.permissions) ? row.permissions.map(String) : [],
          roles: Array.isArray(row.roles) ? row.roles.map((value): CommunityRoleMetadata => {
            const item = value as Record<string, unknown>;
            const kind = String(item.kind);
            return { id: String(item.id), name: String(item.name), description: String(item.description ?? ""), position: Number(item.position),
              kind: kind === "owner" || kind === "admin" || kind === "default" ? kind : "custom",
              permissions: Array.isArray(item.permissions) ? item.permissions.map(String) : [] };
          }) : [],
          ...(row.avatar_id ? { avatar: { id: String(row.avatar_id), contentType: String(row.avatar_content_type),
            ...(row.avatar_width == null ? {} : { width: Number(row.avatar_width) }),
            ...(row.avatar_height == null ? {} : { height: Number(row.avatar_height) }),
            version: new Date(String(row.avatar_ready_at ?? row.avatar_updated_at)).toISOString() } } : {}),
        })) };
        json(response, 200, members, requestId);
        return;
      }
      const messagesMatch = /^\/v1\/channels\/([^/]+)\/messages$/.exec(url.pathname);
      if (messagesMatch?.[1]) {
        if (!context.user) throw new Error("unauthorized");
        const channelId = decodeURIComponent(messagesMatch[1]);
        if (request.method === "GET") {
          await authorizeTextChannel(runtime.database, context.user.id, channelId, false);
          const rawLimit = Number(url.searchParams.get("limit") ?? "50");
          const limit = Number.isInteger(rawLimit) ? Math.max(1, Math.min(rawLimit, 100)) : 50;
          const cursor = decodeMessageCursor(url.searchParams.get("before"));
          const result = cursor
            ? await runtime.database.query<Record<string, unknown>>(
              `SELECT ${messageSelect()}
                 FROM messages m JOIN users u ON u.id = m.author_id
                WHERE m.channel_id = $1
                  AND (m.created_at, m.id) < ($3::timestamptz, $4::uuid)
                ORDER BY m.created_at DESC, m.id DESC LIMIT $5`, [channelId, context.user.id, cursor.createdAt, cursor.id, limit + 1],
            )
            : await runtime.database.query<Record<string, unknown>>(
              `SELECT ${messageSelect()}
                 FROM messages m JOIN users u ON u.id = m.author_id
                WHERE m.channel_id = $1
                ORDER BY m.created_at DESC, m.id DESC LIMIT $3`, [channelId, context.user.id, limit + 1],
            );
          const hasMore = result.rows.length > limit;
          const pageRows = result.rows.slice(0, limit).reverse();
          const messages: MessagesResponse = {
            messages: pageRows.map(messageFromRow),
            ...(hasMore && pageRows[0] ? { nextCursor: encodeMessageCursor(pageRows[0]) } : {}),
          };
          json(response, 200, messages, requestId);
          return;
        }
        if (request.method === "POST") {
          const channelAccess = await authorizeTextChannel(runtime.database, context.user.id, channelId, true);
          const input = await body(request) as CreateMessageRequest;
          const encrypted = typeof input?.ciphertext === "string" && typeof input?.nonce === "string";
          const plaintext = typeof input?.content === "string" && input.content.trim().length > 0;
          const attachmentIds = input?.attachmentIds ?? [];
          if ((!encrypted && !plaintext) || (encrypted && (input.ciphertext!.length > 750000 || input.nonce!.length > 100))
            || !Array.isArray(attachmentIds) || attachmentIds.length > 10
            || new Set(attachmentIds).size !== attachmentIds.length
            || !attachmentIds.every((id) => typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id))) throw new Error("bad_request");
          const result = await runtime.database.query<Record<string, unknown>>(
            `WITH eligible AS (
               SELECT mo.id
                 FROM media_objects mo JOIN channels c ON c.id = $1
                WHERE mo.id = ANY($6::uuid[]) AND mo.community_id = c.community_id
                  AND mo.uploaded_by = $2 AND mo.purpose = 'message' AND mo.state = 'ready'
             ), inserted AS (
               INSERT INTO messages (channel_id, author_id, content, ciphertext, nonce)
               SELECT $1, $2, $3, $4, $5
                WHERE cardinality($6::uuid[]) = (SELECT count(*) FROM eligible)
               RETURNING *
             ), linked AS (
               INSERT INTO message_attachments (message_id, media_id, position)
               SELECT inserted.id, eligible.id,
                      (row_number() OVER (ORDER BY array_position($6::uuid[], eligible.id)) - 1)::smallint
                 FROM inserted CROSS JOIN eligible
               RETURNING media_id
             )
             SELECT ${messageSelect().replaceAll("m.", "inserted.").replace("FROM message_reactions mr WHERE mr.message_id = inserted.id", "FROM message_reactions mr WHERE mr.message_id = inserted.id")}
               FROM inserted JOIN users u ON u.id = inserted.author_id`,
            [channelId, context.user.id, plaintext ? input.content!.trim() : null, encrypted ? input.ciphertext : null, encrypted ? input.nonce : null, attachmentIds],
          );
          if (!result.rows[0]) throw new Error(attachmentIds.length ? "bad_request" : "internal_error");
          const inserted = messageFromRow(result.rows[0]);
          const authoritative = attachmentIds.length ? await runtime.database.query<Record<string, unknown>>(
            `SELECT ${messageSelect()}
               FROM messages m JOIN users u ON u.id = m.author_id
              WHERE m.channel_id = $1 AND m.id = $3`, [channelId, context.user.id, inserted.id],
          ) : { rows: [] };
          const created = authoritative.rows[0] ? messageFromRow(authoritative.rows[0]) : inserted;
          await realtime.publish({ kind: "message.created", communityId: channelAccess.communityId, actorId: context.user.id, channelId, messageId: created.id });
          json(response, 201, created, requestId);
          return;
        }
      }
      const messageMutationMatch = /^\/v1\/channels\/([^/]+)\/messages\/([^/]+)$/.exec(url.pathname);
      if (messageMutationMatch?.[1] && messageMutationMatch[2] && request.method === "GET") {
        if (!context.user) throw new Error("unauthorized");
        const channelId = decodeURIComponent(messageMutationMatch[1]);
        const messageId = decodeURIComponent(messageMutationMatch[2]);
        await authorizeTextChannel(runtime.database, context.user.id, channelId, false);
        const result = await runtime.database.query<Record<string, unknown>>(
          `SELECT ${messageSelect()}
             FROM messages m JOIN users u ON u.id = m.author_id
            WHERE m.channel_id = $1 AND m.id = $3`, [channelId, context.user.id, messageId],
        );
        if (!result.rows[0]) throw new Error("not_found");
        json(response, 200, messageFromRow(result.rows[0]), requestId);
        return;
      }
      if (messageMutationMatch?.[1] && messageMutationMatch[2] && (request.method === "PATCH" || request.method === "DELETE")) {
        if (!context.user) throw new Error("unauthorized");
        const channelId = decodeURIComponent(messageMutationMatch[1]);
        const messageId = decodeURIComponent(messageMutationMatch[2]);
        const mutationAccess = await authorizeMessageMutation(runtime.database, context.user.id, channelId, messageId);
        if (request.method === "PATCH") {
          const input = validateEncryptedPayload(await body(request));
          const result = await runtime.database.query<Record<string, unknown>>(
            `UPDATE messages SET ciphertext = $1, nonce = $2, content = NULL, edited_at = now()
              WHERE id = $3 AND channel_id = $4 AND deleted_at IS NULL
              RETURNING id`, [input.ciphertext, input.nonce, messageId, channelId],
          );
          if (!result.rows[0]) throw new Error("not_found");
          await realtime.publish({ kind: "message.updated", communityId: mutationAccess.communityId, actorId: context.user.id, channelId, messageId });
          json(response, 200, { ok: true }, requestId);
        } else {
          if (!runtime.database.transaction) throw new Error("database_transaction_not_configured");
          const result = await runtime.database.transaction(async (transaction) => {
            const deleted = await transaction.query<Record<string, unknown>>(
              `UPDATE messages SET deleted_at = COALESCE(deleted_at, now())
                WHERE id = $1 AND channel_id = $2 RETURNING deleted_at`, [messageId, channelId],
            );
            if (deleted.rows[0] && !mutationAccess.isAuthor) {
              await writeAuditEvent(transaction, {
                communityId: mutationAccess.communityId,
                actorId: context.user!.id,
                action: "message.moderator_deleted",
                targetType: "message",
                targetId: messageId,
                metadata: { channelId },
              });
            }
            return deleted;
          });
          if (!result.rows[0]) throw new Error("not_found");
          await realtime.publish({ kind: "message.deleted", communityId: mutationAccess.communityId, actorId: context.user.id, channelId, messageId });
          if (!mutationAccess.isAuthor) await realtime.publish({ kind: "audit.changed", communityId: mutationAccess.communityId, actorId: context.user.id });
          json(response, 200, { id: messageId, deletedAt: new Date(String(result.rows[0].deleted_at)).toISOString() }, requestId);
        }
        return;
      }
      const reactionCollectionMatch = /^\/v1\/channels\/([^/]+)\/messages\/([^/]+)\/reactions$/.exec(url.pathname);
      if (reactionCollectionMatch?.[1] && reactionCollectionMatch[2]) {
        if (!context.user) throw new Error("unauthorized");
        if (request.method !== "POST" && request.method !== "DELETE") throw new Error("not_found");
        const channelId = decodeURIComponent(reactionCollectionMatch[1]);
        const messageId = decodeURIComponent(reactionCollectionMatch[2]);
        const channelAccess = await authorizeTextChannel(runtime.database, context.user.id, channelId, true);
        const target = validateReaction(await body(request));
        if (request.method === "POST") {
          const result = target.kind === "unicode"
            ? await runtime.database.query<Record<string, unknown>>(
              `INSERT INTO message_reactions (message_id, user_id, emoji, custom_emote_id)
               SELECT m.id, $3, $4, NULL FROM messages m
                WHERE m.id = $1 AND m.channel_id = $2 AND m.deleted_at IS NULL
               ON CONFLICT (message_id, user_id, emoji) DO UPDATE SET emoji = EXCLUDED.emoji
               RETURNING message_id`, [messageId, channelId, context.user.id, target.value],
            )
            : await runtime.database.query<Record<string, unknown>>(
              `INSERT INTO message_reactions (message_id, user_id, emoji, custom_emote_id)
               SELECT m.id, $3, NULL, ce.id FROM messages m
               JOIN channels c ON c.id = m.channel_id
               JOIN custom_emotes ce ON ce.id = $4 AND ce.community_id = c.community_id AND ce.deleted_at IS NULL
                WHERE m.id = $1 AND m.channel_id = $2 AND m.deleted_at IS NULL
               ON CONFLICT (message_id, user_id, custom_emote_id) WHERE custom_emote_id IS NOT NULL
               DO UPDATE SET custom_emote_id = EXCLUDED.custom_emote_id
               RETURNING message_id`, [messageId, channelId, context.user.id, target.emoteId],
            );
          if (!result.rows[0]) throw new Error("not_found");
        } else if (target.kind === "unicode") {
          await runtime.database.query(
            `DELETE FROM message_reactions mr USING messages m
              WHERE mr.message_id = m.id AND mr.message_id = $1 AND m.channel_id = $2 AND mr.user_id = $3 AND mr.emoji = $4`,
            [messageId, channelId, context.user.id, target.value],
          );
        } else {
          await runtime.database.query(
            `DELETE FROM message_reactions mr USING messages m
              WHERE mr.message_id = m.id AND mr.message_id = $1 AND m.channel_id = $2 AND mr.user_id = $3 AND mr.custom_emote_id = $4`,
            [messageId, channelId, context.user.id, target.emoteId],
          );
        }
        await realtime.publish({ kind: "message.reactions-changed", communityId: channelAccess.communityId, actorId: context.user.id, channelId, messageId });
        json(response, 200, { ok: true, target }, requestId);
        return;
      }
      const reactionMatch = /^\/v1\/channels\/([^/]+)\/messages\/([^/]+)\/reactions\/([^/]+)$/.exec(url.pathname);
      if (reactionMatch?.[1] && reactionMatch[2] && reactionMatch[3]) {
        if (!context.user) throw new Error("unauthorized");
        if (request.method !== "DELETE") throw new Error("not_found");
        const channelId = decodeURIComponent(reactionMatch[1]);
        const messageId = decodeURIComponent(reactionMatch[2]);
        const channelAccess = await authorizeTextChannel(runtime.database, context.user.id, channelId, true);
        const target = validateReaction({ emoji: decodeURIComponent(reactionMatch[3]) });
        if (target.kind !== "unicode") throw new Error("bad_request");
        await runtime.database.query(
          `DELETE FROM message_reactions mr USING messages m
            WHERE mr.message_id = m.id AND mr.message_id = $1 AND m.channel_id = $2 AND mr.user_id = $3 AND mr.emoji = $4`,
          [messageId, channelId, context.user.id, target.value],
        );
        await realtime.publish({ kind: "message.reactions-changed", communityId: channelAccess.communityId, actorId: context.user.id, channelId, messageId });
        json(response, 200, { ok: true }, requestId);
        return;
      }
      const voiceMatch = /^\/v1\/channels\/([^/]+)\/voice-token$/.exec(url.pathname);
      if (request.method === "POST" && voiceMatch?.[1]) {
        json(response, 200, await runtime.api.voice.token({ channelId: decodeURIComponent(voiceMatch[1]) }, context), requestId);
        return;
      }
      const moderationMatch = /^\/v1\/channels\/([^/]+)\/voice\/participants\/([^/]+)\/(mute|disconnect|move)$/.exec(url.pathname);
      if (moderationMatch?.[1] && moderationMatch[2] && moderationMatch[3]) {
        if (!context.user || !runtime.voiceModeration) throw new Error("unauthorized");
        const channelId = decodeURIComponent(moderationMatch[1]);
        const targetId = decodeURIComponent(moderationMatch[2]);
        const action = moderationMatch[3];
        if (action === "mute" && (request.method === "POST" || request.method === "DELETE")) {
          const input = request.method === "POST" ? await body(request) as { reason?: unknown } : {};
          const reason = typeof input.reason === "string" ? input.reason : undefined;
          const result = await runtime.voiceModeration.forceMute(context.user.id, channelId, targetId, request.method === "POST", reason);
          const access = await effectiveAccess(runtime.database, context.user.id);
          await realtime.publish({ kind: "audit.changed", communityId: access.communityId, actorId: context.user.id });
          json(response, 200, result, requestId);
          return;
        }
        if (action === "disconnect" && request.method === "POST") {
          const input = await body(request) as { reason?: unknown };
          const reason = typeof input.reason === "string" ? input.reason : undefined;
          const result = await runtime.voiceModeration.disconnect(context.user.id, channelId, targetId, reason);
          const access = await effectiveAccess(runtime.database, context.user.id);
          await realtime.publish({ kind: "audit.changed", communityId: access.communityId, actorId: context.user.id });
          json(response, 200, result, requestId);
          return;
        }
        if (action === "move" && request.method === "POST") {
          const input = await body(request) as { destinationChannelId?: unknown };
          if (typeof input.destinationChannelId !== "string") throw new Error("bad_request");
          const result = await runtime.voiceModeration.move(context.user.id, channelId, targetId, input.destinationChannelId);
          const access = await effectiveAccess(runtime.database, context.user.id);
          await realtime.publish({ kind: "audit.changed", communityId: access.communityId, actorId: context.user.id });
          json(response, 200, result, requestId);
          return;
        }
        throw new Error("not_found");
      }
      json(response, 404, { error: { code: "not_found", message: "Not found", requestId } }, requestId);
    } catch (error) {
      const status = errorCode(error);
      const code = status === 400 ? "bad_request" : status === 401 ? "unauthorized" : status === 403 ? "forbidden" : status === 404 ? "not_found" : status === 409 ? "conflict" : status === 429 ? "rate_limited" : "internal_error";
      const message = status === 400 ? "Invalid request" : status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : status === 404 ? "Not found" : status === 409 ? "Conflict" : status === 429 ? "Too many requests" : "Request failed";
      json(response, status, { error: { code, message, requestId } }, requestId);
    }
  });
  server.once("close", () => realtime.close());
  return server;
}

interface LocalApiWithInvite extends LocalApi {
  createInvite?(createdBy: string, expiresInSeconds: number): Promise<{ token: string; expiresAt: string }>;
}

if (process.argv[1]?.endsWith("http-server.js")) {
  const runtime = createApiRuntime();
  const server = createHttpServer(runtime);
  server.listen(runtime.config.port, runtime.config.host, () => {
    console.log(`FreeCord API listening on ${runtime.config.host}:${runtime.config.port}`);
  });
}
