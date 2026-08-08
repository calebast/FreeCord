/**
 * API-001: framework-neutral backend contracts for a single-community install.
 *
 * This file contains transport DTOs and service interfaces only. It does not
 * connect to a database, sign LiveKit tokens, or read environment secrets.
 */

export const API_VERSION = "v1" as const;

export const ENDPOINTS = {
  health: "GET /health",
  login: "POST /v1/auth/login",
  register: "POST /v1/auth/register",
  createInvite: "POST /v1/invites",
  refresh: "POST /v1/auth/refresh",
  logout: "POST /v1/auth/logout",
  session: "GET /v1/auth/session",
  updateStatus: "PATCH /v1/auth/profile/status",
  updateProfile: "PATCH /v1/users/me/profile",
  changePassword: "POST /v1/users/me/password",
  community: "GET /v1/community",
  channels: "GET /v1/community/channels",
  createChannel: "POST /v1/community/channels",
  updateChannel: "PATCH /v1/community/channels/:channelId",
  deleteChannel: "DELETE /v1/community/channels/:channelId",
  members: "GET /v1/community/members",
  voiceToken: "POST /v1/channels/:channelId/voice-token",
  messages: "GET /v1/channels/:channelId/messages",
  createMessage: "POST /v1/channels/:channelId/messages",
  editMessage: "PATCH /v1/channels/:channelId/messages/:messageId",
  deleteMessage: "DELETE /v1/channels/:channelId/messages/:messageId",
  message: "GET /v1/channels/:channelId/messages/:messageId",
  addReaction: "POST /v1/channels/:channelId/messages/:messageId/reactions",
  removeReaction: "DELETE /v1/channels/:channelId/messages/:messageId/reactions/:emoji",
  giphySearch: "GET /v1/media/giphy/search",
  permissions: "GET /v1/community/permissions",
  roles: "GET /v1/community/roles",
  createRole: "POST /v1/community/roles",
  updateRole: "PATCH /v1/community/roles/:roleId",
  deleteRole: "DELETE /v1/community/roles/:roleId",
  assignRole: "PUT /v1/community/members/:userId/roles/:roleId",
  removeRole: "DELETE /v1/community/members/:userId/roles/:roleId",
  resetMemberPassword: "POST /v1/community/members/:userId/password-reset",
  deactivateMember: "POST /v1/community/members/:userId/deactivate",
  clearMemberVoiceRestrictions: "DELETE /v1/community/members/:userId/voice-restrictions",
  mediaUpload: "POST /v1/media/uploads",
  mediaDownload: "GET /v1/media/:mediaId",
  avatar: "PUT /v1/users/me/avatar",
  emotes: "GET /v1/community/emotes",
  createEmote: "POST /v1/community/emotes",
  deleteEmote: "DELETE /v1/community/emotes/:emoteId",
  muteParticipant: "POST /v1/channels/:channelId/voice/participants/:userId/mute",
  disconnectParticipant: "POST /v1/channels/:channelId/voice/participants/:userId/disconnect",
  moveParticipant: "POST /v1/channels/:channelId/voice/participants/:userId/move",
  realtimeEvents: "GET /v1/realtime/events",
  sharedFiles: "GET /v1/community/files",
  auditLog: "GET /v1/community/audit-log",
} as const;

export type ChannelType = "text" | "voice";
export type CommunityRole = "owner" | "admin" | "member";
export type UserStatus = "active" | "busy" | "away";

export interface CommunityRoleMetadata {
  id: string;
  name: string;
  description: string;
  position: number;
  kind: "owner" | "admin" | "default" | "custom";
  permissions: string[];
}

export interface MediaReference {
  id: string;
  contentType: string;
  width?: number;
  height?: number;
  version: string;
}

export interface HealthResponse {
  status: "ok" | "degraded";
  service: "freecord-api";
  version: string;
  checks: {
    database: "not-configured" | "ok" | "error";
    livekit: "not-configured" | "ok" | "error";
  };
}

export interface ApiError {
  error: {
    code:
      | "bad_request"
      | "unauthorized"
      | "forbidden"
      | "not_found"
      | "conflict"
      | "rate_limited"
      | "internal_error";
    message: string;
    requestId?: string;
  };
}

export interface LoginRequest {
  username: string;
  password: string;
  deviceName?: string;
}

export interface RegisterRequest {
  inviteToken: string;
  username: string;
  password: string;
  displayName?: string;
  deviceName?: string;
}

export interface CreateInviteRequest {
  expiresInSeconds?: number;
}

export interface CreateInviteResponse {
  token: string;
  expiresAt: string;
}

export interface AuthSession {
  id: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
  deviceName?: string;
}

export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
  user: AuthenticatedUser;
  session: AuthSession;
}

export interface RefreshRequest {
  refreshToken: string;
}

export interface LogoutRequest {
  refreshToken?: string;
}

export interface AuthenticatedUser {
  id: string;
  username: string;
  displayName: string;
  role: CommunityRole;
  status: UserStatus;
  /** Explicit authorization data. `role` remains for old desktop builds only. */
  roles?: CommunityRoleMetadata[];
  permissions?: string[];
  isOwner?: boolean;
  avatar?: MediaReference;
}

export interface UpdateStatusRequest {
  status: UserStatus;
}

export interface CreateChannelRequest {
  name: string;
  type: ChannelType;
}

export interface SessionResponse {
  user: AuthenticatedUser;
  session: AuthSession;
}

