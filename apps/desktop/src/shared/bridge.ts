export interface RuntimeInfo {
  appVersion: string;
  platform: NodeJS.Platform;
}

export interface ServerSettings {
  version: 1;
  serverOrigin: string | null;
  allowInsecureLocalhost: boolean;
}

export interface ServerSettingsInput {
  serverOrigin: string;
  allowInsecureLocalhost: boolean;
}

export interface SettingsResult {
  ok: true;
  settings: ServerSettings;
}

export interface SettingsError {
  ok: false;
  code: "INVALID_SERVER_ORIGIN" | "SETTINGS_UNAVAILABLE";
  message: string;
}

export interface AudioSettings {
  microphoneId: string;
  outputId: string;
  inputSensitivity: number;
  rnnoiseEnabled: boolean;
  echoCancellation: boolean;
  automaticGainControl: boolean;
  nativeNoiseSuppression: boolean;
}

export type LinuxScreenAudioResult =
  | { ok: true; outputName: string }
  | { ok: false; message: string };

export interface AuthenticatedUser {
  id: string;
  username: string;
  displayName: string;
  role: "owner" | "admin" | "member";
  status: "active" | "busy" | "away";
  avatar?: MediaAssetReference;
  roles?: CommunityRoleSummary[];
  permissions?: string[];
  isOwner?: boolean;
}

export interface AuthSession {
  id: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
  deviceName?: string;
}

export interface SessionState {
  status: "signed-out" | "authenticated";
  user: AuthenticatedUser | null;
  session: AuthSession | null;
}

export interface VoiceTokenResponse {
  token: string;
  livekitUrl: string;
  expiresAt: string;
  participantIdentity: string;
  permissions: {
    canPublish: boolean;
    /** Added in 0.6.4; fall back to canPublish with older servers. */
    canPublishMicrophone?: boolean;
    canSubscribe: boolean;
    canPublishData: boolean;
  };
}

export interface ChannelMetadata {
  id: string;
  communityId: string;
  name: string;
  type: "text" | "voice";
  position: number;
  canRead: boolean;
  canConnect?: boolean;
  canPublish?: boolean;
}

export interface ChannelsResponse {
  channels: ChannelMetadata[];
}

export interface CommunityMember {
  id: string;
  username: string;
  displayName: string;
  role: "owner" | "admin" | "member";
  online: boolean;
  status: "active" | "busy" | "away";
  avatar?: MediaAssetReference;
  roles?: CommunityRoleSummary[];
  permissions?: string[];
  isOwner?: boolean;
}

export interface CommunityMembersResponse {
  members: CommunityMember[];
}

export interface InviteResponse {
  token: string;
  expiresAt: string;
}

export interface ChatMessage {
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
  mediaId: string;
  contentType: string;
  byteSize: number;
  encrypted: boolean;
  position: number;
  version?: string;
}

export type ReactionTarget =
  | { kind: "unicode"; value: string }
  | { kind: "emote"; emoteId: string };

export interface MessageReaction {
  /** Legacy Unicode field retained while the server response migrates. */
  emoji?: string;
  target?: ReactionTarget;
  count: number;
  reacted: boolean;
  emote?: CommunityEmote;
}

export interface MessagesResponse {
  messages: ChatMessage[];
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
  actorId?: string;
  channelId?: string;
  messageId?: string;
}

export interface SharedFile {
  mediaId: string;
  messageId: string;
  channelId: string;
  channelName: string;
  authorId: string;
  authorDisplayName: string;
  contentType: string;
  byteSize: number;
  encrypted: boolean;
  position: number;
  sharedAt: string;
}

export interface SharedFilesResponse {
  files: SharedFile[];
  nextCursor?: string;
}

