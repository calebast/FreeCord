import { app, BrowserWindow, desktopCapturer, dialog, ipcMain as rawIpcMain, protocol, safeStorage, session, shell, WebContentsView } from "electron";
import { chmod, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import type {
  RuntimeInfo,
  ServerSettings,
  ServerSettingsInput,
  AudioSettings,
  LinuxScreenAudioResult,
  SettingsError,
  SettingsResult,
  AuthError,
  AuthResult,
  AuthSession,
  AuthenticatedUser,
  LoginInput,
  RegisterInput,
  ChannelsResponse,
  ChannelMetadata,
  GiphyResult,
  CommunityMembersResponse,
  InviteResponse,
  ChatMessage,
  MessagesResponse,
  SessionState,
  VoiceTokenResponse,
  CommunityEmote,
  CommunityPermissionsResponse,
  CommunityRole,
  CommunityRolesResponse,
  CreateRoleInput,
  FilesSurfaceRect,
  FilesSurfaceState,
  MediaAssetReference,
  MediaImageData,
  MediaSelectionCanceled,
  ReactionTarget,
  UpdateRoleInput,
  UserProfile,
  BinaryMediaUploadInput,
  UpdateProfileInput,
  ChangePasswordInput,
  AuditLogResponse,
  RealtimeEvent,
  SharedFilesResponse,
} from "../shared/bridge";

// Electron 43 can select Vulkan on KDE Plasma Wayland even though Chromium's
// Wayland surface factory does not support that combination. Keep the normal
// Wayland/EGL path but disable Vulkan to avoid GPU-process crashes on CachyOS.
if (process.platform === "linux") {
  // Prefer stability over GPU acceleration on the supported KDE Plasma
  // Wayland target. Some CachyOS graphics stacks still crash the Electron GPU
  // process during WebRTC startup even with Vulkan disabled.
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("disable-vulkan");
  app.commandLine.appendSwitch("use-gl", "egl");
}

const devServerUrl = process.env.VITE_DEV_SERVER_URL;
const mediaScheme = "freecord-media";
const defaultFilesOrigin = "https://files.invalid";
const supportUrl = "https://buymeacoffee.com/calebast";

protocol.registerSchemesAsPrivileged([{ scheme: mediaScheme, privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true } }]);

let mainWindow: BrowserWindow | null = null;
let filesView: WebContentsView | null = null;
let filesSurfaceVisible = false;
let filesSurfaceGeneration = 0;
const linuxScreenAudioSourceName = "vencord-screen-share";
interface LinuxAudioPatchBay {
  link(input: {
    include: Array<Record<string, string>>;
    exclude: Array<Record<string, string>>;
    ignore_devices: boolean;
    only_speakers: boolean;
    only_default_speakers: boolean;
    mute: boolean;
    workaround: Array<Record<string, string>>;
  }): boolean;
  unlink(): void;
  unmute(): void;
}
interface LinuxAudioPatchBayConstructor {
  new(): LinuxAudioPatchBay;
  hasPipeWire(): boolean;
}
let linuxAudioPatchBay: LinuxAudioPatchBay | null = null;
let linuxScreenAudioLinked = false;

const appRoot = path.resolve(__dirname, "../..");
const rendererRoot = path.join(appRoot, "dist");
const rendererEntry = path.join(rendererRoot, "index.html");
const preloadPath = path.join(appRoot, "dist-main", "preload", "preload.js");
const settingsVersion = 1 as const;
const credentialsFileName = "auth-refresh-token.bin";
const chatKeyFileName = "chat-key.bin";
const audioSettingsFileName = "audio-settings.json";

interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
  user: AuthenticatedUser;
  session: AuthSession;
}

interface SessionResponse {
  user: AuthenticatedUser;
  session: AuthSession;
}

let accessToken: string | null = null;
let refreshToken: string | null = null;
let refreshInFlight: Promise<AuthResult | AuthError> | null = null;
let authenticationGeneration = 0;
let credentialMutation: Promise<void> = Promise.resolve();
let nativeMediaSelectionInFlight = false;
let signOutInProgress = false;
let currentState: SessionState = { status: "signed-out", user: null, session: null };
let realtimeAbort: AbortController | null = null;
let realtimeGeneration = 0;
let lastRealtimeEventId: string | null = null;

interface PersistedSettings {
  version: 1;
  serverOrigin: string | null;
  allowInsecureLocalhost: boolean;
}

const defaultSettings: ServerSettings = {
  version: settingsVersion,
  serverOrigin: null,
  allowInsecureLocalhost: false,
};

function settingsPath(): string {
  return path.join(app.getPath("userData"), "settings.json");
}

function credentialsPath(): string {
  return path.join(app.getPath("userData"), credentialsFileName);
}

function chatKeyPath(): string {
  return path.join(app.getPath("userData"), chatKeyFileName);
}

function audioSettingsPath(): string { return path.join(app.getPath("userData"), audioSettingsFileName); }

const defaultAudioSettings: AudioSettings = {
  microphoneId: "",
  outputId: "",
  inputSensitivity: 0.5,
  rnnoiseEnabled: false,
  echoCancellation: true,
  automaticGainControl: true,
  nativeNoiseSuppression: true,
};

async function loadAudioSettings(): Promise<AudioSettings> {
  try {
    const value = JSON.parse(await readFile(audioSettingsPath(), "utf8")) as Partial<AudioSettings>;
    return {
      microphoneId: typeof value.microphoneId === "string" ? value.microphoneId.slice(0, 512) : "",
      outputId: typeof value.outputId === "string" ? value.outputId.slice(0, 512) : "",
      inputSensitivity: typeof value.inputSensitivity === "number" && Number.isFinite(value.inputSensitivity) ? Math.max(0, Math.min(1, value.inputSensitivity)) : 0.5,
      rnnoiseEnabled: value.rnnoiseEnabled === true,
      echoCancellation: value.echoCancellation !== false,
      automaticGainControl: value.automaticGainControl !== false,
      nativeNoiseSuppression: value.nativeNoiseSuppression !== false,
    };
  } catch { return defaultAudioSettings; }
}

async function saveAudioSettings(settings: AudioSettings): Promise<AudioSettings> {
  const normalized: AudioSettings = {
    microphoneId: typeof settings.microphoneId === "string" ? settings.microphoneId.slice(0, 512) : "",
    outputId: typeof settings.outputId === "string" ? settings.outputId.slice(0, 512) : "",
    inputSensitivity: typeof settings.inputSensitivity === "number" && Number.isFinite(settings.inputSensitivity) ? Math.max(0, Math.min(1, settings.inputSensitivity)) : 0.5,
    rnnoiseEnabled: settings.rnnoiseEnabled === true,
    echoCancellation: settings.echoCancellation !== false,
    automaticGainControl: settings.automaticGainControl !== false,
    nativeNoiseSuppression: settings.nativeNoiseSuppression !== false,
  };
  await mkdir(path.dirname(audioSettingsPath()), { recursive: true });
  await writeFile(audioSettingsPath(), `${JSON.stringify(normalized)}\n`, { encoding: "utf8", mode: 0o600 });
  return normalized;
}

function loadLinuxAudioPatchBay(): LinuxAudioPatchBay {
  if (linuxAudioPatchBay) return linuxAudioPatchBay;
  const addon = app.isPackaged
    ? require(path.join(process.resourcesPath, "venmic.node")) as { PatchBay?: LinuxAudioPatchBayConstructor }
    : require("@vencord/venmic") as { PatchBay?: LinuxAudioPatchBayConstructor };
  if (!addon.PatchBay) throw new Error("The automatic PipeWire audio module is unavailable.");
  if (!addon.PatchBay.hasPipeWire()) throw new Error("pipewire-pulse is not the active audio server.");
  linuxAudioPatchBay = new addon.PatchBay();
  return linuxAudioPatchBay;
}

function freeCordAudioServicePid(): string | null {
  const metric = app.getAppMetrics().find((entry) => entry.name === "Audio Service");
  return metric && Number.isSafeInteger(metric.pid) ? String(metric.pid) : null;
}

async function ensureLinuxScreenAudio(): Promise<LinuxScreenAudioResult> {
  if (process.platform !== "linux") return { ok: false, message: "Automatic PipeWire stream audio is only used on Linux." };
  try {
    const audioServicePid = freeCordAudioServicePid();
    if (!audioServicePid) throw new Error("FreeCord's audio service could not be identified safely.");
    const patchBay = loadLinuxAudioPatchBay();
    patchBay.unlink();
    const linked = patchBay.link({
      // Match playback streams directly instead of requiring a direct link to
      // the default hardware sink. WirePlumber may route applications through
      // virtual/effects nodes, which made the speaker-topology filter silently
      // produce an empty stream on otherwise valid PipeWire installations.
      include: [
        { "media.class": "Stream/Output/Audio" },
      ],
      exclude: [
        // The PID is the primary boundary. The application-name rule keeps
        // FreeCord voice excluded if a PipeWire client omits that PID.
        { "application.process.id": audioServicePid },
        { "application.name": app.getName() },
        { "media.class": "Stream/Input/Audio" },
      ],
      ignore_devices: true,
      only_speakers: false,
      only_default_speakers: false,
      mute: true,
      // Chromium may leave its RecordStream node attached to the microphone
      // even when getUserMedia requests venmic's exact virtual device ID.
      // Venmic redirects only that FreeCord recording node to the stream mix.
      workaround: [
        { "application.process.id": audioServicePid, "media.name": "RecordStream" },
      ],
    });
    if (!linked) throw new Error("PipeWire could not create the automatic application-audio source.");
    linuxScreenAudioLinked = true;
    return { ok: true, outputName: linuxScreenAudioSourceName };
  } catch (error: unknown) {
    console.error("FreeCord could not prepare automatic Linux stream audio", error);
    await releaseLinuxScreenAudio();
    return { ok: false, message: "Automatic application audio could not start. Confirm PipeWire and pipewire-pulse are active, then restart FreeCord." };
  }
}

async function releaseLinuxScreenAudio(): Promise<void> {
  linuxScreenAudioLinked = false;
  try { linuxAudioPatchBay?.unlink(); }
  catch (error: unknown) { console.error("FreeCord could not release automatic Linux stream audio", error); }
}

function unmuteLinuxScreenAudio(): void {
  if (!linuxScreenAudioLinked || !linuxAudioPatchBay) throw new Error("Automatic Linux stream audio is not active.");
  linuxAudioPatchBay.unmute();
}

async function loadOrCreateChatKey(): Promise<string> {
  if (!credentialStorageAvailable()) throw new Error("Secure chat-key storage is unavailable on this system.");
  try {
    const encrypted = await readFile(chatKeyPath());
    return safeStorage.decryptString(encrypted);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const key = randomBytes(32).toString("base64url");
    await mkdir(path.dirname(chatKeyPath()), { recursive: true });
    await writeFile(chatKeyPath(), safeStorage.encryptString(key), { mode: 0o600 });
    return key;
  }
}

function inviteParts(value: string): { serverToken: string; chatKey?: string } {
  const separator = value.lastIndexOf(".");
  const serverToken = separator > 0 ? value.slice(0, separator) : value;
  const chatKey = separator > 0 ? value.slice(separator + 1) : undefined;
  if (/^[A-Za-z0-9_-]{43}$/.test(serverToken) && chatKey && /^[A-Za-z0-9_-]{43}$/.test(chatKey)) {
    return { serverToken, chatKey };
  }
  return { serverToken: value };
}

async function stageRegistrationChatKey(chatKey: string): Promise<string> {
  if (!credentialStorageAvailable()) throw new Error("Secure credential storage is unavailable on this system.");
  const destination = chatKeyPath();
  const stagedPath = `${destination}.register-${randomBytes(12).toString("hex")}.tmp`;
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(stagedPath, safeStorage.encryptString(chatKey), { mode: 0o600, flag: "wx" });
  if (process.platform !== "win32") await chmod(stagedPath, 0o600);
  return stagedPath;
}

