/**
 * API-001 local adapter.
 *
 * This adapter is intentionally dependency-free and incomplete. It provides a
 * deterministic seam for desktop/API contract tests without pretending to be
 * production authentication or LiveKit infrastructure.
 */

import {
  AuthService,
  AuthenticatedUser,
  ChannelsResponse,
  CommunityResponse,
  CommunityService,
  HealthResponse,
  LoginRequest,
  LoginResponse,
  LiveKitTokenIssuer,
  LogoutRequest,
  RefreshRequest,
  RequestContext,
  SessionResponse,
  VoiceTokenRequest,
  VoiceTokenResponse,
  ChannelAuthorizer,
} from "./contracts.js";

export interface LocalApiDependencies {
  auth: AuthService;
  community: CommunityService;
  channelAuthorizer: ChannelAuthorizer;
  livekit: LiveKitTokenIssuer;
  version?: string;
  healthChecks?: {
    database: "not-configured" | "ok" | "error";
    livekit: "not-configured" | "ok" | "error";
  };
}

export interface LocalApi {
  health(): HealthResponse;
  auth: {
    login(input: LoginRequest, context?: RequestContext): Promise<LoginResponse>;
    register(input: import("./contracts.js").RegisterRequest, context?: RequestContext): Promise<LoginResponse>;
    refresh(input: RefreshRequest, context?: RequestContext): Promise<LoginResponse>;
    logout(input: LogoutRequest, context?: RequestContext): Promise<void>;
    session(context: RequestContext): Promise<SessionResponse>;
  };
  community: {
    get(context: RequestContext): Promise<CommunityResponse>;
    channels(context: RequestContext): Promise<ChannelsResponse>;
  };
  voice: {
    token(input: VoiceTokenRequest, context: RequestContext): Promise<VoiceTokenResponse>;
  };
}

function requireUser(context: RequestContext): AuthenticatedUser {
  if (!context.user) {
    throw new Error("unauthorized");
  }
  return context.user;
}

export function createLocalApi(dependencies: LocalApiDependencies): LocalApi {
  return {
    health: () => {
      const checks = {
        database: dependencies.healthChecks?.database ?? "not-configured",
        livekit: dependencies.healthChecks?.livekit ?? "not-configured",
      } as const;
      return {
        status: checks.database === "ok" && checks.livekit === "ok" ? "ok" : "degraded",
        service: "freecord-api",
        version: dependencies.version ?? "development",
        checks,
      };
    },
    auth: {
      login: (input, context = { requestId: "local" }) =>
        dependencies.auth.login(input, context),
      register: (input, context = { requestId: "local" }) =>
        dependencies.auth.register ? dependencies.auth.register(input, context) : Promise.reject(new Error("auth_not_configured")),
      refresh: (input, context = { requestId: "local" }) =>
        dependencies.auth.refresh(input, context),
      logout: (input, context = { requestId: "local" }) =>
        dependencies.auth.logout(input, context),
      session: (context) => dependencies.auth.getSession(context),
    },
    community: {
      get: (context) => {
        requireUser(context);
        return dependencies.community.getCommunity(context);
      },
      channels: (context) => {
        requireUser(context);
        return dependencies.community.listChannels(context);
      },
    },
    voice: {
      token: async (input, context) => {
        const user = requireUser(context);
        const authorization = await dependencies.channelAuthorizer.authorizeVoiceJoin(
          user,
          input.channelId,
        );

        // The room name is resolved server-side after authorization. The
        // caller cannot select or override a LiveKit room.
        return dependencies.livekit.issue({
          user,
          channelId: input.channelId,
          livekitRoomName: authorization.livekitRoomName,
          canPublish: authorization.canPublish,
          canPublishMicrophone: authorization.canPublishMicrophone,
          canSubscribe: authorization.canSubscribe,
          canPublishData: authorization.canPublishData,
        });
      },
    },
  };
}