export interface AuditEvent {
  id: string;
  actorId?: string;
  actorDisplayName?: string;
  action: string;
  targetType?: string;
  targetId?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface AuditLogResponse {
  events: AuditEvent[];
  nextCursor?: string;
}

export interface AuthError {
  ok: false;
  code: "AUTHENTICATION_FAILED" | "SERVER_UNAVAILABLE" | "CREDENTIAL_STORAGE_UNAVAILABLE" | "NO_SERVER_CONFIGURED";
  message: string;
}

export interface LoginInput {
  username: string;
  password: string;
}

export interface RegisterInput {
  inviteToken: string;
  username: string;
  displayName: string;
  password: string;
}

export interface UpdateProfileInput { displayName: string; }
export interface ChangePasswordInput { currentPassword: string; newPassword: string; }

export interface CreateChannelInput { name: string; type: "text" | "voice"; }
export interface GiphyResult {
  id: string;
  title: string;
  /** Legacy display URL retained for compatibility with the current renderer. */
  url: string;
  previewUrl?: string;
  displayUrl?: string;
  width?: number;
  height?: number;
}

export type RoleKind = "owner" | "admin" | "default" | "custom";

export interface PermissionDefinition {
  key: string;
  description: string;
}

export interface CommunityPermissionsResponse {
  permissions: PermissionDefinition[];
  effectivePermissions: string[];
}

export interface CommunityRoleSummary {
  id: string;
  name: string;
  description?: string;
  position: number;
  kind: RoleKind;
}

export interface CommunityRole extends CommunityRoleSummary {
  permissions: string[];
  memberCount?: number;
}

export interface CommunityRolesResponse {
  roles: CommunityRole[];
  permissions: string[];
}

export interface CreateRoleInput {
  name: string;
  permissions: string[];
  position?: number;
}

export interface UpdateRoleInput {
  name?: string;
  permissions?: string[];
  position?: number;
}

export interface MediaAssetReference {
  assetId: string;
  /** Server DTO compatibility; normalized desktop responses always add assetId. */
  id?: string;
  version?: string;
  contentType?: string;
  byteSize?: number;
  name?: string;
  mimeType?: string;
  size?: number;
  width?: number;
  height?: number;
  durationMs?: number;
}

export interface UserProfile {
  userId: string;
  displayName: string;
  avatar?: MediaAssetReference;
}

export interface CommunityEmote {
  id: string;
  name: string;
  asset: MediaAssetReference;
  media?: MediaAssetReference;
  animated: boolean;
  createdAt?: string;
}

export interface FilesSurfaceRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FilesSurfaceState {
  ok: true;
  visible: boolean;
  origin: string;
}

export interface BinaryMediaUploadInput {
  name: string;
  mimeType: string;
  bytes: ArrayBuffer;
}

export interface MediaSelectionCanceled {
  canceled: true;
}

export interface MediaImageData {
  dataUrl: string;
  contentType: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
}

export interface AuthResult {
  ok: true;
  state: SessionState;
}

export interface FreeCordBridge {
  getRuntimeInfo(): Promise<RuntimeInfo>;
  openSupportPage(): Promise<{ ok: true }>;
  getWindowFullscreen(): Promise<boolean>;
  setWindowFullscreen(fullscreen: boolean): Promise<void>;
  onWindowFullscreenChanged(listener: (fullscreen: boolean) => void): () => void;
  prepareLinuxScreenAudio(): Promise<LinuxScreenAudioResult>;
  releaseLinuxScreenAudio(): Promise<void>;
  onLinuxScreenAudioData(listener: (chunk: ArrayBuffer) => void): () => void;
  onLinuxScreenAudioError(listener: (message: string) => void): () => void;
  getServerSettings(): Promise<ServerSettings>;
  saveServerSettings(input: ServerSettingsInput): Promise<SettingsResult | SettingsError>;
  clearServerSettings(): Promise<SettingsResult | SettingsError>;
  getAudioSettings(): Promise<AudioSettings>;
  saveAudioSettings(settings: AudioSettings): Promise<AudioSettings>;
  login(input: LoginInput): Promise<AuthResult | AuthError>;
  register(input: RegisterInput): Promise<AuthResult | AuthError>;
  refresh(): Promise<AuthResult | AuthError>;
  logout(): Promise<AuthResult | AuthError>;
  updateStatus(status: "active" | "busy" | "away"): Promise<AuthResult | AuthError>;
  updateProfile(input: UpdateProfileInput): Promise<AuthResult | AuthError>;
  changePassword(input: ChangePasswordInput): Promise<{ ok: true } | AuthError>;
  getSessionState(): Promise<SessionState>;
  clearCredentials(): Promise<{ ok: true } | AuthError>;
  getChannels(): Promise<ChannelsResponse | AuthError>;
  createChannel(input: CreateChannelInput): Promise<ChannelMetadata | AuthError>;
  updateChannel(channelId: string, name: string): Promise<ChannelMetadata | AuthError>;
  deleteChannel(channelId: string): Promise<{ ok: true } | AuthError>;
  searchGiphy(query: string): Promise<{ results: GiphyResult[] } | AuthError>;
  getMembers(): Promise<CommunityMembersResponse | AuthError>;
  createInvite(expiresInSeconds?: number): Promise<InviteResponse | AuthError>;
  getCommunityPermissions(): Promise<CommunityPermissionsResponse | AuthError>;
  getCommunityRoles(): Promise<CommunityRolesResponse | AuthError>;
  createCommunityRole(input: CreateRoleInput): Promise<CommunityRole | AuthError>;
  updateCommunityRole(roleId: string, input: UpdateRoleInput): Promise<CommunityRole | AuthError>;
  deleteCommunityRole(roleId: string): Promise<{ ok: true } | AuthError>;
  assignMemberRole(userId: string, roleId: string): Promise<{ ok: true } | AuthError>;
  removeMemberRole(userId: string, roleId: string): Promise<{ ok: true } | AuthError>;
  resetMemberPassword(userId: string, newPassword: string): Promise<{ ok: true } | AuthError>;
  deactivateMember(userId: string): Promise<{ ok: true } | AuthError>;
  clearMemberVoiceRestrictions(userId: string): Promise<{ ok: true; cleared: number } | AuthError>;
  removeMyAvatar(): Promise<UserProfile | AuthError>;
  uploadAvatar(input: BinaryMediaUploadInput): Promise<{ avatar: MediaAssetReference } | AuthError>;
  getCommunityEmotes(): Promise<{ emotes: CommunityEmote[] } | AuthError>;
  deleteCommunityEmote(emoteId: string): Promise<{ ok: true } | AuthError>;
  uploadCommunityEmote(input: BinaryMediaUploadInput & { name: string }): Promise<CommunityEmote | AuthError>;
  chooseAndUploadMedia(): Promise<MediaAssetReference | MediaSelectionCanceled | AuthError>;
  getMediaImageData(assetId: string): Promise<MediaImageData | AuthError>;
  addEmoteReaction(channelId: string, messageId: string, emoteId: string): Promise<{ ok: true } | AuthError>;
  removeEmoteReaction(channelId: string, messageId: string, emoteId: string): Promise<{ ok: true } | AuthError>;
  getMessages(channelId: string, before?: string): Promise<MessagesResponse | AuthError>;
  getMessage(channelId: string, messageId: string): Promise<ChatMessage | AuthError>;
  getSharedFiles(before?: string): Promise<SharedFilesResponse | AuthError>;
  getAuditLog(before?: string): Promise<AuditLogResponse | AuthError>;
  onRealtimeEvent(listener: (event: RealtimeEvent) => void): () => void;
  sendMessage(channelId: string, payload: { ciphertext: string; nonce: string; attachmentIds?: string[] }): Promise<ChatMessage | AuthError>;
  editMessage(channelId: string, messageId: string, payload: { ciphertext: string; nonce: string }): Promise<{ ok: true } | AuthError>;
  deleteMessage(channelId: string, messageId: string): Promise<{ id: string; deletedAt: string } | AuthError>;
  addReaction(channelId: string, messageId: string, target: string | ReactionTarget): Promise<{ ok: true } | AuthError>;
  removeReaction(channelId: string, messageId: string, target: string | ReactionTarget): Promise<{ ok: true } | AuthError>;
  muteVoiceParticipant(channelId: string, userId: string, muted?: boolean): Promise<{ ok: true } | AuthError>;
  disconnectVoiceParticipant(channelId: string, userId: string): Promise<{ ok: true } | AuthError>;
  moveVoiceParticipant(channelId: string, userId: string, destinationChannelId: string): Promise<{ ok: true } | AuthError>;
  getFilesSurfaceInfo(): Promise<FilesSurfaceState>;
  showFilesSurface(rect: FilesSurfaceRect): Promise<FilesSurfaceState | AuthError>;
  hideFilesSurface(): Promise<FilesSurfaceState>;
  showFilesView(rect: FilesSurfaceRect): Promise<FilesSurfaceState | AuthError>;
  updateFilesViewBounds(rect: FilesSurfaceRect): Promise<void>;
  hideFilesView(): Promise<void>;
  getChatKey(): Promise<string>;
  issueVoiceToken(channelId: string): Promise<VoiceTokenResponse | AuthError>;
}