async function discardStagedRegistrationChatKey(stagedPath: string | null): Promise<void> {
  if (!stagedPath) return;
  try { await unlink(stagedPath); } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function authError(code: AuthError["code"], message: string): AuthError {
  return { ok: false, code, message };
}

function signedOut(): SessionState {
  stopRealtimeConnection();
  currentState = { status: "signed-out", user: null, session: null };
  accessToken = null;
  lastRealtimeEventId = null;
  void destroyFilesSurface();
  return currentState;
}

function credentialStorageAvailable(): boolean {
  return safeStorage.isEncryptionAvailable();
}

async function serializeCredentialMutation(work: () => Promise<void>): Promise<void> {
  const operation = credentialMutation.then(work, work);
  credentialMutation = operation.catch(() => undefined);
  await operation;
}

async function loadRefreshToken(): Promise<string | null> {
  if (refreshToken) return refreshToken;
  if (!credentialStorageAvailable()) return null;
  const generation = authenticationGeneration;
  let loaded: string | null = null;
  await serializeCredentialMutation(async () => {
    if (authenticationGeneration !== generation || refreshToken) {
      loaded = refreshToken;
      return;
    }
    try {
      const encrypted = await readFile(credentialsPath());
      const candidate = safeStorage.decryptString(encrypted);
      if (authenticationGeneration === generation) {
        refreshToken = candidate;
        loaded = candidate;
      }
    } catch { /* Missing or unreadable credentials mean signed out. */ }
  });
  return loaded;
}

async function saveRefreshToken(token: string, expectedGeneration = authenticationGeneration): Promise<boolean> {
  if (!credentialStorageAvailable()) throw new Error("Secure credential storage is unavailable on this system.");
  let saved = false;
  await serializeCredentialMutation(async () => {
    if (authenticationGeneration !== expectedGeneration) return;
    const directory = path.dirname(credentialsPath());
    await mkdir(directory, { recursive: true });
    const encrypted = safeStorage.encryptString(token);
    await writeFile(credentialsPath(), encrypted, { mode: 0o600 });
    if (process.platform !== "win32") await chmod(credentialsPath(), 0o600);
    if (authenticationGeneration !== expectedGeneration) return;
    refreshToken = token;
    saved = true;
  });
  return saved;
}

async function clearStoredCredentials(): Promise<void> {
  authenticationGeneration += 1;
  stopRealtimeConnection();
  accessToken = null;
  refreshToken = null;
  lastRealtimeEventId = null;
  currentState = { status: "signed-out", user: null, session: null };
  const credentialClear = serializeCredentialMutation(async () => {
    try { await unlink(credentialsPath()); } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  });
  await Promise.all([credentialClear, destroyFilesSurface()]);
}

async function configuredOrigin(): Promise<string> {
  const settings = await loadSettings();
  if (!settings.serverOrigin) throw new Error("Configure your FreeCord server first.");
  return settings.serverOrigin;
}

async function authContextStillCurrent(generation: number, origin: string): Promise<boolean> {
  if (authenticationGeneration !== generation) return false;
  try { return await configuredOrigin() === origin && authenticationGeneration === generation; }
  catch { return false; }
}

async function requestJson<T>(origin: string, endpoint: string, init: RequestInit = {}, timeoutMs = 15_000, allowAuthRetry = true, requestGeneration = authenticationGeneration): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  const unauthenticatedEndpoint = endpoint === "/v1/auth/login" || endpoint === "/v1/auth/register" || endpoint === "/v1/auth/refresh";
  if (unauthenticatedEndpoint) headers.delete("authorization");
  const requestAccessToken = unauthenticatedEndpoint ? null : accessToken;
  if (requestAccessToken) headers.set("authorization", `Bearer ${requestAccessToken}`);
  let response: Response;
  try {
    response = await fetch(`${origin}${endpoint}`, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error: unknown) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) throw new Error("The FreeCord server timed out while processing the request.");
    throw new Error("Unable to reach the FreeCord server.");
  }
  if (response.status === 401 && allowAuthRetry && requestAccessToken && !unauthenticatedEndpoint) {
    await response.body?.cancel().catch(() => undefined);
    if (!await authContextStillCurrent(requestGeneration, origin)) {
      const error = new Error("The request was superseded by a different FreeCord session.");
      error.name = "Unauthorized";
      throw error;
    }
    if (accessToken && accessToken !== requestAccessToken) return requestJson<T>(origin, endpoint, init, timeoutMs, false, requestGeneration);
    const refreshed = await refreshSession();
    if (refreshed.ok && refreshed.state.status === "authenticated" && accessToken && await authContextStillCurrent(requestGeneration, origin)) {
      return requestJson<T>(origin, endpoint, init, timeoutMs, false, requestGeneration);
    }
    if (!refreshed.ok) {
      const error = new Error(refreshed.message);
      error.name = refreshed.code === "AUTHENTICATION_FAILED" ? "Unauthorized" : "ServerError";
      throw error;
    }
  }
  if (!response.ok) {
    let message = "The FreeCord server rejected the request.";
    try {
      const body = await response.json() as { error?: { message?: string } };
      if (typeof body.error?.message === "string") message = body.error.message;
    } catch { /* Use the safe fallback message. */ }
    const error = new Error(message);
    error.name = response.status === 401 ? "Unauthorized" : "ServerError";
    throw error;
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function apiFailure(error: unknown, fallback: string): AuthError {
  return authError(
    error instanceof Error && error.name === "Unauthorized" ? "AUTHENTICATION_FAILED" : error instanceof Error && error.message.includes("Configure") ? "NO_SERVER_CONFIGURED" : "SERVER_UNAVAILABLE",
    error instanceof Error ? error.message : fallback,
  );
}

function validOpaqueId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
}

function parseReactionTarget(value: unknown): ReactionTarget | null {
  if (typeof value === "string" && value.trim() && value.length <= 32) return { kind: "unicode", value };
  if (!value || typeof value !== "object") return null;
  const target = value as Partial<ReactionTarget> & { value?: unknown; emoteId?: unknown };
  if (target.kind === "unicode" && typeof target.value === "string" && target.value.trim() && target.value.length <= 32) return { kind: "unicode", value: target.value };
  if (target.kind === "emote" && validOpaqueId(target.emoteId)) return { kind: "emote", emoteId: target.emoteId };
  return null;
}

function reactionRequestBody(target: ReactionTarget): { unicode: string } | { emoteId: string } {
  return target.kind === "unicode" ? { unicode: target.value } : { emoteId: target.emoteId };
}

function normalizeMediaReference(value: unknown): MediaAssetReference {
  if (!value || typeof value !== "object") throw new Error("The FreeCord server returned an invalid media reference.");
  const media = value as Record<string, unknown>;
  const assetId = typeof media.assetId === "string" ? media.assetId : typeof media.id === "string" ? media.id : "";
  if (!validOpaqueId(assetId)) throw new Error("The FreeCord server returned an invalid media reference.");
  return {
    assetId,
    ...(typeof media.id === "string" ? { id: media.id } : { id: assetId }),
    ...(typeof media.version === "string" ? { version: media.version } : {}),
    ...(typeof media.contentType === "string" ? { contentType: media.contentType, mimeType: media.contentType } : {}),
    ...(typeof media.byteSize === "number" ? { byteSize: media.byteSize, size: media.byteSize } : {}),
    ...(typeof media.width === "number" ? { width: media.width } : {}),
    ...(typeof media.height === "number" ? { height: media.height } : {}),
    ...(typeof media.durationMs === "number" ? { durationMs: media.durationMs } : {}),
  };
}

function normalizeCommunityEmote(value: unknown): CommunityEmote {
  if (!value || typeof value !== "object") throw new Error("The FreeCord server returned an invalid emote.");
  const emote = value as Record<string, unknown>;
  const asset = normalizeMediaReference(emote.asset ?? emote.media);
  if (!validOpaqueId(emote.id) || typeof emote.name !== "string") throw new Error("The FreeCord server returned an invalid emote.");
  return { id: emote.id, name: emote.name, animated: emote.animated === true, asset, media: asset };
}

function normalizeAuthenticatedUser(user: AuthenticatedUser): AuthenticatedUser {
  return { ...user, ...(user.avatar ? { avatar: normalizeMediaReference(user.avatar) } : {}) };
}

function normalizeChatMessage(message: ChatMessage): ChatMessage {
  return {
    ...message,
    ...(message.reactions ? { reactions: message.reactions.map((reaction) => ({
      ...reaction,
      ...(reaction.emote ? { emote: normalizeCommunityEmote(reaction.emote) } : {}),
    })) } : {}),
    ...(message.attachments ? { attachments: message.attachments.flatMap((attachment) => {
      if (!attachment || typeof attachment !== "object") return [];
      const raw = attachment as unknown as Record<string, unknown>;
      let media: MediaAssetReference;
      try { media = normalizeMediaReference(raw.media ?? raw); } catch { return []; }
      if (!Number.isSafeInteger(raw.byteSize) || Number(raw.byteSize) < 0
        || !Number.isSafeInteger(raw.position) || Number(raw.position) < 0) return [];
      return [{
        mediaId: media.assetId,
        contentType: media.contentType ?? "application/octet-stream",
        byteSize: Number(raw.byteSize),
        encrypted: raw.encrypted === true,
        position: Number(raw.position),
        ...(media.version ? { version: media.version } : {}),
      }];
    }) } : {}),
  };
}

function normalizeMembersResponse(response: CommunityMembersResponse): CommunityMembersResponse {
  return { members: response.members.map((member) => ({ ...member, ...(member.avatar ? { avatar: normalizeMediaReference(member.avatar) } : {}) })) };
}

function normalizeMessagesResponse(response: MessagesResponse): MessagesResponse {
  return { ...response, messages: response.messages.map(normalizeChatMessage) };
}

const realtimeKinds = new Set<RealtimeEvent["kind"]>([
  "sync.required",
  "message.created", "message.updated", "message.deleted", "message.reactions-changed",
  "channels.changed", "members.changed", "roles.changed", "emotes.changed", "audit.changed",
]);

function normalizeRealtimeEvent(value: unknown): RealtimeEvent | undefined {
  if (!value || typeof value !== "object") return undefined;
  const event = value as Record<string, unknown>;
  if (!validOpaqueId(event.id) || typeof event.kind !== "string" || !realtimeKinds.has(event.kind as RealtimeEvent["kind"])
    || typeof event.occurredAt !== "string" || Number.isNaN(Date.parse(event.occurredAt))) return undefined;
  for (const key of ["actorId", "channelId", "messageId"] as const) {
    if (event[key] !== undefined && !validOpaqueId(event[key])) return undefined;
  }
  return {
    id: event.id,
    kind: event.kind as RealtimeEvent["kind"],
    occurredAt: new Date(event.occurredAt).toISOString(),
    ...(typeof event.actorId === "string" ? { actorId: event.actorId } : {}),
    ...(typeof event.channelId === "string" ? { channelId: event.channelId } : {}),
    ...(typeof event.messageId === "string" ? { messageId: event.messageId } : {}),
  };
}

function emitRealtimeEvent(value: unknown, trackCursor = true): void {
  const event = normalizeRealtimeEvent(value);
  if (!event || !mainWindow || mainWindow.isDestroyed()) return;
  if (trackCursor && event.kind !== "sync.required") lastRealtimeEventId = event.id;
  mainWindow.webContents.send("realtime:event", event);
}