export interface CommunityMember {
  id: string;
  username: string;
  displayName: string;
  role: CommunityRole;
  status: UserStatus;
  online: boolean;
  roles?: CommunityRoleMetadata[];
  permissions?: string[];
  isOwner?: boolean;
  avatar?: MediaReference;
}

export interface CommunityMembersResponse {
  members: CommunityMember[];
}

export interface AdminResetPasswordRequest {
  newPassword: string;
}

export interface CommunityMetadata {
  id: string;
  name: string;
  /** One installation intentionally exposes exactly one community. */
  selfHosted: true;
}

export interface ChannelMetadata {
  id: string;
  communityId: string;
  name: string;
  type: ChannelType;
  position: number;
  canRead: boolean;
  canConnect?: boolean;
  canPublish?: boolean;
}

export interface CommunityResponse {
  community: CommunityMetadata;
  currentUser: AuthenticatedUser;
}

export interface ChannelsResponse {
  channels: ChannelMetadata[];
}

export interface VoiceTokenRequest {
  /** Channel identity comes from the route; clients never submit a room name. */
  channelId: string;
}

export interface VoiceTokenResponse {
  token: string;
  livekitUrl: string;
  expiresAt: string;
  participantIdentity: string;
  permissions: {
    /** Legacy clients interpret canPublish as microphone publication permission. */
    canPublish: boolean;
    canPublishMicrophone: boolean;
    canSubscribe: boolean;
    canPublishData: boolean;
  };
}

export interface Message {
  id: string;
  channelId: string;
  authorId: string;
  authorUsername: string;
  authorDisplayName: string;
  content?: string;
  ciphertext?: string;
  nonce?: string;
  createdAt: string;
  editedAt?: string;
  deletedAt?: string;
  reactions?: MessageReaction[];
  attachments?: MessageAttachment[];
}

export interface MessageAttachment {
  media: MediaReference;
  byteSize: number;
  encrypted: boolean;
  position: number;
}

export interface MessageReaction {
  /** Legacy Unicode field retained while desktop clients migrate. */
  emoji?: string;
  target?: { kind: "unicode"; value: string } | { kind: "emote"; emoteId: string };
  emote?: CommunityEmote;
  count: number;
  reacted: boolean;
}

export interface MessagesResponse {
  messages: Message[];
  nextCursor?: string;
}

export type RealtimeEventKind =
  | "sync.required"
  | "message.created"
  | "message.updated"
  | "message.deleted"
  | "message.reactions-changed"
  | "channels.changed"
  | "members.changed"
  | "roles.changed"
  | "emotes.changed"
  | "audit.changed";

export interface RealtimeEvent {
  id: string;
  kind: RealtimeEventKind;
  occurredAt: string;
  actorId: string;
  channelId?: string;
  messageId?: string;
}

export interface SharedFile {
  media: MediaReference;
  byteSize: number;
  encrypted: boolean;
  position: number;
  messageId: string;
  channelId: string;
  channelName: string;
  authorId: string;
  authorUsername: string;
  authorDisplayName: string;
  sharedAt: string;
}

export interface SharedFilesResponse {
  files: SharedFile[];
  nextCursor?: string;
}

export interface AuditEvent {
  id: string;
  action: string;
  actorId?: string;
  actorUsername: string;
  actorDisplayName: string;
  targetType?: string;
  targetId?: string;
  metadata: Record<string, string | number | boolean | null>;
  createdAt: string;
}

export interface AuditLogResponse {
  events: AuditEvent[];
  nextCursor?: string;
}

export interface CreateMessageRequest {
  ciphertext?: string;
  nonce?: string;
  content?: string;
  attachmentIds?: string[];
}

export interface EditMessageRequest {
  ciphertext: string;
  nonce: string;
}

export interface AddReactionRequest {
  emoji?: string;
  unicode?: string;
  emoteId?: string;
}

export interface CommunityEmote {
  id: string;
  name: string;
  animated: boolean;
  media: MediaReference;
}

export interface RequestContext {
  requestId: string;
  accessToken?: string;
  user?: AuthenticatedUser;
}

export interface AuthService {
  login(input: LoginRequest, context: RequestContext): Promise<LoginResponse>;
  register?(input: RegisterRequest, context: RequestContext): Promise<LoginResponse>;
  refresh(input: RefreshRequest, context: RequestContext): Promise<LoginResponse>;
  logout(input: LogoutRequest, context: RequestContext): Promise<void>;
  getSession(context: RequestContext): Promise<SessionResponse>;
}

export interface CommunityService {
  getCommunity(context: RequestContext): Promise<CommunityResponse>;
  listChannels(context: RequestContext): Promise<ChannelsResponse>;
}

export interface ChannelAuthorizer {
  authorizeVoiceJoin(
    user: AuthenticatedUser,
    channelId: string,
  ): Promise<{
    communityId: string;
    livekitRoomName: string;
    canPublish: boolean;
    canPublishMicrophone: boolean;
    canSubscribe: boolean;
    canPublishData: boolean;
  }>;
}

export interface LiveKitTokenIssuer {
  issue(input: {
    user: AuthenticatedUser;
    channelId: string;
    livekitRoomName: string;
    canPublish: boolean;
    canPublishMicrophone: boolean;
    canSubscribe: boolean;
    canPublishData: boolean;
  }): Promise<VoiceTokenResponse>;
}

export interface VoiceService {
  issueToken(
    input: VoiceTokenRequest,
    context: RequestContext,
  ): Promise<VoiceTokenResponse>;
}
