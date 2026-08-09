import React from "react";
import { createRoot } from "react-dom/client";
import type { AuditEvent, AudioSettings, AuthenticatedUser, ChannelMetadata, ChatMessage, CommunityMember, GiphyResult, RealtimeEvent, ServerSettings, SessionState, SharedFile } from "../shared/bridge";
import { VoiceClient, type ScreenShareBitrate, type ScreenShareFrameRate, type ScreenShareResolution, type VoiceScreenShare, type VoiceState } from "./voice";
import { decryptChatMessage, encryptChatMessage, isChatKey } from "./chat-crypto";
import { playNotificationSound } from "./sounds";
import { Avatar, type AvatarReference } from "./components/Avatar";
import { AttachmentCard } from "./components/AttachmentCard";
import { ServerFilesView, type SharedFileViewModel } from "./components/ServerFilesView";
import { ChatRichText, attachmentItems, completeMention, containsMention, mentionQueryAtCursor, mentionSuggestions, parseEmbeddedContent } from "./chat-content";
import { searchEncryptedMessages, type LocalSearchProgress, type LocalSearchResult } from "./chat-search";
import "./styles.css";

interface MediaAssetReference {
  assetId: string;
  version?: string;
  name?: string;
  mimeType?: string;
  size?: number;
}

interface CommunityRole {
  id: string;
  name: string;
  position: number;
  kind: "owner" | "admin" | "default" | "custom";
  permissions: string[];
}

interface CommunityEmote {
  id: string;
  name: string;
  asset: MediaAssetReference;
  animated: boolean;
}

interface ExtendedReaction {
  emoji?: string;
  unicode?: string;
  emoteId?: string;
  target?: { kind: "unicode"; value: string } | { kind: "emote"; emoteId: string };
  count: number;
  reacted: boolean;
  emote?: CommunityEmote;
}

interface ExtendedPrincipal {
  avatar?: AvatarReference | null;
  permissions?: string[];
  roles?: CommunityRole[];
}

interface VoiceParticipantMenu {
  x: number;
  y: number;
  identity: string;
  channelId: string;
}

interface ChannelContextMenu {
  x: number;
  y: number;
  channel: ChannelMetadata;
}

function resultMessage(value: unknown): string | undefined {
  return typeof value === "object" && value !== null && "message" in value && typeof value.message === "string" ? value.message : undefined;
}

function memberAvatar(member: CommunityMember | AuthenticatedUser | undefined): AvatarReference | null | undefined {
  return (member as (CommunityMember | AuthenticatedUser) & ExtendedPrincipal | undefined)?.avatar;
}

const customEmoteImageCache = new Map<string, Promise<string | undefined>>();

function loadCustomEmoteImage(emote: CommunityEmote): Promise<string | undefined> {
  const cacheKey = `${emote.asset.assetId}:${emote.asset.version ?? ""}`;
  const existing = customEmoteImageCache.get(cacheKey);
  if (existing) return existing;
  const request = window.freecord.getMediaImageData(emote.asset.assetId).then((result) => {
    if ("dataUrl" in result) return result.dataUrl;
    customEmoteImageCache.delete(cacheKey);
    return undefined;
  }).catch(() => {
    customEmoteImageCache.delete(cacheKey);
    return undefined;
  });
  customEmoteImageCache.set(cacheKey, request);
  return request;
}

function CustomEmoteImage({ emote, className }: { emote: CommunityEmote; className?: string }): React.JSX.Element {
  const [source, setSource] = React.useState<string>();
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => {
    let active = true;
    setFailed(false);
    setSource(undefined);
    void loadCustomEmoteImage(emote).then((dataUrl) => {
      if (!active) return;
      if (dataUrl) setSource(dataUrl); else setFailed(true);
    });
    return () => { active = false; };
  }, [emote.asset.assetId, emote.asset.version]);
  if (!source) return <span className={`custom-emote-placeholder ${className ?? ""}`.trim()} title={`:${emote.name}:`}>{failed ? `:${emote.name}:` : "…"}</span>;
  return <img className={className} src={source} alt={`:${emote.name}:`} title={`:${emote.name}:`} loading="lazy" decoding="async" onError={() => { customEmoteImageCache.delete(`${emote.asset.assetId}:${emote.asset.version ?? ""}`); setSource(undefined); setFailed(true); }} />;
}

function renderMessageText(content: string, emotes: CommunityEmote[], members: CommunityMember[], currentUsername: string): React.ReactNode {
  return <ChatRichText content={content} emotes={emotes} members={members} currentUsername={currentUsername} renderEmote={(token, key) => {
    const emote = emotes.find((item) => item.id === token.id)!;
    return <CustomEmoteImage className="inline-custom-emote" emote={emote} key={key} />;
  }} />;
}

async function decryptMessages(messages: ChatMessage[], key: string): Promise<ChatMessage[]> {
  return Promise.all(messages.map(async (chatMessage) => {
    if (chatMessage.deletedAt) return { ...chatMessage, content: "Message deleted." };
    if (chatMessage.content) return chatMessage;
    if (!chatMessage.ciphertext || !chatMessage.nonce) return { ...chatMessage, content: "[Encrypted message unavailable]" };
    try { return { ...chatMessage, content: await decryptChatMessage(key, chatMessage.ciphertext, chatMessage.nonce) }; } catch { return { ...chatMessage, content: "[Unable to decrypt message]" }; }
  }));
}

const commonEmojis = ["😀", "😂", "😍", "😎", "😭", "😡", "👍", "👎", "👏", "🔥", "🎉", "❤️", "💯", "✅", "👀", "🤔", "🙏", "🚀", "🎮", "💬"];

async function pastedImageDataUrl(file: File): Promise<string> {
  const source = await createImageBitmap(file);
  const scale = Math.min(1, 1024 / source.width, 1024 / source.height);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(source.width * scale));
  canvas.height = Math.max(1, Math.round(source.height * scale));
  canvas.getContext("2d")?.drawImage(source, 0, 0, canvas.width, canvas.height);
  source.close();
  const dataUrl = canvas.toDataURL("image/jpeg", 0.78);
  if (dataUrl.length > 650000) throw new Error("That image is too large to send. Choose a smaller image.");
  return dataUrl;
}

function sharedFileViewModel(file: SharedFile, message?: ChatMessage): SharedFileViewModel {
  let name = `Attachment ${file.mediaId.slice(0, 8)}`;
  if (message?.content) name = attachmentItems(message.content).find((item) => item.assetId === file.mediaId)?.name ?? name;
  return { ...file, name };
}

function mergeMessage(messages: ChatMessage[], incoming: ChatMessage): ChatMessage[] {
  const byId = new Map(messages.map((message) => [message.id, message]));
  byId.set(incoming.id, incoming);
  return [...byId.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index]!);
    }
  }));
  return results;
}

function ScreenShareTile({ share, selected, audioEnabled = false, onAudioBlocked, onClick, onVolumeChange }: { share: VoiceScreenShare; selected?: boolean; audioEnabled?: boolean; onAudioBlocked?: () => void; onClick?: () => void; onVolumeChange?: (identity: string, volume: number) => void }): React.JSX.Element {
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const audioRef = React.useRef<HTMLAudioElement>(null);
  const onAudioBlockedRef = React.useRef(onAudioBlocked);
  onAudioBlockedRef.current = onAudioBlocked;
  React.useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    share.track.attach(video);
    return () => { share.track.detach(video); };
  }, [share.track]);
  React.useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !share.audioTrack || !audioEnabled) return;
    share.audioTrack.attach(audio);
    void audio.play().catch(() => onAudioBlockedRef.current?.());
    return () => { share.audioTrack?.detach(audio); };
  }, [audioEnabled, share.audioTrack]);
  React.useEffect(() => {
    if (audioRef.current) audioRef.current.volume = share.volume;
  }, [share.volume]);
  return <div className={`screen-share-tile ${selected ? "selected" : ""}`} onClick={onClick}><video ref={videoRef} autoPlay playsInline />{audioEnabled && <audio ref={audioRef} autoPlay playsInline />}<div className="screen-share-controls" onClick={(event) => event.stopPropagation()}><span>{share.name}'s screen</span><label title={share.audioTrack ? `Stream volume for ${share.name}` : "Stream volume will apply when audio is available"}><span className="sr-only">Stream volume</span><input type="range" min="0" max="1" step="0.01" value={share.volume} onChange={(event) => onVolumeChange?.(share.identity, Number(event.target.value))} /></label></div></div>;
}