async function consumeRealtimeStream(response: Response, generation: number): Promise<void> {
  if (!response.body) throw new Error("Realtime response had no body.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (generation === realtimeGeneration) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > 256 * 1024) throw new Error("Realtime event buffer exceeded its limit.");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary).replaceAll("\r", "");
        buffer = buffer.slice(boundary + 2);
        const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
        if (data && data.length <= 4096) {
          try { emitRealtimeEvent(JSON.parse(data)); } catch { /* Ignore malformed server events. */ }
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function stopRealtimeConnection(): void {
  realtimeGeneration += 1;
  realtimeAbort?.abort();
  realtimeAbort = null;
}

function startRealtimeConnection(): void {
  stopRealtimeConnection();
  if (!accessToken || currentState.status !== "authenticated") return;
  const generation = realtimeGeneration;
  void (async () => {
    let retryDelay = 1000;
    while (generation === realtimeGeneration && accessToken && currentState.status === "authenticated") {
      const controller = new AbortController();
      realtimeAbort = controller;
      try {
        const origin = await configuredOrigin();
        const resumeFrom = lastRealtimeEventId;
        const requestAccessToken: string = accessToken;
        const response = await fetch(`${origin}/v1/realtime/events`, {
          headers: { accept: "text/event-stream", authorization: `Bearer ${requestAccessToken}`, ...(resumeFrom ? { "last-event-id": resumeFrom } : {}) },
          signal: controller.signal,
        });
        if (response.status === 401) {
          await response.body?.cancel().catch(() => undefined);
          if (!accessToken || accessToken === requestAccessToken) {
            const refreshed = await refreshSession();
            if (!refreshed.ok) return;
            return;
          }
          continue;
        }
        if (!response.ok || !response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream")) {
          throw new Error("Realtime connection was rejected.");
        }
        retryDelay = 1000;
        await consumeRealtimeStream(response, generation);
      } catch (error: unknown) {
        if (controller.signal.aborted || generation !== realtimeGeneration) return;
        console.warn("FreeCord realtime connection interrupted", error instanceof Error ? error.message : "unknown error");
      } finally {
        if (realtimeAbort === controller) realtimeAbort = null;
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelay));
      retryDelay = Math.min(retryDelay * 2, 10_000);
    }
  })();
}

function validateBinaryMediaInput(input: unknown, maxBytes: number): BinaryMediaUploadInput | null {
  if (!input || typeof input !== "object") return null;
  const value = input as Partial<BinaryMediaUploadInput>;
  if (typeof value.name !== "string" || !value.name.trim() || value.name.length > 255 || typeof value.mimeType !== "string" || !value.mimeType || value.mimeType.length > 160 || !(value.bytes instanceof ArrayBuffer) || value.bytes.byteLength < 1 || value.bytes.byteLength > maxBytes) return null;
  return { name: value.name.trim(), mimeType: value.mimeType, bytes: value.bytes };
}

async function uploadInlineMedia(purpose: "message" | "avatar" | "emote", input: BinaryMediaUploadInput): Promise<MediaAssetReference> {
  const response = await requestJson<{ media: unknown }>(await configuredOrigin(), "/v1/media/uploads", {
    method: "POST",
    body: JSON.stringify({ purpose, name: input.name, contentType: input.mimeType, dataBase64: Buffer.from(input.bytes).toString("base64") }),
  }, 180_000);
  return normalizeMediaReference(response.media);
}

const selectedMediaMimeByExtension: Record<string, string> = {
  gif: "image/gif", jpeg: "image/jpeg", jpg: "image/jpeg", m4v: "video/mp4", mp3: "audio/mpeg",
  mp4: "video/mp4", oga: "audio/ogg", ogg: "audio/ogg", png: "image/png", wav: "audio/wav",
  webm: "video/webm", webp: "image/webp",
};

async function chooseAndUploadMedia(): Promise<MediaAssetReference | MediaSelectionCanceled> {
  if (!mainWindow) throw new Error("The FreeCord window is unavailable.");
  if (currentState.status !== "authenticated" || !accessToken) throw new Error("Sign in before uploading an attachment.");
  let phase: "picker" | "read" | "upload" = "picker";
  try {
    const selection = await dialog.showOpenDialog(mainWindow, {
      title: "Choose a supported chat attachment",
      properties: ["openFile"],
      filters: [{ name: "Images, audio, and video", extensions: Object.keys(selectedMediaMimeByExtension) }],
    });
    const selectedPath = selection.filePaths[0];
    if (selection.canceled || !selectedPath) return { canceled: true };
    const extension = path.extname(selectedPath).slice(1).toLowerCase();
    const mimeType = selectedMediaMimeByExtension[extension];
    if (!mimeType) throw new Error("Choose a JPEG, PNG, WebP, GIF, MP3, Ogg, WAV, MP4, M4V, or WebM file.");
    const maxBytes = 25 * 1024 * 1024;
    phase = "read";
    const handle = await open(selectedPath, "r");
    let data: Buffer;
    try {
      const details = await handle.stat();
      if (!details.isFile() || details.size < 1 || details.size > maxBytes) throw new Error("The selected file must be between 1 byte and 25 MiB.");
      data = Buffer.allocUnsafe(details.size + 1);
      let bytesRead = 0;
      while (bytesRead < data.byteLength) {
        const result = await handle.read(data, bytesRead, data.byteLength - bytesRead, null);
        if (result.bytesRead === 0) break;
        bytesRead += result.bytesRead;
      }
      if (bytesRead !== details.size) throw new Error("The selected file changed while FreeCord was reading it.");
      data = data.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
    const bytes = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    const name = path.basename(selectedPath);
    phase = "upload";
    const uploaded = await uploadInlineMedia("message", { name, mimeType, bytes });
    return { ...uploaded, name, mimeType: uploaded.mimeType ?? mimeType, size: uploaded.size ?? data.byteLength };
  } catch (error: unknown) {
    const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "unknown";
    console.warn("FreeCord attachment operation failed", { phase, code });
    if (phase === "picker") throw new Error("The KDE file picker could not open. Check that xdg-desktop-portal-kde is running and try again.");
    if (phase === "read" && (code === "EACCES" || code === "EPERM")) throw new Error("FreeCord could not access that file. Try copying it to Downloads and selecting it again.");
    if (phase === "read" && code === "ENOENT") throw new Error("The selected file is no longer available. Choose it again from the KDE file picker.");
    throw error;
  }
}

async function fetchMediaFromServer(request: Request): Promise<Response> {
  let parsed: URL;
  try {
    parsed = new URL(request.url);
  } catch {
    return new Response("Invalid media URL", { status: 400 });
  }
  let assetId = "";
  try { assetId = decodeURIComponent(parsed.pathname.replace(/^\//, "")); } catch { return new Response("Invalid media URL", { status: 400 }); }
  if (parsed.protocol !== `${mediaScheme}:` || parsed.hostname !== "asset" || parsed.port || parsed.username || parsed.password || [...parsed.searchParams.keys()].some((key) => key !== "v") || !validOpaqueId(assetId)) {
    return new Response("Invalid media URL", { status: 400 });
  }
  if (currentState.status !== "authenticated" || !accessToken) return new Response("Authentication required", { status: 401 });

  const origin = await configuredOrigin();
  const requestGeneration = authenticationGeneration;
  const headers = new Headers();
  for (const name of ["range", "if-none-match", "if-modified-since"] as const) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("accept", request.headers.get("accept") ?? "*/*");
  let requestAccessToken = accessToken;
  headers.set("authorization", `Bearer ${requestAccessToken}`);

  const performFetch = () => fetch(`${origin}/v1/media/${encodeURIComponent(assetId)}`, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(60_000),
  });

  try {
    let upstream = await performFetch();
    if (upstream.status === 401) {
      await upstream.body?.cancel().catch(() => undefined);
      if (!await authContextStillCurrent(requestGeneration, origin)) return new Response("Authentication required", { status: 401 });
      if (!accessToken || accessToken === requestAccessToken) {
        const refreshed = await refreshSession();
        if (!refreshed.ok || !accessToken || !await authContextStillCurrent(requestGeneration, origin)) return new Response("Authentication required", { status: 401 });
      }
      requestAccessToken = accessToken;
      headers.set("authorization", `Bearer ${accessToken}`);
      upstream = await performFetch();
    }
    const responseHeaders = new Headers();
    for (const name of ["accept-ranges", "cache-control", "content-disposition", "content-length", "content-range", "content-type", "etag", "last-modified"] as const) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }
    // The renderer is loaded from file:// while authenticated media uses a
    // dedicated scheme. Electron 43 enforces cross-protocol CORS before the
    // custom handler response can be consumed, including image subresources.
    responseHeaders.set("access-control-allow-origin", "*");
    responseHeaders.set("cross-origin-resource-policy", "cross-origin");
    responseHeaders.set("x-content-type-options", "nosniff");
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: responseHeaders });
  } catch {
    return new Response("Media server unavailable", { status: 502 });
  }
}

async function fetchImageData(assetId: string): Promise<MediaImageData> {
  const response = await fetchMediaFromServer(new Request(`${mediaScheme}://asset/${encodeURIComponent(assetId)}`));
  if (!response.ok) throw new Error(response.status === 401 ? "Authentication required." : "Image could not be loaded from the FreeCord server.");
  const contentType = response.headers.get("content-type")?.toLowerCase().split(";", 1)[0]?.trim();
  if (contentType !== "image/jpeg" && contentType !== "image/png" && contentType !== "image/webp" && contentType !== "image/gif") throw new Error("The FreeCord server returned an unsupported image type.");
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  const maxImageBytes = 2 * 1024 * 1024;
  if (!Number.isSafeInteger(declaredLength) || declaredLength < 0 || declaredLength > maxImageBytes) throw new Error("The FreeCord image is too large to display.");
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength < 1 || bytes.byteLength > maxImageBytes) throw new Error("The FreeCord image is invalid or too large to display.");
  return { dataUrl: `data:${contentType};base64,${Buffer.from(bytes).toString("base64")}`, contentType };
}

function authenticated(response: LoginResponse | SessionResponse): AuthResult {
  currentState = { status: "authenticated", user: normalizeAuthenticatedUser(response.user), session: response.session };
  startRealtimeConnection();
  return { ok: true, state: currentState };
}

async function performSessionRefresh(): Promise<AuthResult | AuthError> {
  const generation = authenticationGeneration;
  try {
    const origin = await configuredOrigin();
    if (authenticationGeneration !== generation) return { ok: true, state: currentState };
    const token = await loadRefreshToken();
    if (authenticationGeneration !== generation) return { ok: true, state: currentState };
    if (!token) return signedOutResult();
    const response = await requestJson<LoginResponse>(origin, "/v1/auth/refresh", {
      method: "POST", body: JSON.stringify({ refreshToken: token }),
    });
    if (authenticationGeneration !== generation || refreshToken !== token || await configuredOrigin() !== origin) return { ok: true, state: currentState };
    if (!await saveRefreshToken(response.refreshToken, generation) || authenticationGeneration !== generation) return { ok: true, state: currentState };
    accessToken = response.accessToken;
    return authenticated(response);
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "Unauthorized" && authenticationGeneration === generation) await clearStoredCredentials();
    return authError(error instanceof Error && error.name === "Unauthorized" ? "AUTHENTICATION_FAILED" : "SERVER_UNAVAILABLE", error instanceof Error ? error.message : "Session refresh failed.");
  }
}

async function refreshSession(): Promise<AuthResult | AuthError> {
  if (signOutInProgress) return authError("AUTHENTICATION_FAILED", "The session is signing out.");
  if (refreshInFlight) return refreshInFlight;
  const operation = performSessionRefresh();
  refreshInFlight = operation;
  try {
    return await operation;
  } finally {
    if (refreshInFlight === operation) refreshInFlight = null;
  }
}

function signedOutResult(): AuthResult {
  return { ok: true, state: signedOut() };
}

function isLocalhost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "[::1]" || normalized === "::1";
}

export function validateServerOrigin(input: string, allowInsecureLocalhost: boolean): string {
  if (typeof input !== "string" || input.trim().length === 0 || input.length > 2048) {
    throw new Error("Enter the URL of your FreeCord server.");
  }

  let parsed: URL;
  try {
    parsed = new URL(input.trim());
  } catch {
    throw new Error("Enter a valid server URL, including https://.");
  }

  const local = isLocalhost(parsed.hostname);
  const isHttps = parsed.protocol === "https:";
  const isAllowedDevelopmentHttp = parsed.protocol === "http:" && local && allowInsecureLocalhost;
  if (!isHttps && !isAllowedDevelopmentHttp) {
    throw new Error(local ? "Use HTTPS, or explicitly enable HTTP for localhost development." : "Server URLs must use HTTPS.");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/") {
    throw new Error("Enter only the server origin, without a path, credentials, query, or fragment.");
  }

  return parsed.origin;
}

function toSettings(value: unknown): ServerSettings {
  if (!value || typeof value !== "object") return defaultSettings;
  const candidate = value as Partial<PersistedSettings>;
  if (candidate.version !== settingsVersion) return defaultSettings;
  if (candidate.serverOrigin !== null && typeof candidate.serverOrigin !== "string") return defaultSettings;
  const allowInsecureLocalhost = candidate.allowInsecureLocalhost === true;
  if (candidate.serverOrigin === null || candidate.serverOrigin === undefined) return defaultSettings;
  try {
    return {
      version: settingsVersion,
      serverOrigin: validateServerOrigin(candidate.serverOrigin, allowInsecureLocalhost),
      allowInsecureLocalhost,
    };
  } catch {
    return defaultSettings;
  }
}

async function loadSettings(): Promise<ServerSettings> {
  try {
    const contents = await readFile(settingsPath(), "utf8");
    return toSettings(JSON.parse(contents));
  } catch {
    return defaultSettings;
  }
}

