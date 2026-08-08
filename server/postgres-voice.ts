import { AccessToken, TrackSource } from "livekit-server-sdk";
import type { DatabaseBoundary } from "./database.js";
import type { AuthenticatedUser, ChannelAuthorizer, LiveKitTokenIssuer, VoiceTokenResponse } from "./contracts.js";
import { requireChannelPermission, resolveChannelPermission } from "./authorization.js";

type Row = Record<string, unknown>;
const text = (value: unknown): string => String(value);

export class PostgresChannelAuthorizer implements ChannelAuthorizer {
  constructor(private readonly database: DatabaseBoundary) {}

  async authorizeVoiceJoin(user: AuthenticatedUser, channelId: string) {
    const connect = await requireChannelPermission(this.database, user.id, channelId, "voice.connect", "voice");
    const speak = await resolveChannelPermission(this.database, user.id, channelId, "voice.speak", "voice");
    const result = await this.database.query<Row>(
      `SELECT c.community_id, v.livekit_room_id,
              NOT EXISTS (SELECT 1 FROM voice_participant_moderation vpm
                            WHERE vpm.channel_id = c.id AND vpm.user_id = $2
                              AND vpm.microphone_forced_muted) AS microphone_allowed
       FROM channels c
       JOIN voice_channel_bindings v ON v.channel_id = c.id AND v.community_id = c.community_id
       JOIN community_members cm ON cm.community_id = c.community_id AND cm.user_id = $2
       JOIN users u ON u.id = cm.user_id AND u.is_active
       WHERE c.id = $1 AND c.type = 'voice' AND NOT c.is_archived
         AND NOT EXISTS (SELECT 1 FROM voice_participant_moderation vpm
                          WHERE vpm.channel_id = c.id AND vpm.user_id = $2
                            AND vpm.reconnect_blocked_until > now())
         AND NOT (cm.is_banned AND (cm.banned_until IS NULL OR cm.banned_until > now()))`,
      [channelId, user.id],
    );
    const row = result.rows[0];
    if (!row || String(row.community_id) !== connect.communityId) throw new Error("forbidden");
    return {
      communityId: text(row.community_id),
      livekitRoomName: text(row.livekit_room_id),
      canPublish: speak.allowed,
      canPublishMicrophone: speak.allowed && row.microphone_allowed === true,
      canSubscribe: true,
      canPublishData: speak.allowed,
    };
  }
}

export interface LiveKitConfig {
  apiKey: string;
  apiSecret: string;
  url: string;
  ttlSeconds: number;
}

export class OfficialLiveKitTokenIssuer implements LiveKitTokenIssuer {
  constructor(private readonly config: LiveKitConfig) {}

  async issue(input: Parameters<LiveKitTokenIssuer["issue"]>[0]): Promise<VoiceTokenResponse> {
    const token = new AccessToken(this.config.apiKey, this.config.apiSecret, {
      identity: input.user.id,
      name: input.user.displayName,
      ttl: this.config.ttlSeconds,
    });
    token.addGrant({
      room: input.livekitRoomName,
      roomJoin: true,
      canPublish: input.canPublish,
      ...(input.canPublish ? {
        canPublishSources: [
          ...(input.canPublishMicrophone ? [TrackSource.MICROPHONE] : []),
          TrackSource.SCREEN_SHARE,
          TrackSource.SCREEN_SHARE_AUDIO,
        ],
      } : {}),
      canSubscribe: input.canSubscribe,
      canPublishData: input.canPublishData,
    });
    const issued = await token.toJwt();
    return {
      token: issued,
      livekitUrl: this.config.url,
      expiresAt: new Date(Date.now() + this.config.ttlSeconds * 1000).toISOString(),
      participantIdentity: input.user.id,
      permissions: {
        // FreeCord <=0.6.2 starts the microphone whenever this legacy field is
        // true. Keep it microphone-specific while the JWT retains the broader
        // source-limited screen publication grant.
        canPublish: input.canPublishMicrophone,
        canPublishMicrophone: input.canPublishMicrophone,
        canSubscribe: input.canSubscribe,
        canPublishData: input.canPublishData,
      },
    };
  }
}