function App(): React.JSX.Element {
  const voice = React.useMemo(() => new VoiceClient(), []);
  const [voiceState, setVoiceState] = React.useState<VoiceState>(voice.snapshot);
  const [runtime, setRuntime] = React.useState<string>("Loading secure desktop runtime…");
  const [runtimePlatform, setRuntimePlatform] = React.useState<NodeJS.Platform | null>(null);
  const [settings, setSettings] = React.useState<ServerSettings | null>(null);
  const [serverOrigin, setServerOrigin] = React.useState("");
  const [allowInsecureLocalhost, setAllowInsecureLocalhost] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [auth, setAuth] = React.useState<SessionState>({ status: "signed-out", user: null, session: null });
  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [confirmPassword, setConfirmPassword] = React.useState("");
  const [authBusy, setAuthBusy] = React.useState(false);
  const [authMode, setAuthMode] = React.useState<"signin" | "register">("signin");
  const [inviteInput, setInviteInput] = React.useState("");
  const [displayName, setDisplayName] = React.useState("");
  const [channels, setChannels] = React.useState<ChannelMetadata[]>([]);
  const [members, setMembers] = React.useState<CommunityMember[]>([]);
  const [channelsBusy, setChannelsBusy] = React.useState(false);
  const [selectedChannelId, setSelectedChannelId] = React.useState<string | null>(null);
  const [inviteToken, setInviteToken] = React.useState<string | null>(null);
  const [inviteBusy, setInviteBusy] = React.useState(false);
  const [chatMessages, setChatMessages] = React.useState<ChatMessage[]>([]);
  const [chatDraft, setChatDraft] = React.useState("");
  const [chatBusy, setChatBusy] = React.useState(false);
  const [chatKey, setChatKey] = React.useState<string | null>(null);
  const [chatNextCursor, setChatNextCursor] = React.useState<string | null>(null);
  const [chatLoadingOlder, setChatLoadingOlder] = React.useState(false);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [settingsTab, setSettingsTab] = React.useState<"profile" | "audio" | "admin" | "audit">("profile");
  const [profileDisplayName, setProfileDisplayName] = React.useState("");
  const [currentPassword, setCurrentPassword] = React.useState("");
  const [newProfilePassword, setNewProfilePassword] = React.useState("");
  const [confirmProfilePassword, setConfirmProfilePassword] = React.useState("");
  const [profileBusy, setProfileBusy] = React.useState(false);
  const [screenViewerOpen, setScreenViewerOpen] = React.useState(false);
  const [screenViewerFullscreen, setScreenViewerFullscreen] = React.useState(false);
  const [selectedScreenShareId, setSelectedScreenShareId] = React.useState<string | null>(null);
  const [audioSettings, setAudioSettings] = React.useState<AudioSettings>({
    microphoneId: "",
    outputId: "",
    inputSensitivity: 0.5,
    rnnoiseEnabled: false,
    echoCancellation: true,
    automaticGainControl: true,
    nativeNoiseSuppression: true,
  });
  const [newChannelName, setNewChannelName] = React.useState("");
  const [newChannelType, setNewChannelType] = React.useState<"text" | "voice">("text");
  const [emojiPickerOpen, setEmojiPickerOpen] = React.useState(false);
  const [reactionPickerMessageId, setReactionPickerMessageId] = React.useState<string | null>(null);
  const [messageMenu, setMessageMenu] = React.useState<{ x: number; y: number; message: ChatMessage } | null>(null);
  const [voiceParticipantMenu, setVoiceParticipantMenu] = React.useState<VoiceParticipantMenu | null>(null);
  const [channelMenu, setChannelMenu] = React.useState<ChannelContextMenu | null>(null);
  const [pendingImage, setPendingImage] = React.useState<string | null>(null);
  const [giphyOpen, setGiphyOpen] = React.useState(false);
  const [giphyQuery, setGiphyQuery] = React.useState("");
  const [giphyResults, setGiphyResults] = React.useState<GiphyResult[]>([]);
  const [activeView, setActiveView] = React.useState<"chat" | "copyparty" | "server-files">("chat");
  const [unreadByChannel, setUnreadByChannel] = React.useState<Record<string, number>>({});
  const [searchOpen, setSearchOpen] = React.useState(false);
  const [searchQuery, setSearchQuery] = React.useState("");
  const [searchResults, setSearchResults] = React.useState<LocalSearchResult[]>([]);
  const [searchProgress, setSearchProgress] = React.useState<LocalSearchProgress | null>(null);
  const [searchBusy, setSearchBusy] = React.useState(false);
  const [searchError, setSearchError] = React.useState<string | null>(null);
  const [mentionCursor, setMentionCursor] = React.useState(0);
  const [mentionSelection, setMentionSelection] = React.useState(0);
  const [jumpMessageId, setJumpMessageId] = React.useState<string | null>(null);
  const [sharedFiles, setSharedFiles] = React.useState<SharedFileViewModel[]>([]);
  const [sharedFilesCursor, setSharedFilesCursor] = React.useState<string | null>(null);
  const [sharedFilesBusy, setSharedFilesBusy] = React.useState(false);
  const [sharedFilesError, setSharedFilesError] = React.useState<string | undefined>();
  const [auditEvents, setAuditEvents] = React.useState<AuditEvent[]>([]);
  const [auditCursor, setAuditCursor] = React.useState<string | null>(null);
  const [auditBusy, setAuditBusy] = React.useState(false);
  const [auditError, setAuditError] = React.useState<string | undefined>();
  const [roles, setRoles] = React.useState<CommunityRole[]>([]);
  const [availablePermissions, setAvailablePermissions] = React.useState<string[]>([]);
  const [newRoleName, setNewRoleName] = React.useState("");
  const [newRolePermissions, setNewRolePermissions] = React.useState<string[]>([]);
  const [roleDraftPermissions, setRoleDraftPermissions] = React.useState<Record<string, string[]>>({});
  const [assignmentMemberId, setAssignmentMemberId] = React.useState("");
  const [assignmentRoleId, setAssignmentRoleId] = React.useState("");
  const [managedMember, setManagedMember] = React.useState<CommunityMember | null>(null);
  const [memberAdminBusy, setMemberAdminBusy] = React.useState(false);
  const [memberResetPassword, setMemberResetPassword] = React.useState("");
  const [memberResetPasswordConfirm, setMemberResetPasswordConfirm] = React.useState("");
  const [memberDeactivateConfirm, setMemberDeactivateConfirm] = React.useState("");
  const [emotes, setEmotes] = React.useState<CommunityEmote[]>([]);
  const [emoteName, setEmoteName] = React.useState("");
  const [pendingAttachment, setPendingAttachment] = React.useState<MediaAssetReference | null>(null);
  const [streamAudioBlocked, setStreamAudioBlocked] = React.useState(false);
  const [editingMessageId, setEditingMessageId] = React.useState<string | null>(null);
  const [editingDraft, setEditingDraft] = React.useState("");
  const chatMessagesRef = React.useRef<HTMLDivElement>(null);
  const chatStateRef = React.useRef<ChatMessage[]>([]);
  const chatNearBottomRef = React.useRef(true);
  const scrolledChannelRef = React.useRef<string | null>(null);
  const previousActiveViewRef = React.useRef(activeView);
  const chatInputRef = React.useRef<HTMLTextAreaElement>(null);
  const searchAbortRef = React.useRef<AbortController | null>(null);
  const sessionGenerationRef = React.useRef(0);
  const sharedMessageCacheRef = React.useRef(new Map<string, ChatMessage>());
  const sharedFilesInFlightRef = React.useRef(false);
  const sharedFilesRefreshPendingRef = React.useRef(false);
  const jumpInProgressRef = React.useRef(false);
  const selectedChannelIdRef = React.useRef<string | null>(null);
  const chatKeyRef = React.useRef<string | null>(null);
  const authUserRef = React.useRef<AuthenticatedUser | null>(null);
  const chatPanelRef = React.useRef<HTMLElement>(null);
  const previousVoiceStateRef = React.useRef(voiceState);
  const knownVoiceParticipantsRef = React.useRef<Set<string> | null>(null);
  const chatSoundChannelRef = React.useRef<string | null>(null);
  const knownChatMessageIdsRef = React.useRef(new Set<string>());
  const chatSoundInitializedRef = React.useRef(false);

  React.useEffect(() => {
    const closeMenus = () => { setMessageMenu(null); setReactionPickerMessageId(null); setVoiceParticipantMenu(null); setChannelMenu(null); };
    window.addEventListener("click", closeMenus);
    return () => window.removeEventListener("click", closeMenus);
  }, []);

  React.useEffect(() => { selectedChannelIdRef.current = selectedChannelId; }, [selectedChannelId]);
  React.useEffect(() => { chatKeyRef.current = chatKey; }, [chatKey]);
  React.useEffect(() => { authUserRef.current = auth.user; }, [auth.user]);
  React.useEffect(() => { chatStateRef.current = chatMessages; }, [chatMessages]);

  React.useEffect(() => {
    sessionGenerationRef.current += 1;
    searchAbortRef.current?.abort();
    searchAbortRef.current = null;
    sharedMessageCacheRef.current.clear();
    sharedFilesInFlightRef.current = false;
    sharedFilesRefreshPendingRef.current = false;
    jumpInProgressRef.current = false;
    setSharedFilesBusy(false);
    setSharedFilesError(undefined);
    setAuditBusy(false);
    setAuditError(undefined);
    setSearchOpen(false);
    setSearchQuery("");
    setSearchResults([]);
    setSearchProgress(null);
    setSearchBusy(false);
    setSearchError(null);
  }, [auth.status, auth.session?.id, settings?.serverOrigin]);

  React.useEffect(() => {
    let active = true;
    void window.freecord.getWindowFullscreen().then((fullscreen) => {
      if (active) setScreenViewerFullscreen(fullscreen);
    });
    const stop = window.freecord.onWindowFullscreenChanged(setScreenViewerFullscreen);
    return () => {
      active = false;
      stop();
    };
  }, []);

  React.useEffect(() => {
    if (auth.status === "authenticated") return;
    void window.freecord.setWindowFullscreen(false);
    setScreenViewerFullscreen(false);
    setScreenViewerOpen(false);
  }, [auth.status]);

  React.useEffect(() => {
    return voice.subscribe(setVoiceState);
  }, [voice]);

  React.useEffect(() => {
    if (!settingsOpen) return;
    setProfileDisplayName(auth.user?.displayName ?? "");
    const closeSettingsOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSettingsOpen(false);
    };
    window.addEventListener("keydown", closeSettingsOnEscape);
    return () => window.removeEventListener("keydown", closeSettingsOnEscape);
  }, [settingsOpen, auth.user?.displayName]);

  React.useEffect(() => {
    if (auth.status !== "authenticated") {
      setRoles([]);
      setAvailablePermissions([]);
      setEmotes([]);
      return;
    }
    const principal = auth.user as (AuthenticatedUser & ExtendedPrincipal) | null;
    const canViewRoles = principal?.role === "owner" || principal?.role === "admin"
      || principal?.permissions?.some((permission) => ["roles.view", "roles.manage", "roles.assign"].includes(permission));
    const generation = sessionGenerationRef.current;
    if (canViewRoles && window.freecord.getCommunityRoles) {
      void window.freecord.getCommunityRoles().then((result) => {
        if (generation !== sessionGenerationRef.current) return;
        if ("roles" in result) {
          setRoles(result.roles);
          setAvailablePermissions(result.permissions);
          setRoleDraftPermissions(Object.fromEntries(result.roles.map((role) => [role.id, role.permissions])));
        } else setMessage(result.message);
      });
    }
    void refreshCommunityEmotes(true);
  }, [auth.status, auth.user]);

  React.useEffect(() => {
    if (activeView !== "copyparty" || settingsOpen || screenViewerOpen || voiceParticipantMenu) {
      void window.freecord.hideFilesSurface();
      return;
    }
    const panel = chatPanelRef.current;
    if (!panel || !window.freecord.showFilesSurface) {
      setMessage("Copyparty integration is unavailable until the secure desktop bridge is updated.");
      return;
    }
    const bounds = () => {
      const rect = panel.getBoundingClientRect();
      return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.max(0, Math.round(rect.width)), height: Math.max(0, Math.round(rect.height)) };
    };
    void window.freecord.showFilesSurface(bounds()).then((result) => {
      if (!("ok" in result) || !result.ok) setMessage(resultMessage(result) ?? "Copyparty could not be opened.");
    });
    const observer = new ResizeObserver(() => void window.freecord.showFilesSurface(bounds()));
    observer.observe(panel);
    const handleResize = () => void window.freecord.showFilesSurface(bounds());
    window.addEventListener("resize", handleResize);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", handleResize);
      void window.freecord.hideFilesSurface();
    };
  }, [activeView, screenViewerOpen, settingsOpen, voiceParticipantMenu]);

  React.useEffect(() => {
    void Promise.all([window.freecord.getRuntimeInfo(), window.freecord.getServerSettings(), window.freecord.getSessionState(), window.freecord.getAudioSettings()]).then(([info, savedSettings, sessionState, savedAudio]) => {
      setRuntime(`FreeCord ${info.appVersion} · ${info.platform}`);
      setRuntimePlatform(info.platform);
      voice.setRuntimePlatform(info.platform);
      setSettings(savedSettings);
      setServerOrigin(savedSettings.serverOrigin ?? "");
      setAllowInsecureLocalhost(savedSettings.allowInsecureLocalhost);
      setAuth(sessionState);
      setAudioSettings(savedAudio);
      voice.setAudioPreferences(savedAudio);
    });
  }, []);

  React.useEffect(() => () => { void voice.leave(); }, [voice]);

  React.useEffect(() => {
    const previous = previousVoiceStateRef.current;
    const isInVoice = voiceState.status === "connected" || voiceState.status === "reconnecting";
    const wasInVoice = previous.status === "connected" || previous.status === "reconnecting";
    const changedChannel = previous.channelId !== voiceState.channelId;

    if (isInVoice && (!wasInVoice || changedChannel)) {
      playNotificationSound("join");
      knownVoiceParticipantsRef.current = new Set(voiceState.participants.map((participant) => participant.identity));
    } else if (isInVoice && wasInVoice && !changedChannel) {
      const currentParticipants = new Set(voiceState.participants.map((participant) => participant.identity));
      const knownParticipants = knownVoiceParticipantsRef.current ?? new Set<string>();
      if ([...currentParticipants].some((identity) => !knownParticipants.has(identity))) playNotificationSound("participant-join");
      if ([...knownParticipants].some((identity) => !currentParticipants.has(identity))) playNotificationSound("participant-leave");
      knownVoiceParticipantsRef.current = currentParticipants;
    }

    if (wasInVoice && !isInVoice && voiceState.status === "idle") {
      playNotificationSound("leave");
      knownVoiceParticipantsRef.current = null;
    }
    if (wasInVoice && voiceState.muted !== previous.muted) playNotificationSound("mute");
    if (wasInVoice && voiceState.deafened !== previous.deafened) playNotificationSound("deafen");
    previousVoiceStateRef.current = voiceState;
  }, [voiceState]);

  React.useEffect(() => {
    if (auth.status !== "authenticated") {
      setChannelsBusy(false);
      setChannels([]);
      setMembers([]);
      setSelectedChannelId(null);
      setChatKey(null);
      setChatNextCursor(null);
      setActiveView("chat");
      setPendingAttachment(null);
      setUnreadByChannel({});
      setSharedFiles([]);
      setSharedFilesCursor(null);
      setAuditEvents([]);
      setAuditCursor(null);
      searchAbortRef.current?.abort();
      setSearchOpen(false);
      setSearchQuery("");
      setSearchResults([]);
      setSearchProgress(null);
      setSearchBusy(false);
      setSearchError(null);
      return;
    }
    const generation = sessionGenerationRef.current;
    const currentSession = () => generation === sessionGenerationRef.current;
    void window.freecord.getChatKey().then((key) => { if (currentSession()) setChatKey(key); }).catch((error: unknown) => { if (currentSession()) setMessage(error instanceof Error ? error.message : "Secure chat is unavailable."); });
    setChannelsBusy(true);
    void window.freecord.getChannels().then((result) => {
      if (!currentSession()) return;
      setChannelsBusy(false);
      if ("channels" in result) {
        setChannels(result.channels);
        setSelectedChannelId((current) => current ?? result.channels.find((channel) => channel.type === "text")?.id ?? null);
      }
      else setMessage(result.message);
    });
    const loadMembers = async () => {
      const result = await window.freecord.getMembers();
      if (!currentSession()) return;
      if ("members" in result) {
        setMembers(result.members);
        setAuth((current) => {
          if (!current.user) return current;
          const refreshed = result.members.find((member) => member.id === current.user!.id);
          return refreshed ? { ...current, user: { ...current.user, ...refreshed } } : current;
        });
      }
      else setMessage(result.message);
    };
    void loadMembers();
    const memberTimer = window.setInterval(() => void loadMembers(), 5000);
    return () => window.clearInterval(memberTimer);
  }, [auth.status]);

  React.useEffect(() => {
    const selected = channels.find((channel) => channel.id === selectedChannelId);
    if (auth.status !== "authenticated" || selected?.type !== "text") {
      setChatMessages([]);
      setChatNextCursor(null);
      chatSoundChannelRef.current = null;
      knownChatMessageIdsRef.current.clear();
      chatSoundInitializedRef.current = false;
      return;
    }
    setChatMessages([]);
    setChatNextCursor(null);
    setChatLoadingOlder(false);
    let active = true;
    let initialPageLoaded = false;
    const load = async (reconcile = false) => {
      const result = await window.freecord.getMessages(selected.id);
      if (!active) return;
      if ("messages" in result && isChatKey(chatKey)) {
        const decrypted = await decryptMessages(result.messages, chatKey);
        if (active) {
          if (!initialPageLoaded) setChatNextCursor(result.nextCursor ?? null);
          setChatMessages((current) => {
            const source = reconcile || current.length > 0 ? [...current, ...decrypted] : decrypted;
            return [...new Map(source.map((item) => [item.id, item])).values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
          });
          initialPageLoaded = true;
        }
      } else if (!("messages" in result)) setMessage(result.message);
    };
    void load();
    // Retain slow polling as a catch-up fallback while realtime SSE is unavailable.
    const timer = window.setInterval(() => void load(true), 30_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [auth.status, channels, selectedChannelId, chatKey]);

  React.useEffect(() => {
    if (selectedChannelId && activeView === "chat") setUnreadByChannel((current) => ({ ...current, [selectedChannelId]: 0 }));
  }, [activeView, selectedChannelId]);

  React.useEffect(() => {
    if (auth.status !== "authenticated") return;
    const generation = sessionGenerationRef.current;
    const currentSession = () => sessionGenerationRef.current === generation;
    return window.freecord.onRealtimeEvent((event: RealtimeEvent) => {
      void (async () => {
        if (!currentSession()) return;
        if (event.kind === "channels.changed") {
          const result = await window.freecord.getChannels();
          if (currentSession() && "channels" in result) setChannels(result.channels);
          return;
        }
        if (event.kind === "members.changed" || event.kind === "roles.changed" || event.kind === "sync.required") {
          const channelsRequest = event.kind === "roles.changed" || event.kind === "sync.required" ? window.freecord.getChannels() : Promise.resolve(undefined);
          const rolesRequest = event.kind === "roles.changed" || event.kind === "sync.required" ? window.freecord.getCommunityRoles() : Promise.resolve(undefined);
          const result = await window.freecord.getMembers();
          const [freshChannels, freshRoles] = await Promise.all([channelsRequest, rolesRequest]);
          if (!currentSession()) return;
          if ("members" in result) {
            setMembers(result.members);
            setAuth((current) => {
              if (!current.user) return current;
              const refreshed = result.members.find((member) => member.id === current.user!.id);
              return refreshed ? { ...current, user: { ...current.user, ...refreshed } } : current;
            });
          }
          if (freshChannels && "channels" in freshChannels) setChannels(freshChannels.channels);
          if (freshRoles && "roles" in freshRoles) {
            setRoles(freshRoles.roles);
            setAvailablePermissions(freshRoles.permissions);
            setRoleDraftPermissions(Object.fromEntries(freshRoles.roles.map((role) => [role.id, role.permissions])));
          } else if (freshRoles) {
            setRoles([]);
            setAvailablePermissions([]);
          }
          if (event.kind === "sync.required") {
            const selected = selectedChannelIdRef.current;
            const key = chatKeyRef.current;
            const channelSource = freshChannels && "channels" in freshChannels ? freshChannels.channels : channels;
            setUnreadByChannel((current) => ({
              ...current,
              ...Object.fromEntries(channelSource.filter((channel) => channel.type === "text" && channel.id !== selected).map((channel) => [channel.id, Math.max(1, current[channel.id] ?? 0)])),
            }));
            if (selected && isChatKey(key)) {
              const existingIds = new Set(chatStateRef.current.map((message) => message.id));
              const recovered: ChatMessage[] = [];
              let cursor: string | undefined;
              let foundOverlap = existingIds.size === 0;
              do {
                const page = await window.freecord.getMessages(selected, cursor);
                if (!("messages" in page) || !currentSession()) break;
                const decrypted = await decryptMessages(page.messages, key);
                recovered.push(...decrypted);
                if (decrypted.some((message) => existingIds.has(message.id))) foundOverlap = true;
                cursor = page.nextCursor;
              } while (cursor && !foundOverlap);
              if (currentSession() && selectedChannelIdRef.current === selected) {
                setChatMessages((current) => recovered.reduce((merged, message) => mergeMessage(merged, message), current));
              }
            }
          }
          return;
        }
        if (event.kind === "emotes.changed") {
          await refreshCommunityEmotes(true, generation);
          return;
        }
        if (event.kind === "audit.changed") {
          if (currentSession() && settingsOpen && settingsTab === "audit") await loadAuditLog(false, true);
          return;
        }
        if (!event.kind.startsWith("message.") || !event.channelId || !event.messageId) return;
        const selectedAtEvent = selectedChannelIdRef.current;
        if (event.kind === "message.created" && event.actorId !== authUserRef.current?.id && (selectedAtEvent !== event.channelId || activeView !== "chat")) {
          setUnreadByChannel((current) => ({ ...current, [event.channelId!]: (current[event.channelId!] ?? 0) + 1 }));
        }
        if (activeView === "server-files" && (event.kind === "message.created" || event.kind === "message.deleted")) {
          await loadSharedFiles(false, true);
        }
        const result = await window.freecord.getMessage(event.channelId, event.messageId);
        if (!currentSession()) return;
        if (!("id" in result)) {
          if (event.kind === "message.deleted" && selectedAtEvent === event.channelId) {
            setChatMessages((current) => current.map((item) => item.id === event.messageId ? { ...item, deletedAt: event.occurredAt, content: "Message deleted.", reactions: [] } : item));
          }
          return;
        }
        const key = chatKeyRef.current;
        if (!isChatKey(key)) return;
        const [decrypted] = await decryptMessages([result], key);
        if (!decrypted || !currentSession()) return;
        const currentUser = authUserRef.current;
        if (event.kind === "message.created" && selectedChannelIdRef.current === event.channelId) {
          knownChatMessageIdsRef.current.add(decrypted.id);
        }
        if (selectedChannelIdRef.current === event.channelId) {
          setChatMessages((current) => mergeMessage(current, decrypted));
        }
        if (event.kind === "message.created" && event.actorId !== currentUser?.id && decrypted.content) {
          playNotificationSound("message");
          const embedded = parseEmbeddedContent(decrypted.content);
          const mentionText = embedded?.type === "attachments" ? embedded.text ?? "" : embedded ? "" : decrypted.content;
          if (currentUser && containsMention(mentionText, currentUser.username)
            && document.visibilityState !== "visible" && Notification.permission === "granted") {
            new Notification(`Mention from ${decrypted.authorDisplayName}`, { body: mentionText.slice(0, 180) });
          }
        }
      })().catch((error: unknown) => {
        if (currentSession()) setMessage(error instanceof Error ? error.message : "Realtime chat could not be updated.");
      });
    });
  }, [activeView, auth.status, settingsOpen, settingsTab]);

  React.useEffect(() => {
    if (auth.status !== "authenticated" || !selectedChannelId) return;
    if (chatSoundChannelRef.current !== selectedChannelId) {
      chatSoundChannelRef.current = selectedChannelId;
      knownChatMessageIdsRef.current.clear();
      chatSoundInitializedRef.current = false;
      return;
    }
    if (!chatSoundInitializedRef.current) {
      if (chatMessages.length === 0) return;
      chatMessages.forEach((chatMessage) => knownChatMessageIdsRef.current.add(chatMessage.id));
      chatSoundInitializedRef.current = true;
      return;
    }
    const newMessages = chatMessages.filter((chatMessage) => !knownChatMessageIdsRef.current.has(chatMessage.id));
    chatMessages.forEach((chatMessage) => knownChatMessageIdsRef.current.add(chatMessage.id));
    if (newMessages.length > 0) playNotificationSound("message");
  }, [auth.status, selectedChannelId, chatMessages]);

  React.useLayoutEffect(() => {
    const element = chatMessagesRef.current;
    if (!element) return;
    if (scrolledChannelRef.current !== selectedChannelId) {
      scrolledChannelRef.current = selectedChannelId;
      element.scrollTop = element.scrollHeight;
      chatNearBottomRef.current = true;
    } else if (!jumpInProgressRef.current && chatNearBottomRef.current) element.scrollTop = element.scrollHeight;
  }, [chatMessages.length, selectedChannelId]);

  React.useLayoutEffect(() => {
    const previousView = previousActiveViewRef.current;
    previousActiveViewRef.current = activeView;
    if (activeView !== "chat" || previousView === "chat") return;
    requestAnimationFrame(() => {
      const element = chatMessagesRef.current;
      if (!element) return;
      element.scrollTop = element.scrollHeight;
      chatNearBottomRef.current = true;
    });
  }, [activeView]);

  React.useEffect(() => {
    if (!jumpMessageId || !selectedChannelId || !isChatKey(chatKey)) return;
    let active = true;
    let positionScheduled = false;
    jumpInProgressRef.current = true;
    chatNearBottomRef.current = false;
    void window.freecord.getMessage(selectedChannelId, jumpMessageId).then(async (result) => {
      if (!active || !("id" in result)) { jumpInProgressRef.current = false; return; }
      const [decrypted] = await decryptMessages([result], chatKey);
      if (!active || !decrypted) { jumpInProgressRef.current = false; return; }
      setChatMessages((current) => mergeMessage(current, decrypted));
      positionScheduled = true;
      requestAnimationFrame(() => {
        const target = document.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(jumpMessageId)}"]`);
        target?.scrollIntoView({ block: "center", behavior: "smooth" });
        target?.classList.add("message-jump-highlight");
        window.setTimeout(() => target?.classList.remove("message-jump-highlight"), 1800);
        jumpInProgressRef.current = false;
      });
      setJumpMessageId(null);
    });
    return () => { active = false; if (!positionScheduled) jumpInProgressRef.current = false; };
  }, [chatKey, jumpMessageId, selectedChannelId]);

  async function loadOlderMessages(): Promise<void> {
    const selected = channels.find((channel) => channel.id === selectedChannelId);
    if (chatLoadingOlder || !chatNextCursor || auth.status !== "authenticated" || selected?.type !== "text" || !isChatKey(chatKey)) return;
    setChatLoadingOlder(true);
    const element = chatMessagesRef.current;
    const previousHeight = element?.scrollHeight ?? 0;
    chatNearBottomRef.current = false;
    const result = await window.freecord.getMessages(selected.id, chatNextCursor);
    if ("messages" in result) {
      const older = await decryptMessages(result.messages, chatKey);
      setChatMessages((current) => {
        const byId = new Map([...older, ...current].map((item) => [item.id, item]));
        return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      });
      setChatNextCursor(result.nextCursor ?? null);
      requestAnimationFrame(() => {
        if (chatMessagesRef.current) chatMessagesRef.current.scrollTop += chatMessagesRef.current.scrollHeight - previousHeight;
      });
    } else setMessage(result.message);
    setChatLoadingOlder(false);
  }

  async function loadSharedFiles(append = false, silent = false): Promise<void> {
    if (sharedFilesInFlightRef.current) {
      if (!append) sharedFilesRefreshPendingRef.current = true;
      return;
    }
    if (!isChatKey(chatKey)) return;
    const generation = sessionGenerationRef.current;
    const key = chatKey;
    sharedFilesInFlightRef.current = true;
    setSharedFilesBusy(true);
    if (!silent) setSharedFilesError(undefined);
    try {
      const result = await window.freecord.getSharedFiles(append ? sharedFilesCursor ?? undefined : undefined);
      if (!("files" in result)) {
        if (!silent) setSharedFilesError(result.message);
        return;
      }
      const uniqueMessages = new Map(result.files.map((file) => [`${file.channelId}:${file.messageId}`, file]));
      await mapWithConcurrency([...uniqueMessages.entries()], 4, async ([cacheKey, file]) => {
        if (sharedMessageCacheRef.current.has(cacheKey)) return;
        const message = await window.freecord.getMessage(file.channelId, file.messageId);
        if (!("id" in message) || sessionGenerationRef.current !== generation) return;
        const [decrypted] = await decryptMessages([message], key);
        if (decrypted && sessionGenerationRef.current === generation) sharedMessageCacheRef.current.set(cacheKey, decrypted);
      });
      if (sessionGenerationRef.current !== generation) return;
      const models = result.files.map((file) => sharedFileViewModel(file, sharedMessageCacheRef.current.get(`${file.channelId}:${file.messageId}`)));
      setSharedFiles((current) => {
        const source = append ? [...current, ...models] : models;
        return [...new Map(source.map((file) => [`${file.messageId}:${file.mediaId}`, file])).values()];
      });
      setSharedFilesCursor(result.nextCursor ?? null);
    } catch (error: unknown) {
      if (!silent) setSharedFilesError(error instanceof Error ? error.message : "Shared files could not be loaded.");
    } finally {
      sharedFilesInFlightRef.current = false;
      if (sessionGenerationRef.current === generation) setSharedFilesBusy(false);
      if (sharedFilesRefreshPendingRef.current && sessionGenerationRef.current === generation) {
        sharedFilesRefreshPendingRef.current = false;
        queueMicrotask(() => void loadSharedFiles(false, true));
      }
    }
  }

  async function loadAuditLog(append = false, silent = false): Promise<void> {
    if (auditBusy) return;
    const generation = sessionGenerationRef.current;
    setAuditBusy(true);
    if (!silent) setAuditError(undefined);
    try {
      const result = await window.freecord.getAuditLog(append ? auditCursor ?? undefined : undefined);
      if (generation !== sessionGenerationRef.current) return;
      if (!("events" in result)) {
        if (!silent) setAuditError(result.message);
        return;
      }
      setAuditEvents((current) => {
        const source = append ? [...current, ...result.events] : result.events;
        return [...new Map(source.map((event) => [event.id, event])).values()];
      });
      setAuditCursor(result.nextCursor ?? null);
    } catch (error: unknown) {
      if (!silent) setAuditError(error instanceof Error ? error.message : "Audit events could not be loaded.");
    } finally {
      if (generation === sessionGenerationRef.current) setAuditBusy(false);
    }
  }

  async function runLocalSearch(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!searchQuery.trim() || !isChatKey(chatKey)) return;
    const generation = sessionGenerationRef.current;
    const query = searchQuery;
    const key = chatKey;
    searchAbortRef.current?.abort();
    const controller = new AbortController();
    searchAbortRef.current = controller;
    setSearchBusy(true);
    setSearchError(null);
    setSearchResults([]);
    setSearchProgress({ channelsComplete: 0, channelCount: channels.filter((channel) => channel.type === "text" && channel.canRead !== false).length, messagesScanned: 0, resultsFound: 0 });
    try {
      const results = await searchEncryptedMessages({
        channels,
        selectedChannelId,
        query,
        chatKey: key,
        signal: controller.signal,
        getMessages: (channelId, before) => window.freecord.getMessages(channelId, before),
        onProgress: (progress) => { if (sessionGenerationRef.current === generation) setSearchProgress(progress); },
      });
      if (!controller.signal.aborted && sessionGenerationRef.current === generation) setSearchResults(results);
    } catch (error: unknown) {
      if (sessionGenerationRef.current === generation && !(error instanceof DOMException && error.name === "AbortError")) setSearchError(error instanceof Error ? error.message : "Encrypted search failed.");
    } finally {
      if (searchAbortRef.current === controller && sessionGenerationRef.current === generation) {
        searchAbortRef.current = null;
        setSearchBusy(false);
      }
    }
  }

  function openMessage(channelId: string, messageId: string): void {
    searchAbortRef.current?.abort();
    setSearchOpen(false);
    setActiveView("chat");
    setSelectedChannelId(channelId);
    setJumpMessageId(messageId);
  }

  function chooseMention(username: string): void {
    const completed = completeMention(chatDraft, mentionCursor, username);
    setChatDraft(completed.content);
    setMentionCursor(completed.cursor);
    setMentionSelection(0);
    requestAnimationFrame(() => {
      chatInputRef.current?.focus();
      chatInputRef.current?.setSelectionRange(completed.cursor, completed.cursor);
    });
  }

  async function saveServer(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSaving(true);
    setMessage(null);
    const result = await window.freecord.saveServerSettings({ serverOrigin, allowInsecureLocalhost });
    setSaving(false);
    if (!result.ok) {
      setMessage(result.message);
      return;
    }
    setSettings(result.settings);
    setServerOrigin(result.settings.serverOrigin ?? "");
    setMessage("Server saved. Sign in to continue.");
  }

  async function login(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setAuthBusy(true);
    setMessage(null);
    const result = await window.freecord.login({ username, password });
    setAuthBusy(false);
    if (!result.ok) {
      setMessage(result.message);
      return;
    }
    setPassword("");
    setAuth(result.state);
    setMessage(null);
  }

  async function register(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (password !== confirmPassword) {
      setMessage("Passwords do not match.");
      return;
    }
    setAuthBusy(true);
    setMessage(null);
    const result = await window.freecord.register({ inviteToken: inviteInput, displayName, username, password });
    setAuthBusy(false);
    if (!result.ok) {
      setMessage(result.message);
      return;
    }
    setPassword("");
    setConfirmPassword("");
    setInviteInput("");
    setAuth(result.state);
    setMessage(null);
  }

  async function logout(): Promise<void> {
    setAuthBusy(true);
    const result = await window.freecord.logout();
    setAuthBusy(false);
    setMessage(result.ok ? "You are signed out." : result.message);
    if (result.ok) setAuth(result.state);
  }

  async function joinVoiceChannel(channel: ChannelMetadata): Promise<void> {
    if (channel.type !== "voice" || channel.canConnect === false) return;
    await voice.join(channel.id);
  }

  async function saveAudioPreferences(next: AudioSettings): Promise<void> {
    try {
      const saved = await window.freecord.saveAudioSettings(next);
      setAudioSettings(saved);
      voice.setAudioPreferences(saved);
      if (voiceState.status === "connected") {
        if (saved.microphoneId && saved.microphoneId !== audioSettings.microphoneId) await voice.selectMicrophone(saved.microphoneId);
        if (saved.outputId && saved.outputId !== audioSettings.outputId) await voice.selectOutput(saved.outputId);
        await voice.applyAudioProcessingPreferences();
      }
      setMessage("Audio settings saved.");
    } catch (error: unknown) { setMessage(error instanceof Error ? error.message : "Audio settings could not be saved."); }
  }

  async function changeStatus(status: "active" | "busy" | "away"): Promise<void> {
    const result = await window.freecord.updateStatus(status);
    if (result.ok) {
      setAuth(result.state);
      setMembers((current) => current.map((member) => member.id === result.state.user?.id ? { ...member, status } : member));
      setMessage(`Status changed to ${status}.`);
    } else setMessage(result.message);
  }

  async function saveProfile(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!profileDisplayName.trim()) return;
    setProfileBusy(true);
    const result = await window.freecord.updateProfile({ displayName: profileDisplayName.trim() });
    setProfileBusy(false);
    if (!result.ok || !result.state.user) { setMessage(result.ok ? "Profile could not be updated." : result.message); return; }
    const updated = result.state.user;
    setAuth(result.state);
    setMembers((current) => current.map((member) => member.id === updated.id ? { ...member, displayName: updated.displayName } : member));
    setProfileDisplayName(updated.displayName);
    setMessage("Profile updated.");
  }

  async function changeProfilePassword(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (newProfilePassword !== confirmProfilePassword) { setMessage("New passwords do not match."); return; }
    if (newProfilePassword.length < 12) { setMessage("New passwords must contain at least 12 characters."); return; }
    setProfileBusy(true);
    const result = await window.freecord.changePassword({ currentPassword, newPassword: newProfilePassword });
    setProfileBusy(false);
    if (!("ok" in result) || !result.ok) { setMessage(resultMessage(result) ?? "Password could not be changed."); return; }
    setCurrentPassword("");
    setNewProfilePassword("");
    setConfirmProfilePassword("");
    setMessage("Password changed. Other signed-in devices were signed out.");
  }

  async function createChannel(event: React.FormEvent<HTMLFormElement>, forcedType?: "text" | "voice"): Promise<void> {
    event.preventDefault();
    if (!newChannelName.trim()) return;
    const result = await window.freecord.createChannel({ name: newChannelName, type: forcedType ?? newChannelType });
    if ("id" in result) {
      const refreshed = await window.freecord.getChannels();
      const nextChannels = "channels" in refreshed ? refreshed.channels : [result];
      setChannels(nextChannels.sort((a, b) => a.type.localeCompare(b.type) || a.position - b.position));
      setNewChannelName("");
      setMessage(`${result.type === "voice" ? "Voice" : "Text"} channel created.`);
    } else setMessage(result.message);
  }

  async function deleteChannel(channel: ChannelMetadata): Promise<void> {
    if (!window.confirm(`Delete the ${channel.type} channel #${channel.name}?`)) return;
    const result = await window.freecord.deleteChannel(channel.id);
    if ("ok" in result && result.ok) {
      if (voiceState.channelId === channel.id) await voice.leave();
      const refreshed = await window.freecord.getChannels();
      if ("channels" in refreshed) {
        setChannels(refreshed.channels);
        setSelectedChannelId((current) => current === channel.id ? refreshed.channels.find((item) => item.type === "text")?.id ?? null : current);
      }
      setMessage(`${channel.type === "voice" ? "Voice" : "Text"} channel deleted.`);
    } else if ("message" in result) setMessage(result.message);
  }

  async function renameChannel(channel: ChannelMetadata): Promise<void> {
    const name = window.prompt(`Rename ${channel.type} channel`, channel.name)?.trim();
    if (!name || name === channel.name) return;
    const result = await window.freecord.updateChannel(channel.id, name);
    if (!("id" in result)) { setMessage(result.message); return; }
    setChannels((current) => current.map((item) => item.id === result.id ? { ...item, ...result } : item));
    setMessage(`${result.type === "voice" ? "Voice" : "Text"} channel renamed.`);
  }

  function openChannelMenu(event: React.MouseEvent, channel: ChannelMetadata): void {
    event.preventDefault();
    event.stopPropagation();
    setChannelMenu({
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 210)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 120)),
      channel,
    });
  }

  function updateScreenShareSetting<K extends keyof VoiceState["screenShareSettings"]>(key: K, value: VoiceState["screenShareSettings"][K]): void {
    const settings = { ...voiceState.screenShareSettings, [key]: value };
    if (voiceState.screenSharing) void voice.stopScreenShare().then(() => voice.startScreenShare(settings));
    else voice.setScreenShareSettings(settings);
  }

  function openScreenViewer(identity?: string): void {
    const first = identity ?? voiceState.screenShares[0]?.identity ?? null;
    setSelectedScreenShareId(first);
    setScreenViewerOpen(true);
  }

  async function toggleScreenViewerFullscreen(): Promise<void> {
    try {
      await window.freecord.setWindowFullscreen(!screenViewerFullscreen);
    } catch (error: unknown) {
      setMessage(error instanceof Error ? `Full screen is unavailable: ${error.message}` : "Full screen is unavailable.");
    }
  }

  async function closeScreenViewer(): Promise<void> {
    await window.freecord.setWindowFullscreen(false).catch(() => false);
    setScreenViewerFullscreen(false);
    setScreenViewerOpen(false);
  }

  async function createInvite(): Promise<void> {
    setInviteBusy(true);
    const result = await window.freecord.createInvite();
    setInviteBusy(false);
    if ("token" in result) {
      setInviteToken(result.token);
      await navigator.clipboard?.writeText(result.token);
      setMessage("Invitation copied to the clipboard.");
    } else setMessage(result.message);
  }

  async function sendMessage(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const selected = channels.find((channel) => channel.id === selectedChannelId);
    if (selected?.type !== "text" || (!chatDraft.trim() && !pendingImage && !pendingAttachment) || chatBusy) return;
    setChatBusy(true);
    if (!isChatKey(chatKey)) { setChatBusy(false); setMessage("Secure chat is not ready. Please sign in again."); return; }
    let sent = false;
    try {
      const plaintext = pendingAttachment
        ? JSON.stringify({ type: "attachment", assetId: pendingAttachment.assetId, name: pendingAttachment.name ?? "Video", mimeType: pendingAttachment.mimeType ?? "application/octet-stream", size: pendingAttachment.size })
        : pendingImage ? JSON.stringify({ type: "image", dataUrl: pendingImage }) : chatDraft;
      const encrypted = await encryptChatMessage(chatKey, plaintext);
      const result = await window.freecord.sendMessage(selected.id, {
        ...encrypted,
        ...(pendingAttachment ? { attachmentIds: [pendingAttachment.assetId] } : {}),
      });
      if ("ciphertext" in result && result.ciphertext && result.nonce) {
        const content = await decryptChatMessage(chatKey, result.ciphertext, result.nonce);
        knownChatMessageIdsRef.current.add(result.id);
        if (selectedChannelIdRef.current === result.channelId) setChatMessages((current) => mergeMessage(current, { ...result, content }));
        setChatDraft("");
        setPendingImage(null);
        setPendingAttachment(null);
        sent = true;
      } else if ("message" in result) setMessage(result.message);
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : "The encrypted message could not be sent.");
    } finally {
      setChatBusy(false);
      if (sent) requestAnimationFrame(() => chatInputRef.current?.focus());
    }
  }

  async function saveEditedMessage(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const selected = channels.find((channel) => channel.id === selectedChannelId);
    if (selected?.type !== "text" || !editingMessageId || !editingDraft.trim() || !isChatKey(chatKey)) return;
    try {
      const encrypted = await encryptChatMessage(chatKey, editingDraft.trim());
      const result = await window.freecord.editMessage(selected.id, editingMessageId, encrypted);
      if ("ok" in result && result.ok) {
        setChatMessages((current) => current.map((item) => item.id === editingMessageId ? { ...item, content: editingDraft.trim(), ciphertext: encrypted.ciphertext, nonce: encrypted.nonce, editedAt: new Date().toISOString() } : item));
        setEditingMessageId(null);
        setEditingDraft("");
      } else if ("message" in result) setMessage(result.message);
    } catch (error: unknown) { setMessage(error instanceof Error ? error.message : "Message could not be edited."); }
  }

  async function deleteChatMessage(messageId: string): Promise<void> {
    const selected = channels.find((channel) => channel.id === selectedChannelId);
    if (selected?.type !== "text") return;
    const result = await window.freecord.deleteMessage(selected.id, messageId);
    if ("deletedAt" in result) setChatMessages((current) => current.map((item) => item.id === messageId ? { ...item, deletedAt: result.deletedAt, content: "Message deleted.", reactions: [] } : item));
    else setMessage(result.message);
  }

  async function refreshMessage(channelId: string, messageId: string): Promise<void> {
    const generation = sessionGenerationRef.current;
    const key = chatKeyRef.current;
    if (!isChatKey(key)) return;
    const result = await window.freecord.getMessage(channelId, messageId);
    if (!("id" in result) || generation !== sessionGenerationRef.current) return;
    const [decrypted] = await decryptMessages([result], key);
    if (decrypted && generation === sessionGenerationRef.current && selectedChannelIdRef.current === channelId) {
      setChatMessages((current) => mergeMessage(current, decrypted));
    }
  }

  async function toggleReaction(message: ChatMessage, emoji: string): Promise<void> {
    const selected = channels.find((channel) => channel.id === selectedChannelId);
    if (selected?.type !== "text") return;
    const reaction = message.reactions?.find((item) => item.emoji === emoji);
    const result = reaction?.reacted
      ? await window.freecord.removeReaction(selected.id, message.id, emoji)
      : await window.freecord.addReaction(selected.id, message.id, emoji);
    if (!("ok" in result) || !result.ok) { if ("message" in result) setMessage(result.message); return; }
    await refreshMessage(selected.id, message.id);
  }

  function insertEmoji(emoji: string): void {
    setChatDraft((current) => `${current}${emoji}`);
    setEmojiPickerOpen(false);
  }

  function insertCustomEmote(emote: CommunityEmote): void {
    setChatDraft((current) => `${current}:${emote.name}:`);
    setEmojiPickerOpen(false);
  }

  async function refreshCommunityEmotes(silent = false, generation = sessionGenerationRef.current): Promise<void> {
    if (!window.freecord.getCommunityEmotes) return;
    const result = await window.freecord.getCommunityEmotes();
    if (generation !== sessionGenerationRef.current) return;
    if ("emotes" in result) setEmotes(result.emotes);
    else if (!silent) setMessage(result.message);
  }

  async function searchGiphy(): Promise<void> {
    if (!giphyQuery.trim()) return;
    const result = await window.freecord.searchGiphy(giphyQuery);
    if ("results" in result) setGiphyResults(result.results);
    else setMessage(result.message);
  }

  async function selectGiphy(gif: GiphyResult): Promise<void> {
    setGiphyOpen(false);
    setGiphyResults([]);
    setPendingImage(null);
    setChatDraft(JSON.stringify({ type: "gif", id: gif.id, url: gif.displayUrl ?? gif.url, title: gif.title }));
  }

  async function uploadAvatar(file: File): Promise<void> {
    if (!new Set(["image/png", "image/jpeg", "image/webp"]).has(file.type) || file.size > 5 * 1024 * 1024) { setMessage("Choose a PNG, JPEG, or WebP avatar no larger than 5 MB."); return; }
    const result = await window.freecord.uploadAvatar({ name: file.name, mimeType: file.type, bytes: await file.arrayBuffer() });
    if (!("avatar" in result)) { setMessage(result.message); return; }
    const asset = result.avatar;
    setAuth((current) => current.user ? { ...current, user: { ...current.user, avatar: asset } } : current);
    setMembers((current) => current.map((member) => member.id === user?.id ? { ...member, avatar: asset } : member));
    setMessage("Profile picture updated.");
  }

  async function chooseAttachment(): Promise<void> {
    setMessage("Choose a supported image, audio, or video file up to 25 MiB. FreeCord will upload it after selection.");
    setChatBusy(true);
    try {
      const result = await window.freecord.chooseAndUploadMedia();
      if ("canceled" in result) { setMessage("Attachment selection canceled."); return; }
      if (!("assetId" in result)) { setMessage(result.message); return; }
      setPendingImage(null);
      setPendingAttachment({ ...result, name: result.name ?? "Attachment", mimeType: result.mimeType, size: result.size });
      setMessage("Attachment ready to send. Attachments are encrypted in transit but are readable by this self-hosted server.");
      requestAnimationFrame(() => chatInputRef.current?.focus());
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : "The selected file could not be read or uploaded.");
    } finally { setChatBusy(false); }
  }

  function togglePermission(permission: string, selected: string[], update: (next: string[]) => void): void {
    update(selected.includes(permission) ? selected.filter((item) => item !== permission) : [...selected, permission]);
  }

  async function createRole(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!newRoleName.trim()) return;
    const result = await window.freecord.createCommunityRole({ name: newRoleName.trim(), permissions: newRolePermissions });
    if (!("id" in result)) { setMessage(result.message); return; }
    setRoles((current) => [...current, result].sort((a, b) => b.position - a.position));
    setRoleDraftPermissions((current) => ({ ...current, [result.id]: result.permissions }));
    setNewRoleName("");
    setNewRolePermissions([]);
    setMessage(`Role ${result.name} created.`);
  }

  async function saveRole(role: CommunityRole): Promise<void> {
    const permissions = roleDraftPermissions[role.id] ?? role.permissions;
    const result = await window.freecord.updateCommunityRole(role.id, { permissions });
    if (!("id" in result)) { setMessage(result.message); return; }
    setRoles((current) => current.map((item) => item.id === result.id ? result : item));
    setMessage(`Role ${result.name} updated.`);
  }

  async function changeRoleAssignment(remove = false): Promise<void> {
    const action = remove ? window.freecord.removeMemberRole : window.freecord.assignMemberRole;
    if (!action || !assignmentMemberId || !assignmentRoleId) { setMessage("Choose a member and role first."); return; }
    const result = await action(assignmentMemberId, assignmentRoleId);
    if (!("ok" in result) || !result.ok) { setMessage(resultMessage(result) ?? "Role assignment failed."); return; }
    setMembers((current) => current.map((member) => {
      if (member.id !== assignmentMemberId) return member;
      const extended = member as CommunityMember & ExtendedPrincipal;
      const assigned = extended.roles ?? [];
      const selectedRole = roles.find((role) => role.id === assignmentRoleId);
      return { ...member, roles: remove ? assigned.filter((role) => role.id !== assignmentRoleId) : selectedRole && !assigned.some((role) => role.id === selectedRole.id) ? [...assigned, selectedRole] : assigned } as CommunityMember;
    }));
    setMessage(remove ? "Role removed from member." : "Role assigned to member.");
  }

  function closeMemberAdministration(): void {
    if (memberAdminBusy) return;
    setManagedMember(null);
    setMemberResetPassword("");
    setMemberResetPasswordConfirm("");
    setMemberDeactivateConfirm("");
  }

  async function resetManagedMemberPassword(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!managedMember || memberResetPassword.length < 12 || memberResetPassword.length > 1024 || memberResetPassword !== memberResetPasswordConfirm) {
      setMessage(memberResetPassword !== memberResetPasswordConfirm ? "The replacement passwords do not match." : "Use a replacement password of at least 12 characters.");
      return;
    }
    setMemberAdminBusy(true);
    try {
      const result = await window.freecord.resetMemberPassword(managedMember.id, memberResetPassword);
      if (!("ok" in result) || !result.ok) { setMessage(resultMessage(result) ?? "The member password could not be reset."); return; }
      setMembers((current) => current.map((member) => member.id === managedMember.id ? { ...member, online: false } : member));
      setMemberResetPassword("");
      setMemberResetPasswordConfirm("");
      setMessage(`Password reset for ${managedMember.displayName}. Their existing sessions were signed out.`);
    } finally { setMemberAdminBusy(false); }
  }

  async function clearManagedMemberVoiceRestrictions(): Promise<void> {
    if (!managedMember || !window.confirm(`Clear every persistent voice restriction for ${managedMember.displayName}? They must leave and rejoin voice for the change to take effect.`)) return;
    setMemberAdminBusy(true);
    try {
      const result = await window.freecord.clearMemberVoiceRestrictions(managedMember.id);
      if (!("ok" in result) || !result.ok) { setMessage(resultMessage(result) ?? "Voice restrictions could not be cleared."); return; }
      setMessage(result.cleared > 0 ? `Cleared ${result.cleared} voice restriction${result.cleared === 1 ? "" : "s"} for ${managedMember.displayName}.` : `${managedMember.displayName} had no persistent voice restrictions.`);
    } finally { setMemberAdminBusy(false); }
  }

  async function deactivateManagedMember(): Promise<void> {
    if (!managedMember || memberDeactivateConfirm !== managedMember.username) return;
    setMemberAdminBusy(true);
    try {
      const result = await window.freecord.deactivateMember(managedMember.id);
      if (!("ok" in result) || !result.ok) { setMessage(resultMessage(result) ?? "The member account could not be deactivated."); return; }
      setMembers((current) => current.filter((member) => member.id !== managedMember.id));
      setAssignmentMemberId((current) => current === managedMember.id ? "" : current);
      setMessage(`${managedMember.displayName}'s account was deactivated and signed out.`);
      setManagedMember(null);
      setMemberResetPassword("");
      setMemberResetPasswordConfirm("");
      setMemberDeactivateConfirm("");
    } finally { setMemberAdminBusy(false); }
  }

  async function uploadEmote(file: File): Promise<void> {
    if (!emoteName.trim()) { setMessage("Enter an emote name."); return; }
    if (!/^[A-Za-z0-9_]{2,32}$/u.test(emoteName) || !new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]).has(file.type) || file.size > 1024 * 1024) { setMessage("Emote names use 2–32 letters, numbers, or underscores; images must be under 1 MB."); return; }
    const result = await window.freecord.uploadCommunityEmote({ name: emoteName, mimeType: file.type, bytes: await file.arrayBuffer() });
    if (!("id" in result)) { setMessage(result.message); return; }
    setEmotes((current) => [...current, result].sort((a, b) => a.name.localeCompare(b.name)));
    setEmoteName("");
    setMessage(`Emote :${result.name}: uploaded.`);
  }

  async function toggleEmoteReaction(chatMessage: ChatMessage, emote: CommunityEmote): Promise<void> {
    const selected = channels.find((channel) => channel.id === selectedChannelId);
    if (selected?.type !== "text") return;
    const reactions = (chatMessage.reactions ?? []) as ExtendedReaction[];
    const reaction = reactions.find((item) => item.emoteId === emote.id || (item.target?.kind === "emote" && item.target.emoteId === emote.id));
    const action = reaction?.reacted ? window.freecord.removeReaction : window.freecord.addReaction;
    const result = await action(selected.id, chatMessage.id, { kind: "emote", emoteId: emote.id });
    if (!("ok" in result) || !result.ok) { setMessage(resultMessage(result) ?? "Reaction failed."); return; }
    await refreshMessage(selected.id, chatMessage.id);
  }

  async function moderateVoice(action: "mute" | "disconnect" | "move", targetUserId: string, destinationChannelId?: string): Promise<void> {
    if (!voiceState.channelId) return;
    const result = action === "move"
      ? await window.freecord.moveVoiceParticipant(voiceState.channelId, targetUserId, destinationChannelId ?? "")
      : action === "mute" ? await window.freecord.muteVoiceParticipant(voiceState.channelId, targetUserId, true) : await window.freecord.disconnectVoiceParticipant(voiceState.channelId, targetUserId);
    setMessage("ok" in result && result.ok
      ? action === "move" ? "Participant was removed from the source channel; they must join the destination channel." : `Voice ${action} request completed.`
      : resultMessage(result) ?? `Voice ${action} failed.`);
  }

  async function enableStreamAudio(): Promise<void> {
    try { await voice.startAudioPlayback(); setStreamAudioBlocked(false); } catch (error: unknown) { setMessage(error instanceof Error ? error.message : "Stream audio could not start."); }
  }

  React.useEffect(() => {
    if (auth.status === "authenticated" && activeView === "server-files" && isChatKey(chatKey)) void loadSharedFiles(false);
  }, [activeView, auth.status, chatKey]);

  React.useEffect(() => {
    if (auth.status === "authenticated" && settingsOpen && settingsTab === "audit") void loadAuditLog(false);
  }, [auth.status, settingsOpen, settingsTab]);

  React.useEffect(() => () => searchAbortRef.current?.abort(), []);

  const user: AuthenticatedUser | null = auth.user;

  if (user) {
    const selectedChannel = channels.find((channel) => channel.id === selectedChannelId) ?? channels.find((channel) => channel.type === "text");
    const selectedTextChannel = selectedChannel?.type === "text" ? selectedChannel : undefined;
    const textChannels = channels.filter((channel) => channel.type === "text");
    const voiceChannels = channels.filter((channel) => channel.type === "voice");
    const voiceParticipantIds = new Set(voiceState.participants.map((participant) => participant.identity));
    const memberById = new Map(members.map((member) => [member.id, member]));
    const onlineMembers = members.filter((member) => member.online && member.id !== user.id);
    const offlineMembers = members.filter((member) => !member.online && member.id !== user.id);
    const currentMember = memberById.get(user.id);
    const userPermissions = currentMember?.permissions ?? (user as AuthenticatedUser & ExtendedPrincipal).permissions ?? [];
    const hasPermission = (permission: string) => user.role === "owner" || userPermissions.includes(permission) || (user.role === "admin" && ["channels.manage", "channels.text.create", "channels.voice.create", "voice.moderate", "voice.mute", "voice.disconnect", "voice.move", "roles.manage", "roles.assign", "emotes.manage", "emotes.create", "audit.view", "members.password.reset", "members.deactivate", "voice.restrictions.manage"].includes(permission));
    const canManageChannels = hasPermission("channels.manage");
    const canCreateTextChannels = canManageChannels || hasPermission("channels.text.create");
    const canCreateVoiceChannels = canManageChannels || hasPermission("channels.voice.create");
    const canViewAudit = hasPermission("audit.view");
    const canManageMemberAccounts = ["members.password.reset", "members.deactivate", "voice.restrictions.manage"].some(hasPermission);
    const canAccessAdmin = user.role === "owner" || user.role === "admin" || ["channels.manage", "channels.text.create", "channels.voice.create", "roles.view", "roles.manage", "roles.assign", "audit.view", "members.password.reset", "members.deactivate", "voice.restrictions.manage"].some(hasPermission);
    const assignedRoles = (currentMember as (CommunityMember & ExtendedPrincipal) | undefined)?.roles ?? (user as AuthenticatedUser & ExtendedPrincipal).roles ?? [];
    const canMuteVoice = hasPermission("voice.moderate") || hasPermission("voice.mute");
    const canDisconnectVoice = hasPermission("voice.moderate") || hasPermission("voice.disconnect");
    const canMoveVoice = hasPermission("voice.moderate") || hasPermission("voice.move");
    const mentionMembers = members.some((member) => member.id === user.id)
      ? members
      : [{ ...user, online: true } as CommunityMember, ...members];
    const currentMentionQuery = mentionQueryAtCursor(chatDraft, mentionCursor);
    const currentMentionSuggestions = currentMentionQuery ? mentionSuggestions(chatDraft, mentionCursor, mentionMembers) : [];
    return (
      <main className="app-shell">
        <header className="workspace-header"><div className="brand-mark">F</div><strong>FreeCord</strong><span className="header-server">{serverOrigin.replace(/^https?:\/\//, "")}</span><div className="header-user"><Avatar name={user.displayName} avatar={memberAvatar(user)} size="small" />{user.displayName}<button className="header-button" type="button" onClick={() => void logout()} disabled={authBusy}>Sign out</button></div></header>
        <div className="workspace-grid">
          <aside className={`workspace-sidebar ${voiceState.status !== "idle" ? "voice-connected-sidebar" : ""}`}>
            <div className="panel-heading"><span>CHANNELS</span><span className="channel-count">{channels.length}</span></div>
            <div className="channel-section"><div className="channel-section-title">TEXT CHANNELS</div>{channelsBusy && <p className="hint">Loading…</p>}{textChannels.map((channel) => <div className="channel-context-target" key={channel.id} title={canManageChannels ? "Right-click to rename or delete" : undefined} onContextMenu={canManageChannels ? (event) => openChannelMenu(event, channel) : undefined}><button className={`nav-channel ${activeView === "chat" && selectedChannel?.id === channel.id ? "selected" : ""}`} type="button" onClick={() => { setActiveView("chat"); setSelectedChannelId(channel.id); setUnreadByChannel((current) => ({ ...current, [channel.id]: 0 })); }}><span>#</span><span className="channel-name">{channel.name}</span>{Boolean(unreadByChannel[channel.id]) && <span className="unread-count" aria-label={`${unreadByChannel[channel.id]} unread messages`}>{Math.min(unreadByChannel[channel.id] ?? 0, 99)}</span>}</button></div>)}</div>
            <div className="channel-section files-section"><div className="channel-section-title">COMMUNITY</div><button className={`nav-channel ${activeView === "server-files" ? "selected" : ""}`} type="button" onClick={() => setActiveView("server-files")}><span>▤</span>Server Files</button><button className={`nav-channel ${activeView === "copyparty" ? "selected" : ""}`} type="button" onClick={() => setActiveView("copyparty")}><span>▣</span>Copyparty</button></div>
            <div className="channel-section"><div className="channel-section-title">VOICE CHANNELS</div>{voiceChannels.map((channel) => {
              const isActiveVoiceChannel = voiceState.channelId === channel.id;
              const showVoiceMembers = isActiveVoiceChannel && voiceState.status !== "idle" && voiceState.status !== "error";
              return <div className="voice-channel-group" key={channel.id}>
                <div className="channel-context-target" title={canManageChannels ? "Right-click to rename or delete" : undefined} onContextMenu={canManageChannels ? (event) => openChannelMenu(event, channel) : undefined}><button className={`nav-channel ${isActiveVoiceChannel ? "selected" : ""}`} type="button" onClick={() => void joinVoiceChannel(channel)} disabled={channel.canConnect === false || voiceState.status === "connecting"}><span>◖</span>{channel.name}{isActiveVoiceChannel && <em>{voiceState.status}</em>}</button></div>
                {showVoiceMembers && <div className="voice-channel-members" aria-label={`Participants in ${channel.name}`}>
                  <div className={`voice-member ${voiceState.speaking ? "speaking" : ""}`}>
                    <Avatar name={user.displayName} avatar={memberAvatar(user)} size="small" speaking={voiceState.speaking} />
                    <span className="voice-member-name">{user.displayName}</span>
                    <span className="voice-member-icons" aria-label={`${voiceState.muted ? "Microphone muted" : "Microphone on"}${voiceState.deafened ? ", deafened" : ""}`}>{voiceState.muted ? "🎙️" : ""}{voiceState.deafened ? "🔇" : ""}</span>
                    <small>You</small>
                  </div>
                  {voiceState.participants.map((participant) => <div className={`voice-member ${participant.speaking ? "speaking" : ""}`} key={participant.identity} title={`Right-click ${participant.name} for volume and voice actions`} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); setVoiceParticipantMenu({ x: Math.max(8, Math.min(event.clientX, window.innerWidth - 260)), y: Math.max(8, Math.min(event.clientY, window.innerHeight - 250)), identity: participant.identity, channelId: channel.id }); }}>
                    <Avatar name={participant.name} avatar={memberAvatar(memberById.get(participant.identity))} size="small" speaking={participant.speaking} />
                    <span className="voice-member-name">{participant.name}</span>
                    <span className="voice-member-icons" aria-label={`${participant.muted ? "Microphone muted" : "Microphone on"}${participant.deafened ? ", deafened" : ""}`}>{participant.muted ? "🎙️" : ""}{participant.deafened ? "🔇" : ""}</span>
                  </div>)}
                  {voiceState.participants.length === 0 && voiceState.status === "connected" && <small className="voice-channel-empty">No other users connected</small>}
                </div>}
              </div>;
            })}</div>
            {voiceState.status !== "idle" && <div className="voice-dock"><div className="voice-dock-status"><span className="online-dot" />{voiceState.status}</div>{voiceState.error && <p className="voice-error">{voiceState.error}</p>}<div className="voice-dock-actions"><button type="button" onClick={() => void voice.setMuted(!voiceState.muted)}>{voiceState.muted ? "Unmute" : "Mute"}</button><button type="button" onClick={() => void voice.setDeafened(!voiceState.deafened)}>{voiceState.deafened ? "Undeafen" : "Deafen"}</button><button type="button" onClick={() => void voice.leave()}>Leave</button></div>{voiceState.status === "connected" && <><div className="voice-share-options"><label>Share size<select value={voiceState.screenShareSettings.resolution} onChange={(event) => updateScreenShareSetting("resolution", Number(event.target.value) as ScreenShareResolution)} disabled={voiceState.screenShareBusy}><option value="720">720p</option><option value="1080">1080p</option><option value="1440">1440p</option></select></label><label>FPS<select value={voiceState.screenShareSettings.frameRate} onChange={(event) => updateScreenShareSetting("frameRate", Number(event.target.value) as ScreenShareFrameRate)} disabled={voiceState.screenShareBusy}><option value="30">30</option><option value="60">60</option></select></label><label>Bitrate<select value={voiceState.screenShareSettings.bitrate} onChange={(event) => updateScreenShareSetting("bitrate", Number(event.target.value) as ScreenShareBitrate)} disabled={voiceState.screenShareBusy}><option value="4">4 Mbps</option><option value="6">6 Mbps</option><option value="8">8 Mbps</option></select></label></div><label className="screen-audio-toggle"><input type="checkbox" checked={voiceState.screenShareAudioEnabled} onChange={(event) => voice.setScreenShareAudioEnabled(event.target.checked)} disabled={voiceState.screenShareBusy || voiceState.screenSharing} />Share desktop audio</label>{runtimePlatform === "linux" && voiceState.screenShareAudioEnabled && <p className="screen-audio-hint">Application audio is captured automatically; no KDE routing changes are needed.</p>}<button className="voice-share-button" type="button" disabled={voiceState.screenShareBusy} onClick={() => void (voiceState.screenSharing ? voice.stopScreenShare() : voice.startScreenShare())}>{voiceState.screenShareBusy ? "Starting…" : voiceState.screenSharing ? "Stop sharing" : "Share screen"}</button></>}</div>}
            <div className="sidebar-footer"><Avatar name={user.displayName} avatar={memberAvatar(user)} size="small" /><button className="profile-button" type="button" onClick={() => setSettingsOpen(true)}><strong>{user.username}</strong><small>{(user as AuthenticatedUser & ExtendedPrincipal).roles?.map((role) => role.name).join(", ") || user.role}</small></button><button className="icon-button" type="button" title="Open settings" onClick={() => setSettingsOpen(true)}>⚙</button></div>
          </aside>
          <section ref={chatPanelRef} className={`chat-panel ${activeView === "copyparty" ? "copyparty-active" : ""} ${activeView === "server-files" ? "server-files-active" : ""}`} aria-label={activeView === "copyparty" ? "Copyparty" : activeView === "server-files" ? "Server Files" : "Chat"}>
            {activeView === "copyparty" ? <div className="files-placeholder"><div className="empty-icon">▣</div><h2>Copyparty</h2><p>Opening the isolated Copyparty workspace…</p></div> : activeView === "server-files" ? <ServerFilesView files={sharedFiles} loading={sharedFilesBusy} error={sharedFilesError} hasMore={Boolean(sharedFilesCursor)} onLoadMore={() => void loadSharedFiles(true)} onViewInChannel={(file) => openMessage(file.channelId, file.messageId)} /> : <>
              <div className="chat-header"><span className="hash-icon">#</span><div><h1>{selectedChannel?.name ?? "Welcome"}</h1><p>{selectedChannel ? "Text channel · end-to-end encrypted messages" : "Select a channel to get started"}</p></div><button type="button" className={`chat-search-button ${searchOpen ? "active" : ""}`} onClick={() => { setSearchOpen((open) => !open); setSearchError(null); }}>Search</button>{voiceState.screenShares.length > 0 && <details className="screen-share-dropdown"><summary>Streams <span>{voiceState.screenShares.length}</span></summary><div className="screen-share-menu"><button type="button" className="stream-viewer-button" onClick={() => openScreenViewer()}>Open stream viewer</button>{voiceState.screenShares.map((share) => <ScreenShareTile share={share} audioEnabled={false} key={share.identity} onClick={() => openScreenViewer(share.identity)} onVolumeChange={(identity, volume) => voice.setScreenShareVolume(identity, volume)} />)}</div></details>}</div>
              {searchOpen && <aside className="chat-search-panel" aria-label="Encrypted message search"><header><div><strong>Local encrypted search</strong><small>Messages are decrypted and searched only in this window.</small></div><button type="button" className="secondary" onClick={() => { searchAbortRef.current?.abort(); setSearchOpen(false); }}>×</button></header><form onSubmit={(event) => void runLocalSearch(event)}><input type="search" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Search readable channels" autoFocus /><button type="submit" disabled={searchBusy || !searchQuery.trim()}>Search</button></form>{searchProgress && <p className="search-progress">{searchBusy ? `Scanned ${searchProgress.messagesScanned} messages in ${searchProgress.channelsComplete}/${searchProgress.channelCount} channels…` : `${searchResults.length} result${searchResults.length === 1 ? "" : "s"}`}</p>}{searchError && <p className="search-error">{searchError}</p>}<div className="search-results">{searchResults.map((result) => <button type="button" key={`${result.channelId}:${result.message.id}`} onClick={() => openMessage(result.channelId, result.message.id)}><span>#{result.channelName} · {result.message.authorDisplayName}</span><strong>{result.snippet}</strong><time>{new Date(result.message.createdAt).toLocaleString()}</time></button>)}</div></aside>}
              <div className="chat-messages" ref={chatMessagesRef} onScroll={(event) => { const element = event.currentTarget; chatNearBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 80; if (element.scrollTop <= 8) void loadOlderMessages(); }}>{chatLoadingOlder && <div className="chat-history-status">Loading older messages…</div>}{selectedTextChannel && chatMessages.length === 0 && <div className="chat-empty"><div className="empty-icon">#</div><h2>Welcome to #{selectedTextChannel.name}</h2><p>Start the conversation.</p></div>}{!selectedTextChannel && <div className="chat-empty"><div className="empty-icon">#</div><h2>Welcome to FreeCord</h2><p>Choose a text channel from the left to begin.</p></div>}{chatMessages.map((chatMessage) => {
                const embedded = parseEmbeddedContent(chatMessage.content);
                const author = memberById.get(chatMessage.authorId);
                const canManage = chatMessage.authorId === user.id || hasPermission("messages.manage");
                const reactions = (chatMessage.reactions ?? []) as ExtendedReaction[];
                const names = attachmentItems(chatMessage.content);
                const attachments = chatMessage.attachments?.length
                  ? chatMessage.attachments.map((attachment) => ({ assetId: attachment.mediaId, name: names.find((item) => item.assetId === attachment.mediaId)?.name ?? `Attachment ${attachment.mediaId.slice(0, 8)}`, mimeType: attachment.contentType, size: attachment.byteSize, posterAssetId: names.find((item) => item.assetId === attachment.mediaId)?.posterAssetId }))
                  : names;
                const messageText = embedded?.type === "attachments" ? embedded.text ?? "" : embedded ? "" : chatMessage.content ?? "";
                const renderedMessageText = embedded?.type === "attachments"
                  ? renderMessageText(messageText, emotes, mentionMembers, user.username)
                  : renderMessageText(chatMessage.content ?? "", emotes, mentionMembers, user.username);
                return <article data-message-id={chatMessage.id} className={`chat-message ${chatMessage.deletedAt ? "deleted" : ""} ${messageText && containsMention(messageText, user.username) ? "mentions-self" : ""}`} key={chatMessage.id} onContextMenu={(event) => { if (!chatMessage.deletedAt && canManage) { event.preventDefault(); setMessageMenu({ x: event.clientX, y: event.clientY, message: chatMessage }); } }}>
                  <Avatar name={chatMessage.authorDisplayName} avatar={memberAvatar(author)} />
                  <div className="chat-message-body"><div className="message-meta"><strong>{chatMessage.authorDisplayName}</strong><time dateTime={chatMessage.createdAt}>{new Date(chatMessage.createdAt).toLocaleString()}{chatMessage.editedAt && " · edited"}</time></div>
                    {editingMessageId === chatMessage.id ? <form className="message-edit-form" onSubmit={(event) => void saveEditedMessage(event)}><input value={editingDraft} onChange={(event) => setEditingDraft(event.target.value)} autoFocus /><button type="submit">Save</button><button type="button" className="secondary" onClick={() => setEditingMessageId(null)}>Cancel</button></form> : <>
                      {embedded?.type === "gif" && <img className="embedded-gif" src={embedded.url} alt={embedded.title ?? "GIF"} loading="lazy" decoding="async" />}
                      {embedded?.type === "image" && <img className="embedded-image" src={embedded.dataUrl} alt="Pasted image" loading="lazy" decoding="async" />}
                      {messageText && <p>{renderedMessageText}</p>}
                      {attachments.map((attachment) => <AttachmentCard {...attachment} key={attachment.assetId} />)}
                      {!chatMessage.deletedAt && <div className="message-actions">{reactions.map((reaction) => {
                        const reactionEmoteId = reaction.emoteId ?? (reaction.target?.kind === "emote" ? reaction.target.emoteId : undefined);
                        const emote = reaction.emote ?? emotes.find((item) => item.id === reactionEmoteId);
                        const unicode = reaction.emoji ?? reaction.unicode ?? (reaction.target?.kind === "unicode" ? reaction.target.value : "");
                        return emote ? <button type="button" key={`emote:${emote.id}`} className={`reaction-chip ${reaction.reacted ? "reacted" : ""}`} onClick={() => void toggleEmoteReaction(chatMessage, emote)}><CustomEmoteImage emote={emote} /> {reaction.count}</button> : <button type="button" key={unicode} className={reaction.reacted ? "reacted" : ""} onClick={() => void toggleReaction(chatMessage, unicode)}>{unicode} {reaction.count}</button>;
                      })}<span className="reaction-picker-anchor"><button type="button" className="reaction-add" aria-label="Add reaction" onClick={(event) => { event.stopPropagation(); const opening = reactionPickerMessageId !== chatMessage.id; setReactionPickerMessageId(opening ? chatMessage.id : null); if (opening) void refreshCommunityEmotes(); }}>＋</button>{reactionPickerMessageId === chatMessage.id && <div className="reaction-picker" onClick={(event) => event.stopPropagation()}>{commonEmojis.map((emoji) => <button type="button" key={emoji} onClick={() => { void toggleReaction(chatMessage, emoji); setReactionPickerMessageId(null); }}>{emoji}</button>)}{emotes.map((emote) => <button type="button" key={emote.id} title={`:${emote.name}:`} onClick={() => { void toggleEmoteReaction(chatMessage, emote); setReactionPickerMessageId(null); }}><CustomEmoteImage emote={emote} /></button>)}</div>}</span></div>}
                    </>}
                  </div>
                </article>;
              })}</div>
              <form className={`chat-composer ${pendingImage || pendingAttachment ? "has-preview" : ""}`} onSubmit={(event) => void sendMessage(event)}>
                <div className="composer-input-wrap">
                  {pendingImage && <div className="pasted-image-preview"><img src={pendingImage} alt="Pasted image preview" /><button type="button" onClick={() => setPendingImage(null)}>×</button></div>}
                  {pendingAttachment && <div className="pending-attachment"><span>↥</span><div><strong>{pendingAttachment.name}</strong><small>{pendingAttachment.size ? `${(pendingAttachment.size / 1024 / 1024).toFixed(1)} MB · server-readable attachment` : "Server-readable attachment"}</small></div><button type="button" onClick={() => setPendingAttachment(null)}>×</button></div>}
                  <textarea ref={chatInputRef} rows={1} value={chatDraft.startsWith('{"type":"gif"') ? "GIF ready to send" : chatDraft} onChange={(event) => { setChatDraft(event.target.value); setMentionCursor(event.target.selectionStart ?? event.target.value.length); setMentionSelection(0); }} onSelect={(event) => setMentionCursor(event.currentTarget.selectionStart ?? event.currentTarget.value.length)} onKeyDown={(event) => { if (currentMentionSuggestions.length && !event.shiftKey) { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setMentionSelection((current) => (current + (event.key === "ArrowDown" ? 1 : currentMentionSuggestions.length - 1)) % currentMentionSuggestions.length); return; } if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); chooseMention(currentMentionSuggestions[mentionSelection % currentMentionSuggestions.length]!.username); return; } if (event.key === "Escape") { setMentionCursor(-1); return; } } if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} onPaste={(event) => { const file = [...event.clipboardData.files].find((item) => item.type.startsWith("image/")); if (file) { event.preventDefault(); void pastedImageDataUrl(file).then(setPendingImage).catch((error: unknown) => setMessage(error instanceof Error ? error.message : "Image could not be pasted.")); } }} disabled={!selectedTextChannel || chatBusy} placeholder={selectedTextChannel ? `Message #${selectedTextChannel.name}` : "Select a text channel first"} aria-label="Message" aria-autocomplete="list" />
                  {currentMentionQuery && currentMentionSuggestions.length > 0 && <div className="mention-suggestions" role="listbox" aria-label="Mention a member">{currentMentionSuggestions.map((member, index) => <button type="button" role="option" aria-selected={index === mentionSelection % currentMentionSuggestions.length} className={index === mentionSelection % currentMentionSuggestions.length ? "selected" : ""} key={member.id} onMouseDown={(event) => event.preventDefault()} onClick={() => chooseMention(member.username)}><Avatar name={member.displayName} avatar={memberAvatar(memberById.get(member.id) ?? (member.id === user.id ? user : undefined))} size="small" /><span><strong>{member.displayName}</strong><small>@{member.username}</small></span></button>)}</div>}
                  {emojiPickerOpen && <div className="emoji-picker" role="listbox" aria-label="Emoji and community emotes">{commonEmojis.map((emoji) => <button type="button" key={emoji} title={emoji} onClick={() => insertEmoji(emoji)}>{emoji}</button>)}{emotes.map((emote) => <button type="button" className="custom-emote-option" key={emote.id} title={`:${emote.name}:`} onClick={() => insertCustomEmote(emote)}><CustomEmoteImage emote={emote} /></button>)}</div>}
                  {giphyOpen && <div className="giphy-picker"><div className="giphy-search"><input value={giphyQuery} onChange={(event) => setGiphyQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void searchGiphy(); } }} placeholder="Search Giphy" /><button type="button" onClick={() => void searchGiphy()}>Search</button></div><div className="giphy-results">{giphyResults.map((gif) => <button type="button" key={gif.id} title={gif.title} onClick={() => void selectGiphy(gif)}><img src={gif.previewUrl ?? gif.url} alt={gif.title} loading="lazy" decoding="async" /></button>)}</div></div>}
                </div>
                <button type="button" className="emoji-button" onClick={() => { const opening = !emojiPickerOpen; setEmojiPickerOpen(opening); if (opening) void refreshCommunityEmotes(); }} disabled={!selectedTextChannel}>☺</button>
                <button type="button" className="emoji-button" onClick={() => setGiphyOpen((open) => !open)} disabled={!selectedTextChannel}>GIF</button>
                <button className="composer-file-button" type="button" title="Upload attachment" aria-label="Upload attachment" disabled={!selectedTextChannel || chatBusy} onClick={() => void chooseAttachment()}>＋</button>
                <button disabled={!selectedTextChannel || (!chatDraft.trim() && !pendingImage && !pendingAttachment) || chatBusy} type="submit">{chatBusy ? "…" : "Send"}</button>
              </form>
              {messageMenu && <div className="message-context-menu" style={{ left: messageMenu.x, top: messageMenu.y }} onClick={(event) => event.stopPropagation()}>{messageMenu.message.authorId === user.id && <button type="button" onClick={() => { setEditingMessageId(messageMenu.message.id); setEditingDraft(messageMenu.message.content ?? ""); setMessageMenu(null); }}>Edit message</button>}<button type="button" onClick={() => { void deleteChatMessage(messageMenu.message.id); setMessageMenu(null); }}>Delete message</button></div>}
            </>}
          </section>
          <aside className="members-panel">
            <div className="panel-heading"><span>ONLINE</span><span className="channel-count">{onlineMembers.length + 1}</span></div>
            <div className="member-list">
              <div className="member-row"><Avatar name={user.displayName} avatar={memberAvatar(user)} /><div><strong>{user.displayName}</strong><small><span className={`status-dot status-${user.status}`} />{user.status} · @{user.username}</small></div></div>
              {onlineMembers.map((member) => <div className="member-row" key={member.id}><Avatar name={member.displayName} avatar={memberAvatar(member)} /><div><strong>{member.displayName}</strong><small><span className={`status-dot status-${member.status}`} />{member.status} · {voiceParticipantIds.has(member.id) ? "In voice" : "Online"}</small></div></div>)}
            </div>
            <div className="panel-heading member-section-heading"><span>OFFLINE</span><span className="channel-count">{offlineMembers.length}</span></div>
            <div className="member-list offline-members">{offlineMembers.map((member) => <div className="member-row" key={member.id}><Avatar name={member.displayName} avatar={memberAvatar(member)} offline /><div><strong>{member.displayName}</strong><small>Offline · @{member.username}</small></div></div>)}</div>
            {(hasPermission("invites.manage") || user.role === "admin") && <div className="admin-panel"><div className="panel-heading"><span>USER ACCESS</span></div><p>Invite someone to create a member account.</p><button type="button" onClick={() => void createInvite()} disabled={inviteBusy}>{inviteBusy ? "Creating…" : "Create invite"}</button>{inviteToken && <textarea readOnly value={inviteToken} aria-label="Invitation token" onFocus={(event) => event.currentTarget.select()} />}</div>}
          </aside>
        </div>
        {voiceParticipantMenu && (() => {
          const participant = voiceState.participants.find((item) => item.identity === voiceParticipantMenu.identity);
          if (!participant) return null;
          return <div className="voice-participant-menu" style={{ left: voiceParticipantMenu.x, top: voiceParticipantMenu.y }} onClick={(event) => event.stopPropagation()}>
            <strong>{participant.name}</strong>
            <label>Volume <span>{Math.round(participant.volume * 100)}%</span><input type="range" min="0" max="1" step="0.01" value={participant.volume} aria-label={`Volume for ${participant.name}`} onChange={(event) => voice.setParticipantVolume(participant.identity, Number(event.target.value))} /></label>
            {canMuteVoice && <button type="button" onClick={() => { void moderateVoice("mute", participant.identity); setVoiceParticipantMenu(null); }}>Force mute</button>}
            {canDisconnectVoice && <button type="button" onClick={() => { void moderateVoice("disconnect", participant.identity); setVoiceParticipantMenu(null); }}>Disconnect from voice</button>}
            {canMoveVoice && <label>Move to channel<select value="" onChange={(event) => { if (event.target.value) void moderateVoice("move", participant.identity, event.target.value); setVoiceParticipantMenu(null); }}><option value="">Choose…</option>{voiceChannels.filter((item) => item.id !== voiceParticipantMenu.channelId).map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>}
          </div>;
        })()}
        {channelMenu && canManageChannels && <div className="channel-context-menu" style={{ left: channelMenu.x, top: channelMenu.y }} onClick={(event) => event.stopPropagation()}>
          <strong>{channelMenu.channel.type === "text" ? "#" : "◖"} {channelMenu.channel.name}</strong>
          <button type="button" onClick={() => { const channel = channelMenu.channel; setChannelMenu(null); void renameChannel(channel); }}>Rename channel</button>
          <button type="button" className="danger" onClick={() => { const channel = channelMenu.channel; setChannelMenu(null); void deleteChannel(channel); }}>Delete channel</button>
        </div>}
        {screenViewerOpen && <div className={`screen-viewer-overlay ${screenViewerFullscreen ? "fullscreen" : ""}`} role="dialog" aria-modal="true" aria-label="Stream viewer"><header><div><p className="eyebrow">LIVE STREAMS</p><h2>Stream viewer</h2></div><div className="screen-viewer-actions">{(streamAudioBlocked || voiceState.audioPlaybackBlocked) && <button type="button" onClick={() => void enableStreamAudio()}>Enable stream audio</button>}<button type="button" onClick={() => void toggleScreenViewerFullscreen()}>Full screen</button><button type="button" className="secondary" onClick={() => void closeScreenViewer()}>Close</button></div></header><div className="screen-viewer-layout"><nav>{voiceState.screenShares.map((share) => <button type="button" className={selectedScreenShareId === share.identity ? "selected" : ""} key={share.identity} onClick={() => { setSelectedScreenShareId(share.identity); setStreamAudioBlocked(false); }}>{share.name}'s screen</button>)}</nav><div className="screen-viewer-stage">{voiceState.screenShares.filter((share) => share.identity === selectedScreenShareId).map((share) => <ScreenShareTile share={share} selected audioEnabled={share.identity !== user.id} onAudioBlocked={() => setStreamAudioBlocked(true)} onVolumeChange={(identity, volume) => voice.setScreenShareVolume(identity, volume)} key={share.identity} />)}{!selectedScreenShareId && <p>Select a stream to view.</p>}</div></div>{screenViewerFullscreen && <button type="button" className="screen-viewer-exit-fullscreen" onClick={() => void toggleScreenViewerFullscreen()} aria-label="Exit full screen">Exit full screen</button>}</div>}
        {settingsOpen && <div className="settings-overlay" role="dialog" aria-modal="true" aria-label="FreeCord settings"><section className="settings-panel"><div className="settings-header"><div><p className="eyebrow">FREECORD SETTINGS</p><h2>Settings</h2></div><button className="secondary" type="button" onClick={() => setSettingsOpen(false)}>Close</button></div><div className="settings-layout"><nav className="settings-tabs" aria-label="Settings sections"><button type="button" className={settingsTab === "profile" ? "active" : ""} onClick={() => setSettingsTab("profile")}><strong>Profile</strong><small>Identity and account</small></button><button type="button" className={settingsTab === "audio" ? "active" : ""} onClick={() => setSettingsTab("audio")}><strong>Voice &amp; Audio</strong><small>Devices and sensitivity</small></button>{canAccessAdmin && <button type="button" className={settingsTab === "admin" ? "active" : ""} onClick={() => setSettingsTab("admin")}><strong>Admin</strong><small>Members, roles, channels</small></button>}{canViewAudit && <button type="button" className={settingsTab === "audit" ? "active" : ""} onClick={() => setSettingsTab("audit")}><strong>Audit log</strong><small>Administrative activity</small></button>}<button type="button" className="settings-support-link" onClick={() => void window.freecord.openSupportPage()}><strong>☕ Buy me a coffee</strong><small>Support FreeCord</small></button></nav><div className="settings-scroll">
          {settingsTab === "profile" && <><div className="settings-section"><h3>Profile</h3><form className="profile-name-form" onSubmit={(event) => void saveProfile(event)}><label>Display name<input value={profileDisplayName} onChange={(event) => setProfileDisplayName(event.target.value)} maxLength={100} autoComplete="name" /></label><button type="submit" disabled={profileBusy || !profileDisplayName.trim() || profileDisplayName.trim() === user.displayName}>Save display name</button></form><div className="profile-avatar-settings"><Avatar name={user.displayName} avatar={memberAvatar(user)} /><label className="upload-button">Upload profile picture<input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadAvatar(file); event.currentTarget.value = ""; }} /></label>{memberAvatar(user) && <button type="button" className="secondary" onClick={() => void window.freecord.removeMyAvatar().then((result) => { if ("userId" in result) { setAuth((current) => current.user ? { ...current, user: { ...current.user, avatar: undefined } } : current); setMembers((current) => current.map((member) => member.id === user.id ? { ...member, avatar: undefined } : member)); setMessage("Profile picture removed."); } else setMessage(result.message); })}>Remove</button>}</div><label>Status<select value={user.status} onChange={(event) => void changeStatus(event.target.value as "active" | "busy" | "away")}><option value="active">Active</option><option value="busy">Busy</option><option value="away">Away</option></select></label><div className="assigned-roles"><span>Assigned roles</span><div>{assignedRoles.length ? assignedRoles.map((role) => <span className="role-chip" key={role.id}>{role.name}</span>) : <span className="role-chip">{user.role}</span>}</div></div></div><div className="settings-section"><h3>Change password</h3><form className="password-form" onSubmit={(event) => void changeProfilePassword(event)}><label>Current password<input type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} autoComplete="current-password" /></label><label>New password<input type="password" value={newProfilePassword} onChange={(event) => setNewProfilePassword(event.target.value)} minLength={12} autoComplete="new-password" /></label><label>Confirm new password<input type="password" value={confirmProfilePassword} onChange={(event) => setConfirmProfilePassword(event.target.value)} minLength={12} autoComplete="new-password" /></label><button type="submit" disabled={profileBusy || !currentPassword || newProfilePassword.length < 12 || !confirmProfilePassword}>Change password</button></form><p className="hint">Changing your password signs out your other FreeCord sessions.</p></div></>}
          {settingsTab === "audio" && <>
            <div className="settings-section">
              <h3>Voice &amp; Audio</h3>
              <label>Microphone<select value={audioSettings.microphoneId} onChange={(event) => void saveAudioPreferences({ ...audioSettings, microphoneId: event.target.value })}><option value="">System default</option>{voiceState.microphoneDevices.map((device) => <option value={device.deviceId} key={device.deviceId}>{device.label}</option>)}</select></label>
              <label>Speaker<select value={audioSettings.outputId} onChange={(event) => void saveAudioPreferences({ ...audioSettings, outputId: event.target.value })}><option value="">System default</option>{voiceState.outputDevices.map((device) => <option value={device.deviceId} key={device.deviceId}>{device.label}</option>)}</select></label>
              <div className="settings-info"><strong>Linux PipeWire stream audio</strong><p className="hint">FreeCord automatically captures applications playing through the default speaker while excluding FreeCord voice. No KDE audio routing changes are needed.</p></div>
              <label>Input sensitivity<input type="range" min="0" max="1" step="0.01" value={audioSettings.inputSensitivity} onChange={(event) => void saveAudioPreferences({ ...audioSettings, inputSensitivity: Number(event.target.value) })} /></label>
              <p className="hint">Device IDs are stored locally and automatically fall back to the system default if a device is disconnected.</p>
            </div>
            <div className="settings-section audio-processing-settings">
              <div className="settings-title-row"><div><h3>Microphone processing</h3><p className="hint">Processing runs locally before microphone audio is sent to LiveKit.</p></div>{audioSettings.rnnoiseEnabled && <span className={`audio-processing-status ${voiceState.rnnoiseActive ? "active" : ""}`}>{voiceState.audioProcessingBusy ? "Starting…" : voiceState.rnnoiseActive ? "RNNoise active" : voiceState.status === "connected" ? "Unavailable" : "Applies on join"}</span>}</div>
              <label className="settings-toggle"><input type="checkbox" checked={audioSettings.rnnoiseEnabled} onChange={(event) => void saveAudioPreferences({ ...audioSettings, rnnoiseEnabled: event.target.checked })} /><span><strong>RNNoise suppression</strong><small>AI-based background-noise removal optimized for speech. Uses extra CPU.</small></span></label>
              <label className="settings-toggle"><input type="checkbox" checked={audioSettings.echoCancellation} onChange={(event) => void saveAudioPreferences({ ...audioSettings, echoCancellation: event.target.checked })} /><span><strong>Echo cancellation</strong><small>Reduces speaker audio feeding back into your microphone.</small></span></label>
              <label className="settings-toggle"><input type="checkbox" checked={audioSettings.automaticGainControl} onChange={(event) => void saveAudioPreferences({ ...audioSettings, automaticGainControl: event.target.checked })} /><span><strong>Automatic gain control</strong><small>Automatically balances microphone loudness.</small></span></label>
              <label className={`settings-toggle ${audioSettings.rnnoiseEnabled ? "disabled" : ""}`}><input type="checkbox" checked={audioSettings.nativeNoiseSuppression} disabled={audioSettings.rnnoiseEnabled} onChange={(event) => void saveAudioPreferences({ ...audioSettings, nativeNoiseSuppression: event.target.checked })} /><span><strong>Built-in noise suppression</strong><small>{audioSettings.rnnoiseEnabled ? "Disabled while RNNoise is enabled to prevent double processing." : "Uses Chromium's lighter built-in suppressor."}</small></span></label>
              {voiceState.audioProcessingError && <p className="settings-error">RNNoise could not start: {voiceState.audioProcessingError}</p>}
            </div>
          </>}
          {settingsTab === "admin" && canAccessAdmin && (canCreateTextChannels || canCreateVoiceChannels || canManageChannels) && <div className="settings-section"><h3>Channels</h3>{(canCreateTextChannels || canCreateVoiceChannels) && <form className="channel-create-form" onSubmit={(event) => void createChannel(event, !canCreateTextChannels && canCreateVoiceChannels ? "voice" : undefined)}><input value={newChannelName} onChange={(event) => setNewChannelName(event.target.value)} placeholder="Channel name" maxLength={64} /><select value={!canCreateTextChannels && canCreateVoiceChannels ? "voice" : newChannelType} onChange={(event) => setNewChannelType(event.target.value as "text" | "voice")}>
            {canCreateTextChannels && <option value="text">Text channel</option>}{canCreateVoiceChannels && <option value="voice">Voice channel</option>}
          </select><button type="submit" disabled={!newChannelName.trim()}>Create channel</button></form>}{canManageChannels && <p className="hint">Right-click a text or voice channel in the channel list to rename or delete it.</p>}</div>}
          {settingsTab === "admin" && canAccessAdmin && canManageMemberAccounts && <div className="settings-section member-account-settings"><div className="settings-title-row"><div><h3>Member accounts</h3><p className="hint">Recover an account, clear persistent voice restrictions, or deactivate it without removing message and audit history.</p></div></div><div className="member-account-list">{members.filter((member) => member.id !== user.id && !member.isOwner && (user.role === "owner" || member.role !== "admin")).map((member) => <div key={member.id}><span><strong>{member.displayName}</strong><small>@{member.username} · {member.online ? "online" : "offline"}</small></span><button type="button" className="secondary" onClick={() => { setManagedMember(member); setMemberResetPassword(""); setMemberResetPasswordConfirm(""); setMemberDeactivateConfirm(""); }}>Manage</button></div>)}</div>{managedMember && <div className="member-account-card"><div className="settings-title-row"><div><h4>Manage {managedMember.displayName}</h4><p className="hint">@{managedMember.username}</p></div><button type="button" className="secondary" onClick={closeMemberAdministration} disabled={memberAdminBusy}>Close</button></div>{hasPermission("members.password.reset") && <form className="member-reset-form" onSubmit={(event) => void resetManagedMemberPassword(event)}><h5>Reset password</h5><p className="hint">Sets a temporary password and immediately signs out every existing session. Ask the member to change it after signing in. This does not restore an encryption key held only on another device.</p><label>Temporary password<input type="password" value={memberResetPassword} onChange={(event) => setMemberResetPassword(event.target.value)} minLength={12} maxLength={1024} autoComplete="new-password" /></label><label>Confirm temporary password<input type="password" value={memberResetPasswordConfirm} onChange={(event) => setMemberResetPasswordConfirm(event.target.value)} minLength={12} maxLength={1024} autoComplete="new-password" /></label><button type="submit" disabled={memberAdminBusy || memberResetPassword.length < 12 || memberResetPassword !== memberResetPasswordConfirm}>Reset password and sign out</button></form>}{hasPermission("voice.restrictions.manage") && <div className="member-account-action"><div><h5>Voice restrictions</h5><p className="hint">Clears persistent server mutes for this account. This is server state, not a desktop cache. The member must leave and rejoin voice.</p></div><button type="button" className="secondary" onClick={() => void clearManagedMemberVoiceRestrictions()} disabled={memberAdminBusy}>Clear voice restrictions</button></div>}{hasPermission("members.deactivate") && <div className="member-account-danger"><h5>Deactivate account</h5><p className="hint">Revokes every session, disables sign-in, releases the username, and removes profile data and roles. Messages and audit records remain as “Deleted User”.</p><label>Type <strong>{managedMember.username}</strong> to confirm<input value={memberDeactivateConfirm} onChange={(event) => setMemberDeactivateConfirm(event.target.value)} autoComplete="off" /></label><button type="button" className="danger-button" onClick={() => void deactivateManagedMember()} disabled={memberAdminBusy || memberDeactivateConfirm !== managedMember.username}>Deactivate account</button></div>}</div>}</div>}
          {settingsTab === "admin" && canAccessAdmin && (hasPermission("roles.view") || hasPermission("roles.manage") || hasPermission("roles.assign")) && <div className="settings-section role-settings"><h3>Members and roles</h3><div className="member-role-list">{members.map((member) => { const memberRoles = (member as CommunityMember & ExtendedPrincipal).roles ?? []; return <div key={member.id}><span><strong>{member.displayName}</strong><small>@{member.username}</small></span><div>{memberRoles.length ? memberRoles.map((role) => <span className="role-chip" key={role.id}>{role.name}</span>) : <span className="role-chip">{member.role}</span>}</div></div>; })}</div>
            {hasPermission("roles.manage") && <><form onSubmit={(event) => void createRole(event)}><input value={newRoleName} onChange={(event) => setNewRoleName(event.target.value)} maxLength={48} placeholder="Role name" /><div className="permission-grid">{availablePermissions.map((permission) => <label key={permission}><input type="checkbox" checked={newRolePermissions.includes(permission)} onChange={() => togglePermission(permission, newRolePermissions, setNewRolePermissions)} />{permission}</label>)}</div><button type="submit" disabled={!newRoleName.trim()}>Create role</button></form>{roles.filter((role) => role.kind === "custom").map((role) => <details key={role.id}><summary>{role.name}</summary><div className="permission-grid">{availablePermissions.map((permission) => <label key={permission}><input type="checkbox" checked={(roleDraftPermissions[role.id] ?? role.permissions).includes(permission)} onChange={() => togglePermission(permission, roleDraftPermissions[role.id] ?? role.permissions, (next) => setRoleDraftPermissions((current) => ({ ...current, [role.id]: next })))} />{permission}</label>)}</div><button type="button" onClick={() => void saveRole(role)}>Save permissions</button></details>)}</>}
            {hasPermission("roles.assign") && <div className="role-assignment"><select value={assignmentMemberId} onChange={(event) => setAssignmentMemberId(event.target.value)}><option value="">Choose member</option>{members.filter((member) => member.id !== user.id).map((member) => <option value={member.id} key={member.id}>{member.displayName}</option>)}</select><select value={assignmentRoleId} onChange={(event) => setAssignmentRoleId(event.target.value)}><option value="">Choose role</option>{roles.filter((role) => role.kind === "custom").map((role) => <option value={role.id} key={role.id}>{role.name}</option>)}</select><button type="button" onClick={() => void changeRoleAssignment(false)}>Assign</button><button type="button" className="secondary" onClick={() => void changeRoleAssignment(true)}>Remove</button></div>}
          </div>}
          {settingsTab === "audit" && canViewAudit && <div className="settings-section audit-settings"><div className="settings-title-row"><div><h3>Audit log</h3><p className="hint">Security-relevant administrative activity. Message contents and secrets are never shown.</p></div><button type="button" className="secondary" onClick={() => void loadAuditLog(false)} disabled={auditBusy}>Refresh</button></div>{auditError && <p className="settings-error">{auditError}</p>}<div className="audit-event-list">{auditEvents.map((event) => <article key={event.id}><div><strong>{event.action.replaceAll(".", " ")}</strong><time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString()}</time></div><p>{event.actorDisplayName ? `${event.actorDisplayName} · ` : ""}{event.targetType ? `${event.targetType}${event.targetId ? ` ${event.targetId.slice(0, 8)}` : ""}` : "Community"}</p>{Object.keys(event.metadata).length > 0 && <code>{JSON.stringify(event.metadata)}</code>}</article>)}</div>{auditEvents.length === 0 && !auditBusy && !auditError && <p className="hint">No audit events are available.</p>}{auditCursor && <button type="button" className="secondary" onClick={() => void loadAuditLog(true)} disabled={auditBusy}>{auditBusy ? "Loading…" : "Load older events"}</button>}</div>}
          {settingsTab === "profile" && <>
          {(hasPermission("emotes.manage") || hasPermission("emotes.create")) && <div className="settings-section"><h3>Community emotes</h3>{hasPermission("emotes.create") && <div className="emote-upload"><input value={emoteName} onChange={(event) => setEmoteName(event.target.value)} placeholder="emote_name" maxLength={32} /><label className="upload-button">Upload emote<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadEmote(file); event.currentTarget.value = ""; }} /></label></div>}<div className="emote-admin-grid">{emotes.map((emote) => <div key={emote.id}><CustomEmoteImage emote={emote} /><span>:{emote.name}:</span>{hasPermission("emotes.manage") && <button type="button" className="secondary" onClick={() => void window.freecord.deleteCommunityEmote(emote.id).then((result) => { if ("ok" in result && result.ok) setEmotes((current) => current.filter((item) => item.id !== emote.id)); else setMessage(resultMessage(result) ?? "Emote could not be removed."); })}>×</button>}</div>)}</div></div>}
          </>}
        </div></div></section></div>}
        {message && <div className="workspace-toast" role="status" aria-live="polite"><span>{message}</span><button type="button" aria-label="Dismiss notification" onClick={() => setMessage("")}>×</button></div>}
        <footer className="workspace-footer"><span className={voiceState.status === "connected" ? "voice-footer connected" : "voice-footer"}>{voiceState.status === "connected" ? `Connected to ${voiceChannels.find((channel) => channel.id === voiceState.channelId)?.name ?? "voice"}` : "Not connected to voice"}</span><span>{runtime}</span></footer>
      </main>
    );
  }

  return (
    <main className="onboarding">
      <section className="onboarding-card" aria-labelledby="welcome-title">
        <div className="logo" aria-hidden="true">F</div>
        <p className="eyebrow">SECURE DESKTOP</p>
        <h1 id="welcome-title">Welcome to FreeCord</h1>
        <p className="intro">Connect this desktop app to your self-hosted FreeCord server.</p>
        {!settings?.serverOrigin ? <form onSubmit={(event) => void saveServer(event)}>
          <label htmlFor="server-origin">Server address</label>
          <input
            id="server-origin"
            type="url"
            value={serverOrigin}
            onChange={(event) => setServerOrigin(event.target.value)}
            placeholder="https://api.example.com"
            autoComplete="url"
            required
          />
          <p className="hint">Use the server origin only. HTTPS is required outside local development.</p>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={allowInsecureLocalhost}
              onChange={(event) => setAllowInsecureLocalhost(event.target.checked)}
            />
            <span>Allow HTTP for localhost development</span>
          </label>
          <button type="submit" disabled={saving || !serverOrigin.trim()}>
            {saving ? "Saving…" : "Save server"}
          </button>
        </form> : <section className="auth-screen">
          <div className="server-summary"><span>Server</span><strong>{serverOrigin.replace(/^https?:\/\//, "")}</strong><button className="secondary" type="button" onClick={() => { setServerOrigin(""); setSettings(null); }}>Change</button></div>
          <form className="auth-form" onSubmit={(event) => void (authMode === "signin" ? login(event) : register(event))}>
            <div className="section-rule" />
            <div className="auth-mode-tabs"><button className={authMode === "signin" ? "active" : "secondary"} type="button" onClick={() => setAuthMode("signin")}>Sign in</button><button className={authMode === "register" ? "active" : "secondary"} type="button" onClick={() => setAuthMode("register")}>Use invite</button></div>
            <h2>{authMode === "signin" ? "Sign in" : "Create account"}</h2>
            {authMode === "register" && <><label htmlFor="invite-token">Invitation token</label><input id="invite-token" type="text" value={inviteInput} onChange={(event) => setInviteInput(event.target.value)} autoComplete="off" required /><label htmlFor="display-name">Display name</label><input id="display-name" type="text" value={displayName} onChange={(event) => setDisplayName(event.target.value)} autoComplete="name" required /></>}
            <label htmlFor="username">Username</label>
            <input id="username" type="text" value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" required />
            <label htmlFor="password">Password</label>
            <input id="password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required />
            {authMode === "register" && <><label htmlFor="confirm-password">Confirm password</label><input id="confirm-password" type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} autoComplete="new-password" required /></>}
            <button type="submit" disabled={authBusy}>{authBusy ? "Working…" : authMode === "signin" ? "Sign in" : "Create account"}</button>
            <p className="hint">{authMode === "signin" ? "New accounts are invite-only. Ask an owner or administrator for an invitation." : "Paste the complete one-time invitation. Usernames require 3–64 supported characters and passwords require at least 12 characters."}</p>
          </form>
        </section>}
        <p className="status" role="status" aria-live="polite">{message ?? (auth.status === "authenticated" ? "Your session is ready." : "Credentials are protected by the operating system.")}</p>
        <small>{runtime}</small>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