async function saveSettings(settings: ServerSettings): Promise<void> {
  const directory = path.dirname(settingsPath());
  await mkdir(directory, { recursive: true });
  const temporaryPath = `${settingsPath()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, settingsPath());
}

function settingsError(error: unknown): SettingsError {
  return {
    ok: false,
    code: "INVALID_SERVER_ORIGIN",
    message: error instanceof Error ? error.message : "The server URL could not be saved.",
  };
}

function isWithinDirectory(candidate: string, directory: string): boolean {
  const relative = path.relative(path.resolve(directory), path.resolve(candidate));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function isAllowedNavigation(url: string): boolean {
  if (devServerUrl) {
    try {
      return new URL(url).origin === new URL(devServerUrl).origin;
    } catch {
      return false;
    }
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "file:") return false;
    return isWithinDirectory(fileURLToPath(parsed), rendererRoot);
  } catch {
    return false;
  }
}

function configuredFilesOrigin(): string {
  const candidate = process.env.FREECORD_FILES_ORIGIN?.trim() || defaultFilesOrigin;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port || parsed.pathname !== "/" || parsed.search || parsed.hash) throw new Error();
    return parsed.origin;
  } catch {
    console.error("FREECORD_FILES_ORIGIN is invalid; using the secure default origin.");
    return defaultFilesOrigin;
  }
}

const filesOrigin = configuredFilesOrigin();

function isAllowedFilesNavigation(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password && !parsed.port && parsed.origin === filesOrigin;
  } catch {
    return false;
  }
}

function isTrustedIpcEvent(event: Electron.IpcMainInvokeEvent): boolean {
  return Boolean(
    mainWindow
    && !mainWindow.isDestroyed()
    && event.sender === mainWindow.webContents
    && event.senderFrame === mainWindow.webContents.mainFrame
    && isAllowedNavigation(event.senderFrame.url),
  );
}

// Every renderer-accessible operation, including apparently read-only ones,
// crosses the same exact-main-frame boundary. This prevents future handlers
// from accidentally exposing credentials or native capabilities to embedded
// or remotely navigated content.
const ipcMain = {
  handle(channel: string, listener: Parameters<typeof rawIpcMain.handle>[1]): void {
    rawIpcMain.handle(channel, (event, ...args) => {
      if (!isTrustedIpcEvent(event)) throw new Error("FreeCord rejected an untrusted desktop request.");
      return listener(event, ...args);
    });
  },
};

function clampFilesRect(input: FilesSurfaceRect): Electron.Rectangle | null {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  const values = [input?.x, input?.y, input?.width, input?.height];
  if (!values.every((value) => typeof value === "number" && Number.isFinite(value))) return null;
  const content = mainWindow.getContentBounds();
  const x = Math.max(0, Math.min(Math.floor(input.x), Math.max(0, content.width - 1)));
  const y = Math.max(0, Math.min(Math.floor(input.y), Math.max(0, content.height - 1)));
  const width = Math.max(1, Math.min(Math.floor(input.width), content.width - x));
  const height = Math.max(1, Math.min(Math.floor(input.height), content.height - y));
  return { x, y, width, height };
}

async function destroyFilesSurface(): Promise<void> {
  filesSurfaceGeneration += 1;
  filesSurfaceVisible = false;
  const view = filesView;
  filesView = null;
  if (view) {
    try { mainWindow?.contentView.removeChildView(view); } catch { /* The parent may already be closing. */ }
    if (!view.webContents.isDestroyed()) view.webContents.close();
  }
  const isolatedSession = session.fromPartition("freecord-copyparty");
  await Promise.allSettled([isolatedSession.clearCache(), isolatedSession.clearStorageData()]);
}

function createFilesView(): WebContentsView {
  if (filesView && !filesView.webContents.isDestroyed()) return filesView;
  if (!mainWindow || mainWindow.isDestroyed()) throw new Error("The FreeCord window is unavailable.");

  const isolatedSession = session.fromPartition("freecord-copyparty", { cache: false });
  isolatedSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  isolatedSession.setPermissionCheckHandler(() => false);

  const view = new WebContentsView({
    webPreferences: {
      partition: "freecord-copyparty",
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      allowRunningInsecureContent: false,
      safeDialogs: true,
      navigateOnDragDrop: false,
    },
  });
  view.setVisible(false);
  view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  view.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedFilesNavigation(url)) event.preventDefault();
  });
  view.webContents.on("will-frame-navigate", (event) => {
    if (!isAllowedFilesNavigation(event.url)) event.preventDefault();
  });
  view.webContents.on("will-redirect", (event, url) => {
    if (!isAllowedFilesNavigation(url)) event.preventDefault();
  });
  view.webContents.on("render-process-gone", () => { void destroyFilesSurface(); });
  isolatedSession.removeAllListeners("will-download");
  isolatedSession.on("will-download", (event, item, sourceWebContents) => {
    const urlChain = item.getURLChain();
    const allowed = filesSurfaceVisible
      && sourceWebContents === view.webContents
      && urlChain.length > 0
      && urlChain.every(isAllowedFilesNavigation);
    if (!allowed) {
      event.preventDefault();
      return;
    }
    item.setSaveDialogOptions({ title: "Save FreeCord file", defaultPath: path.basename(item.getFilename()) });
  });
  mainWindow.contentView.addChildView(view);
  filesView = view;
  return view;
}

async function showFilesSurface(rect: FilesSurfaceRect): Promise<FilesSurfaceState> {
  const generation = ++filesSurfaceGeneration;
  const bounds = clampFilesRect(rect);
  if (!bounds) throw new Error("The Copyparty panel bounds are invalid.");
  const view = createFilesView();
  view.setBounds(bounds);
  try {
    if (!view.webContents.getURL()) await view.webContents.loadURL(`${filesOrigin}/`);
  } catch (error) {
    view.setVisible(false);
    filesSurfaceVisible = false;
    throw error;
  }
  if (generation !== filesSurfaceGeneration || filesView !== view || view.webContents.isDestroyed()) {
    return { ok: true, visible: false, origin: filesOrigin };
  }
  filesSurfaceVisible = true;
  view.setVisible(true);
  return { ok: true, visible: true, origin: filesOrigin };
}

function hideFilesSurface(): FilesSurfaceState {
  filesSurfaceGeneration += 1;
  filesSurfaceVisible = false;
  filesView?.setVisible(false);
  return { ok: true, visible: false, origin: filesOrigin };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character] ?? character));
}

async function chooseDisplaySource(parent: BrowserWindow, sources: Electron.DesktopCapturerSource[]): Promise<Electron.DesktopCapturerSource | undefined> {
  const choices = sources.slice(0, 20);
  if (choices.length === 0) return undefined;
  const sourceById = new Map(choices.map((source) => [source.id, source]));
  const cards = choices.map((source) => `<a class="source" href="freecord-source:${encodeURIComponent(source.id)}"><img src="${source.thumbnail.toDataURL()}" alt=""><strong>${escapeHtml(source.name || "Untitled source")}</strong><span>${source.id.startsWith("window:") ? "Window" : "Display"}</span></a>`).join("");
  const html = `<!doctype html><meta charset="utf-8"><title>Share your screen</title><style>
    *{box-sizing:border-box}body{margin:0;padding:24px;background:#171b25;color:#edf0f8;font:14px system-ui,sans-serif}h1{margin:0 0 6px;font-size:21px}p{margin:0 0 18px;color:#aeb7cc}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px}.source{display:flex;flex-direction:column;gap:7px;padding:9px;border:1px solid #39445e;border-radius:10px;color:inherit;text-decoration:none;background:#222938}.source:hover{border-color:#8b9cff;background:#2b3448}.source img{width:100%;aspect-ratio:16/9;object-fit:cover;border-radius:6px;background:#0c0f16}.source strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.source span{color:#9ca8c0;font-size:12px}.cancel{display:inline-block;margin-top:18px;padding:8px 12px;border-radius:7px;color:#dfe4f3;background:#30394d;text-decoration:none}
  </style><h1>Choose what to share</h1><p>Select a monitor or application window. FreeCord will only share the source you choose.</p><div class="grid">${cards}</div><a class="cancel" href="freecord-cancel:">Cancel</a>`;
  const picker = new BrowserWindow({ parent, modal: true, width: 900, height: 650, minWidth: 620, minHeight: 460, title: "Share your screen", webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  picker.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  return new Promise((resolve) => {
    let settled = false;
    const finish = (source?: Electron.DesktopCapturerSource) => { if (settled) return; settled = true; resolve(source); if (!picker.isDestroyed()) picker.close(); };
    const handlePickerNavigation = (event: Electron.Event, url: string) => {
      if (url.startsWith("data:text/html")) return;
      event.preventDefault();
      if (url.startsWith("freecord-source:")) finish(sourceById.get(decodeURIComponent(url.slice("freecord-source:".length))));
      else if (url.startsWith("freecord-cancel:")) finish();
    };
    // Electron may emit will-frame-navigate before will-navigate. Handle the
    // selection in both events so the earlier event cannot swallow the click
    // and leave getDisplayMedia waiting forever.
    picker.webContents.on("will-navigate", handlePickerNavigation);
    picker.webContents.on("will-frame-navigate", (details) => handlePickerNavigation(details, details.url));
    picker.webContents.on("will-redirect", (event) => event.preventDefault());
    picker.on("closed", () => finish());
    void picker.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  });
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#111318",
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedNavigation(url)) event.preventDefault();
  });
  mainWindow.webContents.on("will-redirect", (event, url) => {
    if (!isAllowedNavigation(url)) event.preventDefault();
  });
  const publishFullscreenState = () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("window:fullscreen-changed", mainWindow.isFullScreen());
  };
  mainWindow.on("enter-full-screen", publishFullscreenState);
  mainWindow.on("leave-full-screen", publishFullscreenState);
  mainWindow.webContents.on("before-input-event", (event, input) => {
    if (input.key === "Escape" && mainWindow?.isFullScreen()) {
      event.preventDefault();
      mainWindow.setFullScreen(false);
    }
  });
  mainWindow.webContents.on("render-process-gone", () => mainWindow?.setFullScreen(false));
  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    if (errorCode === -3) return;
    const message = `FreeCord could not load its interface (${errorCode}: ${errorDescription}).`;
    console.error(message, validatedURL);
    void dialog.showMessageBox(mainWindow!, {
      type: "error",
      title: "FreeCord startup failed",
      message,
    });
  });

  if (devServerUrl) {
    void mainWindow.loadURL(devServerUrl).catch((error: unknown) => {
      console.error("FreeCord development server failed to load", error);
    });
  } else {
    void mainWindow.loadFile(rendererEntry).catch((error: unknown) => {
      console.error("FreeCord renderer failed to load", error);
      void dialog.showMessageBox(mainWindow!, {
        type: "error",
        title: "FreeCord startup failed",
        message: "The FreeCord desktop interface could not be loaded. Rebuild the application and try again.",
      });
    });
  }

  mainWindow.on("closed", () => {
    stopRealtimeConnection();
    void releaseLinuxScreenAudio();
    void destroyFilesSurface();
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  protocol.handle(mediaScheme, fetchMediaFromServer);
  // Electron 43 requires a display-media handler for Linux as well as
  // Windows. Windows can provide loopback system audio; Linux video capture
  // uses the permission-gated source picker and its desktop audio path is
  // handled separately by PipeWire/PulseAudio.
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    const requestingUrl = request.frame?.url ?? "";
    let completed = false;
    const complete = (streams: Electron.Streams) => {
      if (completed) return;
      completed = true;
      callback(streams);
    };
    if (!mainWindow || !request.frame || request.frame !== mainWindow.webContents.mainFrame || !isAllowedNavigation(requestingUrl)) {
      console.error("FreeCord rejected display capture request", { requestingUrl, hasWindow: Boolean(mainWindow), hasFrame: Boolean(request.frame) });
      complete({});
      return;
    }
    try {
      const sources = await desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 240, height: 135 } });
      if (sources.length === 0) { console.error("FreeCord found no display sources"); complete({}); return; }
      const source = await chooseDisplaySource(mainWindow, sources);
      if (!source) { console.error("FreeCord display source selection was cancelled"); complete({}); return; }
      complete({ video: source, ...(process.platform === "win32" && request.audioRequested ? { audio: "loopback" as const } : {}) });
    } catch (error: unknown) {
      console.error("FreeCord display capture handler failed", error);
      complete({});
    }
  });
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(
      (permission === "media" || permission === "display-capture")
      && webContents === mainWindow?.webContents
      && details.isMainFrame
      && isAllowedNavigation(details.requestingUrl),
    );
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    const currentUrl = details.requestingUrl ?? requestingOrigin;
    return webContents === mainWindow?.webContents && details.isMainFrame && callbackPermissionCheck(permission, currentUrl);
  });

  ipcMain.handle("runtime:get-info", (): RuntimeInfo => ({
    appVersion: app.getVersion(),
    platform: process.platform,
  }));
  ipcMain.handle("runtime:open-support-page", async (): Promise<{ ok: true }> => {
    await shell.openExternal(supportUrl);
    return { ok: true };
  });
  ipcMain.handle("window:get-fullscreen", (): boolean => mainWindow?.isFullScreen() === true);
  ipcMain.handle("window:set-fullscreen", (_event, fullscreen: unknown): void => {
    if (!mainWindow || typeof fullscreen !== "boolean") throw new TypeError("Fullscreen state must be a boolean.");
    mainWindow.setFullScreen(fullscreen);
  });
  ipcMain.handle("audio:prepare-linux-screen", (): Promise<LinuxScreenAudioResult> => ensureLinuxScreenAudio());
  ipcMain.handle("audio:unmute-linux-screen", (): void => unmuteLinuxScreenAudio());
  ipcMain.handle("audio:release-linux-screen", (): Promise<void> => releaseLinuxScreenAudio());
  ipcMain.handle("settings:get-server", (): Promise<ServerSettings> => loadSettings());
  ipcMain.handle("settings:get-audio", (): Promise<AudioSettings> => loadAudioSettings());
  ipcMain.handle("settings:save-audio", async (_event, input: unknown): Promise<AudioSettings> => saveAudioSettings((input && typeof input === "object" ? input : {}) as AudioSettings));
  ipcMain.handle("settings:save-server", async (_event, input: ServerSettingsInput): Promise<SettingsResult | SettingsError> => {
    try {
      if (!input || typeof input !== "object" || typeof input.serverOrigin !== "string") {
        throw new Error("Enter the URL of your FreeCord server.");
      }
      const settings: ServerSettings = {
        version: settingsVersion,
        serverOrigin: validateServerOrigin(input.serverOrigin, input.allowInsecureLocalhost === true),
        allowInsecureLocalhost: input.allowInsecureLocalhost === true,
      };
      const previous = await loadSettings();
      await saveSettings(settings);
      if (previous.serverOrigin !== settings.serverOrigin) await clearStoredCredentials();
      return { ok: true, settings };
    } catch (error: unknown) {
      return settingsError(error);
    }
  });
  ipcMain.handle("settings:clear-server", async (): Promise<SettingsResult | SettingsError> => {
    try {
      await saveSettings(defaultSettings);
      await clearStoredCredentials();
      return { ok: true, settings: defaultSettings };
    } catch (error: unknown) {
      return { ok: false, code: "SETTINGS_UNAVAILABLE", message: error instanceof Error ? error.message : "Settings could not be cleared." };
    }
  });

  ipcMain.handle("auth:login", async (_event, input: LoginInput): Promise<AuthResult | AuthError> => {
    if (!credentialStorageAvailable()) {
      return authError("CREDENTIAL_STORAGE_UNAVAILABLE", "Secure credential storage is unavailable on this system.");
    }
    if (!input || typeof input.username !== "string" || typeof input.password !== "string" || !input.username.trim() || !input.password) {
      return authError("AUTHENTICATION_FAILED", "Enter your username and password.");
    }
    let generation: number | null = null;
    try {
      await clearStoredCredentials();
      generation = authenticationGeneration;
      const response = await requestJson<LoginResponse>(await configuredOrigin(), "/v1/auth/login", {
        method: "POST",
        body: JSON.stringify({ username: input.username.trim(), password: input.password, deviceName: "FreeCord Desktop" }),
      });
      if (!await saveRefreshToken(response.refreshToken, generation) || authenticationGeneration !== generation) return { ok: true, state: currentState };
      accessToken = response.accessToken;
      return authenticated(response);
    } catch (error: unknown) {
      if (generation === authenticationGeneration) accessToken = null;
      return authError(
        error instanceof Error && error.message.includes("Configure") ? "NO_SERVER_CONFIGURED" : error instanceof Error && error.name === "Unauthorized" ? "AUTHENTICATION_FAILED" : "SERVER_UNAVAILABLE",
        error instanceof Error ? error.message : "Sign-in failed.",
      );
    }
  });
  ipcMain.handle("auth:register", async (_event, input: RegisterInput): Promise<AuthResult | AuthError> => {
    if (!input || !input.inviteToken?.trim() || !input.username?.trim() || !input.displayName?.trim() || !input.password) {
      return authError("AUTHENTICATION_FAILED", "Enter an invitation, display name, username, and password.");
    }
    const username = input.username.trim();
    const displayName = input.displayName.trim();
    if (!/^[a-z0-9][a-z0-9_.-]{2,63}$/i.test(username)) {
      return authError("AUTHENTICATION_FAILED", "Username must be 3–64 characters and use only letters, numbers, periods, underscores, or hyphens.");
    }
    if (displayName.length > 100) return authError("AUTHENTICATION_FAILED", "Display name must be 100 characters or fewer.");
    if (input.password.length < 12) return authError("AUTHENTICATION_FAILED", "Password must contain at least 12 characters.");
    if (input.password.length > 1024) return authError("AUTHENTICATION_FAILED", "Password is too long.");
    if (!credentialStorageAvailable()) {
      return authError("CREDENTIAL_STORAGE_UNAVAILABLE", "Secure credential storage is unavailable. FreeCord did not consume the invitation.");
    }
    let generation: number | null = null;
    let stagedChatKey: string | null = null;
    let accountCreated = false;
    try {
      await clearStoredCredentials();
      generation = authenticationGeneration;
      const invite = inviteParts(input.inviteToken.trim());
      if (invite.chatKey) stagedChatKey = await stageRegistrationChatKey(invite.chatKey);
      const response = await requestJson<LoginResponse>(await configuredOrigin(), "/v1/auth/register", {
        method: "POST",
        body: JSON.stringify({ inviteToken: invite.serverToken, username, displayName, password: input.password, deviceName: "FreeCord Desktop" }),
      });
      accountCreated = true;
      if (stagedChatKey) {
        await rename(stagedChatKey, chatKeyPath());
        stagedChatKey = null;
      }
      if (!await saveRefreshToken(response.refreshToken, generation) || authenticationGeneration !== generation) return { ok: true, state: currentState };
      accessToken = response.accessToken;
      return authenticated(response);
    } catch (error: unknown) {
      try { await discardStagedRegistrationChatKey(stagedChatKey); } catch { /* Preserve the primary registration error. */ }
      if (generation === authenticationGeneration) accessToken = null;
      if (accountCreated) {
        return authError("CREDENTIAL_STORAGE_UNAVAILABLE", "Your account was created, but this device could not save the sign-in credentials. Switch to Sign in and use the same username and password.");
      }
      return authError(error instanceof Error && error.name === "Unauthorized" ? "AUTHENTICATION_FAILED" : error instanceof Error && error.message.includes("Configure") ? "NO_SERVER_CONFIGURED" : "SERVER_UNAVAILABLE", error instanceof Error ? error.message : "Registration failed.");
    }
  });

  ipcMain.handle("auth:refresh", (): Promise<AuthResult | AuthError> => refreshSession());
  ipcMain.handle("auth:get-session-state", async (): Promise<SessionState> => {
    if (currentState.status === "authenticated" && accessToken) return currentState;
    if (accessToken) {
      try {
        const response = await requestJson<SessionResponse>(await configuredOrigin(), "/v1/auth/session");
        return authenticated(response).state;
      } catch { /* A missing/expired access token is recovered below. */ }
    }
    const result = await refreshSession();
    return result.ok ? result.state : currentState;
  });
  ipcMain.handle("auth:logout", async (): Promise<AuthResult | AuthError> => {
    if (signOutInProgress) return { ok: true, state: currentState };
    signOutInProgress = true;
    let failure: AuthError | null = null;
    let origin: string | null = null;
    try {
      if (refreshInFlight) await refreshInFlight;
      origin = await configuredOrigin();
      const logoutRefreshToken = await loadRefreshToken();
      await clearStoredCredentials();
      if (origin && logoutRefreshToken) {
        const response = await fetch(`${origin}/v1/auth/logout`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ refreshToken: logoutRefreshToken }),
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok && response.status !== 401) throw new Error("The FreeCord server could not revoke the session.");
      }
    } catch (error: unknown) {
      failure = authError("SERVER_UNAVAILABLE", error instanceof Error ? error.message : "Sign-out could not reach the server.");
    }
    finally {
      if (currentState.status !== "signed-out") await clearStoredCredentials();
      signOutInProgress = false;
    }
    return failure ?? { ok: true, state: currentState };
  });
  ipcMain.handle("auth:update-status", async (_event, status: unknown): Promise<AuthResult | AuthError> => {
    if (status !== "active" && status !== "busy" && status !== "away") return authError("AUTHENTICATION_FAILED", "Status is invalid.");
    try {
      const response = await requestJson<{ user: AuthenticatedUser }>(await configuredOrigin(), "/v1/auth/profile/status", { method: "PATCH", body: JSON.stringify({ status }) });
      currentState = { ...currentState, user: normalizeAuthenticatedUser(response.user) };
      return { ok: true, state: currentState };
    } catch (error: unknown) { return authError(error instanceof Error && error.name === "Unauthorized" ? "AUTHENTICATION_FAILED" : "SERVER_UNAVAILABLE", error instanceof Error ? error.message : "Status could not be updated."); }
  });
  ipcMain.handle("profile:update", async (event, input: unknown): Promise<AuthResult | AuthError> => {
    if (!isTrustedIpcEvent(event)) return authError("AUTHENTICATION_FAILED", "Untrusted desktop request.");
    const value = input as Partial<UpdateProfileInput> | null;
    if (!value || typeof value.displayName !== "string" || !value.displayName.trim() || value.displayName.trim().length > 100) return authError("AUTHENTICATION_FAILED", "Display name is invalid.");
    try {
      const response = await requestJson<{ user: AuthenticatedUser }>(await configuredOrigin(), "/v1/users/me/profile", { method: "PATCH", body: JSON.stringify({ displayName: value.displayName.trim() }) });
      currentState = { ...currentState, user: normalizeAuthenticatedUser(response.user) };
      return { ok: true, state: currentState };
    } catch (error: unknown) { return apiFailure(error, "Profile could not be updated."); }
  });
  ipcMain.handle("profile:change-password", async (event, input: unknown): Promise<{ ok: true } | AuthError> => {
    if (!isTrustedIpcEvent(event)) return authError("AUTHENTICATION_FAILED", "Untrusted desktop request.");
    const value = input as Partial<ChangePasswordInput> | null;
    if (!value || typeof value.currentPassword !== "string" || typeof value.newPassword !== "string" || value.currentPassword.length < 1 || value.newPassword.length < 12 || value.newPassword.length > 1024) return authError("AUTHENTICATION_FAILED", "Password details are invalid.");
    try {
      await requestJson<{ ok: true }>(await configuredOrigin(), "/v1/users/me/password", { method: "POST", body: JSON.stringify({ currentPassword: value.currentPassword, newPassword: value.newPassword }) });
      return { ok: true };
    } catch (error: unknown) { return apiFailure(error, "Password could not be changed."); }
  });
  ipcMain.handle("auth:clear-credentials", async (): Promise<{ ok: true } | AuthError> => {
    try {
      await clearStoredCredentials();
      return { ok: true };
    } catch (error: unknown) {
      return authError("CREDENTIAL_STORAGE_UNAVAILABLE", error instanceof Error ? error.message : "Credentials could not be cleared.");
    }
  });
  ipcMain.handle("community:get-channels", async (): Promise<ChannelsResponse | AuthError> => {
    try {
      return await requestJson<ChannelsResponse>(await configuredOrigin(), "/v1/community/channels");
    } catch (error: unknown) {
      return authError(error instanceof Error && error.name === "Unauthorized" ? "AUTHENTICATION_FAILED" : error instanceof Error && error.message.includes("Configure") ? "NO_SERVER_CONFIGURED" : "SERVER_UNAVAILABLE", error instanceof Error ? error.message : "Channels could not be loaded.");
    }
  });
  ipcMain.handle("community:create-channel", async (_event, input: unknown): Promise<ChannelMetadata | AuthError> => {
    if (!input || typeof input !== "object") return authError("AUTHENTICATION_FAILED", "Channel details are invalid.");
    const value = input as { name?: unknown; type?: unknown };
    if (typeof value.name !== "string" || (value.type !== "text" && value.type !== "voice") || value.name.trim().length < 1 || value.name.trim().length > 64) return authError("AUTHENTICATION_FAILED", "Channel details are invalid.");
    try { return await requestJson<ChannelMetadata>(await configuredOrigin(), "/v1/community/channels", { method: "POST", body: JSON.stringify({ name: value.name.trim(), type: value.type }) }); }
    catch (error: unknown) { return authError(error instanceof Error && error.name === "Unauthorized" ? "AUTHENTICATION_FAILED" : "SERVER_UNAVAILABLE", error instanceof Error ? error.message : "Channel could not be created."); }
  });
  ipcMain.handle("community:update-channel", async (event, input: unknown): Promise<ChannelMetadata | AuthError> => {
    if (!isTrustedIpcEvent(event)) return authError("AUTHENTICATION_FAILED", "Untrusted desktop request.");
    const value = input as { channelId?: unknown; name?: unknown } | null;
    if (!value || !validOpaqueId(value.channelId) || typeof value.name !== "string" || !value.name.trim() || value.name.trim().length > 100) return authError("AUTHENTICATION_FAILED", "Channel details are invalid.");
    try { return await requestJson<ChannelMetadata>(await configuredOrigin(), `/v1/community/channels/${encodeURIComponent(value.channelId)}`, { method: "PATCH", body: JSON.stringify({ name: value.name.trim() }) }); }
    catch (error: unknown) { return apiFailure(error, "Channel could not be updated."); }
  });
  ipcMain.handle("community:delete-channel", async (_event, channelId: unknown): Promise<{ ok: true } | AuthError> => {
    if (typeof channelId !== "string" || !channelId.trim()) return authError("AUTHENTICATION_FAILED", "Channel selection is invalid.");
    try {
      await requestJson<{ ok: true }>(await configuredOrigin(), `/v1/community/channels/${encodeURIComponent(channelId.trim())}`, { method: "DELETE" });
      return { ok: true };
    } catch (error: unknown) {
      return authError(error instanceof Error && error.name === "Unauthorized" ? "AUTHENTICATION_FAILED" : "SERVER_UNAVAILABLE", error instanceof Error ? error.message : "Channel could not be deleted.");
    }
  });
  ipcMain.handle("media:search-giphy", async (_event, query: unknown): Promise<{ results: GiphyResult[] } | AuthError> => {
    if (typeof query !== "string" || !query.trim()) return { results: [] };
    try {
      return await requestJson<{ results: GiphyResult[] }>(await configuredOrigin(), `/v1/media/giphy/search?q=${encodeURIComponent(query.trim().slice(0, 120))}`);
    } catch (error: unknown) {
      return authError(error instanceof Error && error.name === "Unauthorized" ? "AUTHENTICATION_FAILED" : "SERVER_UNAVAILABLE", error instanceof Error ? error.message : "GIF search failed.");
    }
  });

  ipcMain.handle("community:get-members", async (): Promise<CommunityMembersResponse | AuthError> => {
    try {
      return normalizeMembersResponse(await requestJson<CommunityMembersResponse>(await configuredOrigin(), "/v1/community/members"));
    } catch (error: unknown) {
      return apiFailure(error, "Unable to load community members.");
    }
  });
  ipcMain.handle("community:create-invite", async (_event, expiresInSeconds: unknown): Promise<InviteResponse | AuthError> => {
    try {
      const expires = typeof expiresInSeconds === "number" && Number.isInteger(expiresInSeconds) ? expiresInSeconds : 7 * 24 * 60 * 60;
      const invite = await requestJson<InviteResponse>(await configuredOrigin(), "/v1/invites", { method: "POST", body: JSON.stringify({ expiresInSeconds: expires }) });
      return { ...invite, token: `${invite.token}.${await loadOrCreateChatKey()}` };
    } catch (error: unknown) {
      return authError(error instanceof Error && error.name === "Unauthorized" ? "AUTHENTICATION_FAILED" : error instanceof Error && error.message.includes("Configure") ? "NO_SERVER_CONFIGURED" : "SERVER_UNAVAILABLE", error instanceof Error ? error.message : "Invitation could not be created.");
    }
  });
  ipcMain.handle("community:get-permissions", async (event): Promise<CommunityPermissionsResponse | AuthError> => {
    if (!isTrustedIpcEvent(event)) return authError("AUTHENTICATION_FAILED", "Untrusted desktop request.");
    try {
      const response = await requestJson<{ permissions: CommunityPermissionsResponse["permissions"]; currentUserPermissions?: string[]; effectivePermissions?: string[] }>(await configuredOrigin(), "/v1/community/permissions");
      return { permissions: response.permissions, effectivePermissions: response.effectivePermissions ?? response.currentUserPermissions ?? [] };
    }
    catch (error: unknown) { return apiFailure(error, "Permissions could not be loaded."); }
  });
  ipcMain.handle("community:get-roles", async (event): Promise<CommunityRolesResponse | AuthError> => {
    if (!isTrustedIpcEvent(event)) return authError("AUTHENTICATION_FAILED", "Untrusted desktop request.");
    try {
      const [roleResponse, permissionResponse] = await Promise.all([
        requestJson<{ roles: CommunityRole[] }>(await configuredOrigin(), "/v1/community/roles"),
        requestJson<{ permissions: Array<{ key: string }> }>(await configuredOrigin(), "/v1/community/permissions"),
      ]);
      return { roles: roleResponse.roles, permissions: permissionResponse.permissions.map((permission) => permission.key) };
    }
    catch (error: unknown) { return apiFailure(error, "Roles could not be loaded."); }
  });
  ipcMain.handle("community:create-role", async (event, input: unknown): Promise<CommunityRole | AuthError> => {
    if (!isTrustedIpcEvent(event)) return authError("AUTHENTICATION_FAILED", "Untrusted desktop request.");
    if (!input || typeof input !== "object") return authError("AUTHENTICATION_FAILED", "Role details are invalid.");
    const value = input as CreateRoleInput;
    if (typeof value.name !== "string" || !value.name.trim() || value.name.trim().length > 64 || !Array.isArray(value.permissions) || !value.permissions.every((permission) => typeof permission === "string" && /^[a-z0-9._-]{1,80}$/.test(permission)) || (value.position !== undefined && (!Number.isInteger(value.position) || value.position < 0))) return authError("AUTHENTICATION_FAILED", "Role details are invalid.");
    try { return (await requestJson<{ role: CommunityRole }>(await configuredOrigin(), "/v1/community/roles", { method: "POST", body: JSON.stringify({ ...value, name: value.name.trim() }) })).role; }
    catch (error: unknown) { return apiFailure(error, "Role could not be created."); }
  });
  ipcMain.handle("community:update-role", async (event, input: unknown): Promise<CommunityRole | AuthError> => {
    if (!isTrustedIpcEvent(event)) return authError("AUTHENTICATION_FAILED", "Untrusted desktop request.");
    if (!input || typeof input !== "object") return authError("AUTHENTICATION_FAILED", "Role details are invalid.");
    const value = input as { roleId?: unknown; input?: UpdateRoleInput };
    const update = value.input;
    if (!validOpaqueId(value.roleId) || !update || typeof update !== "object" || (update.name !== undefined && (typeof update.name !== "string" || !update.name.trim() || update.name.trim().length > 64)) || (update.permissions !== undefined && (!Array.isArray(update.permissions) || !update.permissions.every((permission) => typeof permission === "string" && /^[a-z0-9._-]{1,80}$/.test(permission)))) || (update.position !== undefined && (!Number.isInteger(update.position) || update.position < 0))) return authError("AUTHENTICATION_FAILED", "Role details are invalid.");
    try { return (await requestJson<{ role: CommunityRole }>(await configuredOrigin(), `/v1/community/roles/${encodeURIComponent(value.roleId)}`, { method: "PATCH", body: JSON.stringify({ ...update, ...(update.name ? { name: update.name.trim() } : {}) }) })).role; }
    catch (error: unknown) { return apiFailure(error, "Role could not be updated."); }
  });
  ipcMain.handle("community:delete-role", async (event, roleId: unknown): Promise<{ ok: true } | AuthError> => {
    if (!isTrustedIpcEvent(event)) return authError("AUTHENTICATION_FAILED", "Untrusted desktop request.");
    if (!validOpaqueId(roleId)) return authError("AUTHENTICATION_FAILED", "Role selection is invalid.");
    try { await requestJson<void>(await configuredOrigin(), `/v1/community/roles/${encodeURIComponent(roleId)}`, { method: "DELETE" }); return { ok: true }; }
    catch (error: unknown) { return apiFailure(error, "Role could not be deleted."); }
  });
  ipcMain.handle("community:assign-member-role", async (event, input: unknown): Promise<{ ok: true } | AuthError> => {
    if (!isTrustedIpcEvent(event)) return authError("AUTHENTICATION_FAILED", "Untrusted desktop request.");
    const value = input as { userId?: unknown; roleId?: unknown } | null;
    if (!value || !validOpaqueId(value.userId) || !validOpaqueId(value.roleId)) return authError("AUTHENTICATION_FAILED", "Member role selection is invalid.");
    try { await requestJson<void>(await configuredOrigin(), `/v1/community/members/${encodeURIComponent(value.userId)}/roles/${encodeURIComponent(value.roleId)}`, { method: "PUT", body: "{}" }); return { ok: true }; }
    catch (error: unknown) { return apiFailure(error, "Role could not be assigned."); }
  });
  ipcMain.handle("community:remove-member-role", async (event, input: unknown): Promise<{ ok: true } | AuthError> => {
    if (!isTrustedIpcEvent(event)) return authError("AUTHENTICATION_FAILED", "Untrusted desktop request.");
    const value = input as { userId?: unknown; roleId?: unknown } | null;
    if (!value || !validOpaqueId(value.userId) || !validOpaqueId(value.roleId)) return authError("AUTHENTICATION_FAILED", "Member role selection is invalid.");
    try { await requestJson<void>(await configuredOrigin(), `/v1/community/members/${encodeURIComponent(value.userId)}/roles/${encodeURIComponent(value.roleId)}`, { method: "DELETE" }); return { ok: true }; }
    catch (error: unknown) { return apiFailure(error, "Role could not be removed."); }
  });
  ipcMain.handle("community:reset-member-password", async (event, input: unknown): Promise<{ ok: true } | AuthError> => {
    if (!isTrustedIpcEvent(event)) return authError("AUTHENTICATION_FAILED", "Untrusted desktop request.");
    const value = input as { userId?: unknown; newPassword?: unknown } | null;
    if (!value || !validOpaqueId(value.userId) || typeof value.newPassword !== "string" || value.newPassword.length < 12 || value.newPassword.length > 1024) {
      return authError("AUTHENTICATION_FAILED", "The member or replacement password is invalid.");
    }
    try {
      await requestJson<void>(await configuredOrigin(), `/v1/community/members/${encodeURIComponent(value.userId)}/password-reset`, { method: "POST", body: JSON.stringify({ newPassword: value.newPassword }) });
      return { ok: true };
    }
    catch (error: unknown) { return apiFailure(error, "The member password could not be reset."); }
  });
  ipcMain.handle("community:deactivate-member", async (event, userId: unknown): Promise<{ ok: true } | AuthError> => {
    if (!isTrustedIpcEvent(event)) return authError("AUTHENTICATION_FAILED", "Untrusted desktop request.");
    if (!validOpaqueId(userId)) return authError("AUTHENTICATION_FAILED", "Member selection is invalid.");
    try {
      await requestJson<void>(await configuredOrigin(), `/v1/community/members/${encodeURIComponent(userId)}/deactivate`, { method: "POST", body: "{}" });
      return { ok: true };
    }
    catch (error: unknown) { return apiFailure(error, "The member account could not be deactivated."); }
  });
  ipcMain.handle("community:clear-member-voice-restrictions", async (event, userId: unknown): Promise<{ ok: true; cleared: number } | AuthError> => {
    if (!isTrustedIpcEvent(event)) return authError("AUTHENTICATION_FAILED", "Untrusted desktop request.");
    if (!validOpaqueId(userId)) return authError("AUTHENTICATION_FAILED", "Member selection is invalid.");
    try {
      const result = await requestJson<{ ok: true; cleared?: number }>(await configuredOrigin(), `/v1/community/members/${encodeURIComponent(userId)}/voice-restrictions`, { method: "DELETE" });
      return { ok: true, cleared: Number.isInteger(result.cleared) && Number(result.cleared) >= 0 ? Number(result.cleared) : 0 };
    }
    catch (error: unknown) { return apiFailure(error, "The member voice restrictions could not be cleared."); }
  });
  ipcMain.handle("profile:remove-avatar", async (event): Promise<UserProfile | AuthError> => {
    if (!isTrustedIpcEvent(event)) return authError("AUTHENTICATION_FAILED", "Untrusted desktop request.");
    try {
      await requestJson<void>(await configuredOrigin(), "/v1/users/me/avatar", { method: "DELETE" });
      return { userId: currentState.user?.id ?? "me", displayName: currentState.user?.displayName ?? "" };
    }
    catch (error: unknown) { return apiFailure(error, "Avatar could not be removed."); }
  });
  ipcMain.handle("community:get-emotes", async (event): Promise<{ emotes: CommunityEmote[] } | AuthError> => {
    if (!isTrustedIpcEvent(event)) return authError("AUTHENTICATION_FAILED", "Untrusted desktop request.");
    try {
      const response = await requestJson<{ emotes: unknown[] }>(await configuredOrigin(), "/v1/community/emotes");
      return { emotes: response.emotes.map(normalizeCommunityEmote) };
    }
    catch (error: unknown) { return apiFailure(error, "Community emotes could not be loaded."); }
  });
  ipcMain.handle("community:delete-emote", async (event, emoteId: unknown): Promise<{ ok: true } | AuthError> => {
    if (!isTrustedIpcEvent(event)) return authError("AUTHENTICATION_FAILED", "Untrusted desktop request.");
    if (!validOpaqueId(emoteId)) return authError("AUTHENTICATION_FAILED", "Emote selection is invalid.");
    try { await requestJson<void>(await configuredOrigin(), `/v1/community/emotes/${encodeURIComponent(emoteId)}`, { method: "DELETE" }); return { ok: true }; }
    catch (error: unknown) { return apiFailure(error, "Community emote could not be deleted."); }
  });
  ipcMain.handle("profile:upload-avatar", async (event, input: unknown): Promise<{ avatar: MediaAssetReference } | AuthError> => {
    if (!isTrustedIpcEvent(event)) return authError("AUTHENTICATION_FAILED", "Untrusted desktop request.");
    const value = validateBinaryMediaInput(input, 8 * 1024 * 1024);
    if (!value || !["image/jpeg", "image/png", "image/webp"].includes(value.mimeType.toLowerCase())) return authError("AUTHENTICATION_FAILED", "Avatar must be a JPEG, PNG, or WebP image up to 8 MiB.");
    try {
      const media = await uploadInlineMedia("avatar", value);
      const response = await requestJson<{ avatar: unknown }>(await configuredOrigin(), "/v1/users/me/avatar", { method: "PUT", body: JSON.stringify({ mediaId: media.assetId }) });
      return { avatar: normalizeMediaReference(response.avatar) };
    } catch (error: unknown) { return apiFailure(error, "Avatar could not be uploaded."); }
  });
  ipcMain.handle("community:upload-emote", async (event, input: unknown): Promise<CommunityEmote | AuthError> => {
    if (!isTrustedIpcEvent(event)) return authError("AUTHENTICATION_FAILED", "Untrusted desktop request.");
    const value = validateBinaryMediaInput(input, 4 * 1024 * 1024);
    if (!value || !/^[A-Za-z0-9_]{2,48}$/.test(value.name) || !["image/jpeg", "image/png", "image/webp", "image/gif"].includes(value.mimeType.toLowerCase())) return authError("AUTHENTICATION_FAILED", "Emote details are invalid.");
    try {
      const media = await uploadInlineMedia("emote", value);
      const response = await requestJson<{ emote: unknown }>(await configuredOrigin(), "/v1/community/emotes", { method: "POST", body: JSON.stringify({ name: value.name, mediaId: media.assetId }) });
      return normalizeCommunityEmote(response.emote);
    } catch (error: unknown) { return apiFailure(error, "Community emote could not be uploaded."); }
  });
  ipcMain.handle("media:choose-and-upload", async (event): Promise<MediaAssetReference | MediaSelectionCanceled | AuthError> => {
    if (!isTrustedIpcEvent(event)) return authError("AUTHENTICATION_FAILED", "Untrusted desktop request.");
    if (nativeMediaSelectionInFlight) return authError("SERVER_UNAVAILABLE", "An attachment picker is already open.");
    nativeMediaSelectionInFlight = true;
    try { return await chooseAndUploadMedia(); }
    catch (error: unknown) { return apiFailure(error, "Media could not be selected or uploaded."); }
    finally { nativeMediaSelectionInFlight = false; }
  });
  ipcMain.handle("media:get-image-data", async (event, assetId: unknown): Promise<MediaImageData | AuthError> => {
    if (!isTrustedIpcEvent(event)) return authError("AUTHENTICATION_FAILED", "Untrusted desktop request.");
    if (!validOpaqueId(assetId)) return authError("AUTHENTICATION_FAILED", "Image selection is invalid.");
    try { return await fetchImageData(assetId); }
    catch (error: unknown) { return apiFailure(error, "Image could not be loaded."); }
  });
  ipcMain.handle("chat:add-emote-reaction", async (event, input: unknown): Promise<{ ok: true } | AuthError> => {
    if (!isTrustedIpcEvent(event)) return authError("AUTHENTICATION_FAILED", "Untrusted desktop request.");
    const value = input as { channelId?: unknown; messageId?: unknown; emoteId?: unknown } | null;
    if (!value || !validOpaqueId(value.channelId) || !validOpaqueId(value.messageId) || !validOpaqueId(value.emoteId)) return authError("AUTHENTICATION_FAILED", "Reaction is invalid.");
    try { await requestJson<void>(await configuredOrigin(), `/v1/channels/${encodeURIComponent(value.channelId)}/messages/${encodeURIComponent(value.messageId)}/reactions`, { method: "POST", body: JSON.stringify({ emoteId: value.emoteId }) }); return { ok: true }; }
    catch (error: unknown) { return apiFailure(error, "Reaction could not be added."); }
  });
  ipcMain.handle("chat:remove-emote-reaction", async (event, input: unknown): Promise<{ ok: true } | AuthError> => {
    if (!isTrustedIpcEvent(event)) return authError("AUTHENTICATION_FAILED", "Untrusted desktop request.");
    const value = input as { channelId?: unknown; messageId?: unknown; emoteId?: unknown } | null;
    if (!value || !validOpaqueId(value.channelId) || !validOpaqueId(value.messageId) || !validOpaqueId(value.emoteId)) return authError("AUTHENTICATION_FAILED", "Reaction is invalid.");
    try { await requestJson<void>(await configuredOrigin(), `/v1/channels/${encodeURIComponent(value.channelId)}/messages/${encodeURIComponent(value.messageId)}/reactions`, { method: "DELETE", body: JSON.stringify({ emoteId: value.emoteId }) }); return { ok: true }; }
    catch (error: unknown) { return apiFailure(error, "Reaction could not be removed."); }
  });
  ipcMain.handle("chat:get-key", (): Promise<string> => loadOrCreateChatKey());
  ipcMain.handle("chat:get-messages", async (_event, input: unknown): Promise<MessagesResponse | AuthError> => {
    const channelId = typeof input === "string" ? input : input && typeof input === "object" && typeof (input as { channelId?: unknown }).channelId === "string" ? (input as { channelId: string }).channelId : "";
    const before = input && typeof input === "object" && typeof (input as { before?: unknown }).before === "string" ? (input as { before: string }).before : undefined;
    if (!channelId.trim()) return authError("AUTHENTICATION_FAILED", "Select a text channel first.");
    try {
      const query = new URLSearchParams({ limit: "100", ...(before ? { before } : {}) });
      return normalizeMessagesResponse(await requestJson<MessagesResponse>(await configuredOrigin(), `/v1/channels/${encodeURIComponent(channelId.trim())}/messages?${query}`));
    } catch (error: unknown) {
      return authError(error instanceof Error && error.name === "Unauthorized" ? "AUTHENTICATION_FAILED" : error instanceof Error && error.message.includes("Configure") ? "NO_SERVER_CONFIGURED" : "SERVER_UNAVAILABLE", error instanceof Error ? error.message : "Messages could not be loaded.");
    }
  });
  ipcMain.handle("chat:get-message", async (event, input: unknown): Promise<ChatMessage | AuthError> => {
    if (!isTrustedIpcEvent(event) || !input || typeof input !== "object") return authError("AUTHENTICATION_FAILED", "Message selection is invalid.");
    const value = input as { channelId?: unknown; messageId?: unknown };
    if (!validOpaqueId(value.channelId) || !validOpaqueId(value.messageId)) return authError("AUTHENTICATION_FAILED", "Message selection is invalid.");
    try {
      return normalizeChatMessage(await requestJson<ChatMessage>(await configuredOrigin(), `/v1/channels/${encodeURIComponent(value.channelId)}/messages/${encodeURIComponent(value.messageId)}`));
    } catch (error: unknown) { return apiFailure(error, "Message could not be loaded."); }
  });
  ipcMain.handle("community:get-shared-files", async (event, before: unknown): Promise<SharedFilesResponse | AuthError> => {
    if (!isTrustedIpcEvent(event) || (before !== undefined && typeof before !== "string")) return authError("AUTHENTICATION_FAILED", "File cursor is invalid.");
    try {
      const query = new URLSearchParams({ limit: "50", ...(typeof before === "string" && before ? { before } : {}) });
      const result = await requestJson<{ files: unknown[]; nextCursor?: string }>(await configuredOrigin(), `/v1/community/files?${query}`);
      if (!result || !Array.isArray(result.files)) throw new Error("The FreeCord server returned an invalid file list.");
      return {
        files: result.files.flatMap((unknownFile) => {
          if (!unknownFile || typeof unknownFile !== "object") return [];
          const file = unknownFile as Record<string, unknown>;
          let media: MediaAssetReference;
          try { media = normalizeMediaReference(file.media); } catch { return []; }
          if (!validOpaqueId(file.messageId) || !validOpaqueId(file.channelId) || !validOpaqueId(file.authorId)
            || typeof file.channelName !== "string" || typeof file.authorDisplayName !== "string"
            || !Number.isSafeInteger(file.byteSize) || Number(file.byteSize) < 0
            || !Number.isSafeInteger(file.position) || Number(file.position) < 0 || typeof file.sharedAt !== "string" || Number.isNaN(Date.parse(file.sharedAt))) return [];
          return [{
            mediaId: media.assetId,
            messageId: file.messageId,
            channelId: file.channelId,
            channelName: file.channelName.slice(0, 100),
            authorId: file.authorId,
            authorDisplayName: file.authorDisplayName.slice(0, 100),
            contentType: (media.contentType ?? "application/octet-stream").slice(0, 160),
            byteSize: Number(file.byteSize),
            encrypted: file.encrypted === true,
            position: Number(file.position),
            sharedAt: new Date(file.sharedAt).toISOString(),
          }];
        }),
        ...(typeof result.nextCursor === "string" ? { nextCursor: result.nextCursor } : {}),
      };
    } catch (error: unknown) { return apiFailure(error, "Shared files could not be loaded."); }
  });
  ipcMain.handle("community:get-audit-log", async (event, before: unknown): Promise<AuditLogResponse | AuthError> => {
    if (!isTrustedIpcEvent(event) || (before !== undefined && typeof before !== "string")) return authError("AUTHENTICATION_FAILED", "Audit cursor is invalid.");
    try {
      const query = new URLSearchParams({ limit: "50", ...(typeof before === "string" && before ? { before } : {}) });
      const result = await requestJson<AuditLogResponse>(await configuredOrigin(), `/v1/community/audit-log?${query}`);
      if (!result || !Array.isArray(result.events)) throw new Error("The FreeCord server returned an invalid audit log.");
      return {
        events: result.events.flatMap((entry) => {
          if (!entry || !validOpaqueId(entry.id) || typeof entry.action !== "string" || entry.action.length > 100
            || typeof entry.createdAt !== "string" || Number.isNaN(Date.parse(entry.createdAt))
            || !entry.metadata || typeof entry.metadata !== "object" || Array.isArray(entry.metadata)) return [];
          return [{ ...entry, action: entry.action.slice(0, 100), createdAt: new Date(entry.createdAt).toISOString() }];
        }),
        ...(typeof result.nextCursor === "string" ? { nextCursor: result.nextCursor } : {}),
      };
    } catch (error: unknown) { return apiFailure(error, "Audit log could not be loaded."); }
  });
  ipcMain.handle("chat:send-message", async (event, input: unknown): Promise<ChatMessage | AuthError> => {
    if (!isTrustedIpcEvent(event)) return authError("AUTHENTICATION_FAILED", "Untrusted desktop request.");
    if (!input || typeof input !== "object" || typeof (input as { channelId?: unknown }).channelId !== "string" || typeof (input as { ciphertext?: unknown }).ciphertext !== "string" || typeof (input as { nonce?: unknown }).nonce !== "string") return authError("AUTHENTICATION_FAILED", "Encrypted message payload is invalid.");
    const channelId = (input as { channelId: string }).channelId.trim();
    const ciphertext = (input as { ciphertext: string }).ciphertext;
    const nonce = (input as { nonce: string }).nonce;
    const attachmentIds = (input as { attachmentIds?: unknown }).attachmentIds;
    if (!channelId || !ciphertext || ciphertext.length > 750000 || nonce.length > 100
      || (attachmentIds !== undefined && (!Array.isArray(attachmentIds) || attachmentIds.length > 10 || !attachmentIds.every(validOpaqueId)))) return authError("AUTHENTICATION_FAILED", "Encrypted message payload is invalid.");
    try {
      return normalizeChatMessage(await requestJson<ChatMessage>(await configuredOrigin(), `/v1/channels/${encodeURIComponent(channelId)}/messages`, { method: "POST", body: JSON.stringify({ ciphertext, nonce, ...(attachmentIds?.length ? { attachmentIds } : {}) }) }));
    } catch (error: unknown) {
      return authError(error instanceof Error && error.name === "Unauthorized" ? "AUTHENTICATION_FAILED" : error instanceof Error && error.message.includes("Configure") ? "NO_SERVER_CONFIGURED" : "SERVER_UNAVAILABLE", error instanceof Error ? error.message : "Message could not be sent.");
    }
  });
  ipcMain.handle("chat:edit-message", async (_event, input: unknown): Promise<{ ok: true } | AuthError> => {
    if (!input || typeof input !== "object") return authError("AUTHENTICATION_FAILED", "Encrypted message payload is invalid.");
    const value = input as { channelId?: unknown; messageId?: unknown; ciphertext?: unknown; nonce?: unknown };
    if (typeof value.channelId !== "string" || typeof value.messageId !== "string" || typeof value.ciphertext !== "string" || typeof value.nonce !== "string" || !value.channelId.trim() || !value.messageId.trim() || value.ciphertext.length < 1 || value.ciphertext.length > 750000 || value.nonce.length < 1 || value.nonce.length > 100) return authError("AUTHENTICATION_FAILED", "Encrypted message payload is invalid.");
    try {
      await requestJson<{ ok: true }>(await configuredOrigin(), `/v1/channels/${encodeURIComponent(value.channelId.trim())}/messages/${encodeURIComponent(value.messageId.trim())}`, { method: "PATCH", body: JSON.stringify({ ciphertext: value.ciphertext, nonce: value.nonce }) });
      return { ok: true };
    } catch (error: unknown) { return authError(error instanceof Error && error.name === "Unauthorized" ? "AUTHENTICATION_FAILED" : "SERVER_UNAVAILABLE", error instanceof Error ? error.message : "Message could not be edited."); }
  });
  ipcMain.handle("chat:delete-message", async (_event, input: unknown): Promise<{ id: string; deletedAt: string } | AuthError> => {
    if (!input || typeof input !== "object") return authError("AUTHENTICATION_FAILED", "Message selection is invalid.");
    const value = input as { channelId?: unknown; messageId?: unknown };
    if (typeof value.channelId !== "string" || typeof value.messageId !== "string" || !value.channelId.trim() || !value.messageId.trim()) return authError("AUTHENTICATION_FAILED", "Message selection is invalid.");
    try { return await requestJson<{ id: string; deletedAt: string }>(await configuredOrigin(), `/v1/channels/${encodeURIComponent(value.channelId.trim())}/messages/${encodeURIComponent(value.messageId.trim())}`, { method: "DELETE" }); }
    catch (error: unknown) { return authError(error instanceof Error && error.name === "Unauthorized" ? "AUTHENTICATION_FAILED" : "SERVER_UNAVAILABLE", error instanceof Error ? error.message : "Message could not be deleted."); }
  });
  ipcMain.handle("chat:add-reaction", async (event, input: unknown): Promise<{ ok: true } | AuthError> => {
    if (!isTrustedIpcEvent(event)) return authError("AUTHENTICATION_FAILED", "Untrusted desktop request.");
    if (!input || typeof input !== "object") return authError("AUTHENTICATION_FAILED", "Reaction is invalid.");
    const value = input as { channelId?: unknown; messageId?: unknown; target?: unknown; emoji?: unknown };
    const target = parseReactionTarget(value.target ?? value.emoji);
    if (typeof value.channelId !== "string" || typeof value.messageId !== "string" || !value.channelId.trim() || !value.messageId.trim() || !target) return authError("AUTHENTICATION_FAILED", "Reaction is invalid.");
    try { await requestJson<{ ok: true }>(await configuredOrigin(), `/v1/channels/${encodeURIComponent(value.channelId.trim())}/messages/${encodeURIComponent(value.messageId.trim())}/reactions`, { method: "POST", body: JSON.stringify(reactionRequestBody(target)) }); return { ok: true }; }
    catch (error: unknown) { return authError(error instanceof Error && error.name === "Unauthorized" ? "AUTHENTICATION_FAILED" : "SERVER_UNAVAILABLE", error instanceof Error ? error.message : "Reaction could not be added."); }
  });
  ipcMain.handle("chat:remove-reaction", async (event, input: unknown): Promise<{ ok: true } | AuthError> => {
    if (!isTrustedIpcEvent(event)) return authError("AUTHENTICATION_FAILED", "Untrusted desktop request.");
    if (!input || typeof input !== "object") return authError("AUTHENTICATION_FAILED", "Reaction is invalid.");
    const value = input as { channelId?: unknown; messageId?: unknown; target?: unknown; emoji?: unknown };
    const target = parseReactionTarget(value.target ?? value.emoji);
    if (typeof value.channelId !== "string" || typeof value.messageId !== "string" || !value.channelId.trim() || !value.messageId.trim() || !target) return authError("AUTHENTICATION_FAILED", "Reaction is invalid.");
    const endpoint = `/v1/channels/${encodeURIComponent(value.channelId.trim())}/messages/${encodeURIComponent(value.messageId.trim())}/reactions`;
    try { await requestJson<{ ok: true }>(await configuredOrigin(), target.kind === "unicode" ? `${endpoint}/${encodeURIComponent(target.value)}` : endpoint, { method: "DELETE", ...(target.kind === "emote" ? { body: JSON.stringify(reactionRequestBody(target)) } : {}) }); return { ok: true }; }
    catch (error: unknown) { return authError(error instanceof Error && error.name === "Unauthorized" ? "AUTHENTICATION_FAILED" : "SERVER_UNAVAILABLE", error instanceof Error ? error.message : "Reaction could not be removed."); }
  });
  ipcMain.handle("voice:issue-token", async (_event, channelId: unknown): Promise<VoiceTokenResponse | AuthError> => {
    if (typeof channelId !== "string" || !channelId.trim() || channelId.length > 256) {
      return authError("AUTHENTICATION_FAILED", "Enter a valid voice channel ID.");
    }
    try {
      return await requestJson<VoiceTokenResponse>(await configuredOrigin(), `/v1/channels/${encodeURIComponent(channelId.trim())}/voice-token`, { method: "POST" });
    } catch (error: unknown) {
      return authError(error instanceof Error && error.name === "Unauthorized" ? "AUTHENTICATION_FAILED" : error instanceof Error && error.message.includes("Configure") ? "NO_SERVER_CONFIGURED" : "SERVER_UNAVAILABLE", error instanceof Error ? error.message : "Voice token request failed.");
    }
  });
  ipcMain.handle("voice:moderate-mute", async (event, input: unknown): Promise<{ ok: true } | AuthError> => {
    if (!isTrustedIpcEvent(event)) return authError("AUTHENTICATION_FAILED", "Untrusted desktop request.");
    const value = input as { channelId?: unknown; userId?: unknown; muted?: unknown } | null;
    if (!value || !validOpaqueId(value.channelId) || !validOpaqueId(value.userId) || (value.muted !== undefined && typeof value.muted !== "boolean")) return authError("AUTHENTICATION_FAILED", "Voice moderation request is invalid.");
    const muted = value.muted ?? true;
    const endpoint = `/v1/channels/${encodeURIComponent(value.channelId)}/voice/participants/${encodeURIComponent(value.userId)}/mute`;
    try { await requestJson<void>(await configuredOrigin(), endpoint, { method: muted ? "POST" : "DELETE", ...(muted ? { body: "{}" } : {}) }); return { ok: true }; }
    catch (error: unknown) { return apiFailure(error, "Participant mute could not be changed."); }
  });
  ipcMain.handle("voice:moderate-disconnect", async (event, input: unknown): Promise<{ ok: true } | AuthError> => {
    if (!isTrustedIpcEvent(event)) return authError("AUTHENTICATION_FAILED", "Untrusted desktop request.");
    const value = input as { channelId?: unknown; userId?: unknown } | null;
    if (!value || !validOpaqueId(value.channelId) || !validOpaqueId(value.userId)) return authError("AUTHENTICATION_FAILED", "Voice moderation request is invalid.");
    try { await requestJson<void>(await configuredOrigin(), `/v1/channels/${encodeURIComponent(value.channelId)}/voice/participants/${encodeURIComponent(value.userId)}/disconnect`, { method: "POST", body: "{}" }); return { ok: true }; }
    catch (error: unknown) { return apiFailure(error, "Participant could not be disconnected."); }
  });
  ipcMain.handle("voice:moderate-move", async (event, input: unknown): Promise<{ ok: true } | AuthError> => {
    if (!isTrustedIpcEvent(event)) return authError("AUTHENTICATION_FAILED", "Untrusted desktop request.");
    const value = input as { channelId?: unknown; userId?: unknown; destinationChannelId?: unknown } | null;
    if (!value || !validOpaqueId(value.channelId) || !validOpaqueId(value.userId) || !validOpaqueId(value.destinationChannelId) || value.channelId === value.destinationChannelId) return authError("AUTHENTICATION_FAILED", "Voice move request is invalid.");
    try { await requestJson<void>(await configuredOrigin(), `/v1/channels/${encodeURIComponent(value.channelId)}/voice/participants/${encodeURIComponent(value.userId)}/move`, { method: "POST", body: JSON.stringify({ destinationChannelId: value.destinationChannelId }) }); return { ok: true }; }
    catch (error: unknown) { return apiFailure(error, "Participant could not be moved."); }
  });
  ipcMain.handle("files:get-info", async (event): Promise<FilesSurfaceState> => {
    if (!isTrustedIpcEvent(event)) return { ok: true, visible: false, origin: filesOrigin };
    return { ok: true, visible: filesSurfaceVisible, origin: filesOrigin };
  });
  ipcMain.handle("files:show", async (event, input: unknown): Promise<FilesSurfaceState | AuthError> => {
    if (!isTrustedIpcEvent(event)) return authError("AUTHENTICATION_FAILED", "Untrusted desktop request.");
    if (currentState.status !== "authenticated") return authError("AUTHENTICATION_FAILED", "Sign in before opening Copyparty.");
    if (!input || typeof input !== "object") return authError("AUTHENTICATION_FAILED", "Copyparty panel bounds are invalid.");
    try { return await showFilesSurface(input as FilesSurfaceRect); }
    catch (error: unknown) { return authError("SERVER_UNAVAILABLE", error instanceof Error ? error.message : "Copyparty could not be opened."); }
  });
  ipcMain.handle("files:hide", async (event): Promise<FilesSurfaceState> => {
    if (!isTrustedIpcEvent(event)) return { ok: true, visible: false, origin: filesOrigin };
    return hideFilesSurface();
  });
  ipcMain.handle("files:update-bounds", async (event, input: unknown): Promise<void> => {
    if (!isTrustedIpcEvent(event) || !filesSurfaceVisible || !filesView || !input || typeof input !== "object") return;
    const bounds = clampFilesRect(input as FilesSurfaceRect);
    if (bounds) filesView.setBounds(bounds);
  });
  ipcMain.handle("files:hide-void", async (event): Promise<void> => {
    if (isTrustedIpcEvent(event)) hideFilesSurface();
  });

  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

function callbackPermissionCheck(permission: string, url: string): boolean {
  return (permission === "media" || permission === "display-capture") && isAllowedNavigation(url);
}

app.on("window-all-closed", () => {
  stopRealtimeConnection();
  if (process.platform !== "darwin") app.quit();
});
