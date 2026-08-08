import { RoomServiceClient, TrackSource, type ParticipantInfo } from "livekit-server-sdk";
import type { DatabaseBoundary } from "./database.js";
import { requirePermission } from "./authorization.js";
import { writeAuditEvent } from "./audit-log.js";

type Row = Record<string, unknown>;

export interface RoomAdminBoundary {
  getParticipant(room: string, identity: string): Promise<ParticipantInfo>;
  mutePublishedTrack(room: string, identity: string, trackSid: string, muted: boolean): Promise<unknown>;
  updateParticipant(room: string, identity: string, options: { permission: NonNullable<ParticipantInfo["permission"]> }): Promise<ParticipantInfo>;
  removeParticipant(room: string, identity: string, options?: { revokeTokenTs?: bigint }): Promise<void>;
}

export function createRoomAdmin(url: string | undefined, apiKey: string | undefined, apiSecret: string | undefined): RoomAdminBoundary | undefined {
  return url && apiKey && apiSecret ? new RoomServiceClient(url, apiKey, apiSecret) : undefined;
}

async function resolveVoiceContext(database: DatabaseBoundary, actorId: string, channelId: string, targetId: string, permission: string) {
  const access = await requirePermission(database, actorId, permission);
  if (actorId === targetId) throw new Error("bad_request");
  await database.query(`SELECT user_id FROM community_members WHERE community_id = $1 AND user_id IN ($2, $3) ORDER BY user_id FOR UPDATE`, [access.communityId, actorId, targetId]);
  await database.query(
    `SELECT mr.role_id FROM member_roles mr
      WHERE mr.community_id = $1 AND mr.user_id IN ($2, $3)
      ORDER BY mr.user_id, mr.role_id FOR UPDATE`,
    [access.communityId, actorId, targetId],
  );
  const result = await database.query<Row>(
    `SELECT v.livekit_room_id,
            EXISTS (SELECT 1 FROM auth_bootstrap ab WHERE ab.initialized_user_id = target.user_id) AS target_is_owner,
            COALESCE((SELECT MAX(r.position) FROM member_roles mr JOIN roles r ON r.id = mr.role_id
                       WHERE mr.community_id = target.community_id AND mr.user_id = target.user_id), 0)::int AS target_highest_position
       FROM channels c
       JOIN voice_channel_bindings v ON v.channel_id = c.id AND v.community_id = c.community_id
       JOIN community_members target ON target.community_id = c.community_id AND target.user_id = $3
      WHERE c.id = $1 AND c.community_id = $2 AND c.type = 'voice' AND NOT c.is_archived
        AND NOT (target.is_banned AND (target.banned_until IS NULL OR target.banned_until > now()))`,
    [channelId, access.communityId, targetId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("not_found");
  if (row.target_is_owner === true || (!access.isOwner && access.highestPosition <= Number(row.target_highest_position))) throw new Error("forbidden");
  return { ...access, room: String(row.livekit_room_id) };
}

function publishingPermission(participant: ParticipantInfo, muted: boolean): NonNullable<ParticipantInfo["permission"]> {
  const current = participant.permission;
  const sources = [TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO];
  if (!muted) sources.push(TrackSource.MICROPHONE);
  return {
    canSubscribe: current?.canSubscribe ?? true,
    canPublish: current?.canPublish ?? true,
    canPublishData: current?.canPublishData ?? true,
    canPublishSources: sources,
    hidden: current?.hidden ?? false,
    recorder: current?.recorder ?? false,
    canUpdateMetadata: current?.canUpdateMetadata ?? true,
    agent: current?.agent ?? false,
    canSubscribeMetrics: current?.canSubscribeMetrics ?? false,
    canManageAgentSession: current?.canManageAgentSession ?? false,
  } as NonNullable<ParticipantInfo["permission"]>;
}

async function audit(database: DatabaseBoundary, input: {
  communityId: string;
  actorId: string;
  targetId: string;
  sourceChannelId: string;
  destinationChannelId?: string;
  action: "mute" | "unmute_allowed" | "disconnect" | "move_requested";
  succeeded: boolean;
  result?: string;
}): Promise<void> {
  await database.query(
    `INSERT INTO voice_moderation_actions
      (community_id, actor_user_id, target_user_id, source_channel_id, destination_channel_id, action, succeeded, result)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [input.communityId, input.actorId, input.targetId, input.sourceChannelId, input.destinationChannelId ?? null, input.action, input.succeeded, input.result?.slice(0, 500) ?? null],
  );
}

export class VoiceModerationService {
  constructor(
    private readonly database: DatabaseBoundary,
    private readonly rooms?: RoomAdminBoundary,
    private readonly tokenTtlSeconds = 60,
  ) {}

  async forceMute(actorId: string, channelId: string, targetId: string, muted: boolean, reason?: string) {
    if (!this.rooms) throw new Error("livekit_admin_not_configured");
    if (!this.database.transaction) throw new Error("database_transaction_not_configured");
    const rooms = this.rooms;
    const action = muted ? "mute" : "unmute_allowed" as const;
    let context: Awaited<ReturnType<typeof resolveVoiceContext>> | undefined;
    try {
      return await this.database.transaction(async (transaction) => {
        context = await resolveVoiceContext(transaction, actorId, channelId, targetId, "voice.mute");
        const participant = await rooms.getParticipant(context.room, targetId);
        if (muted) {
          const microphone = participant.tracks.find((track) => track.source === TrackSource.MICROPHONE);
          if (microphone) await rooms.mutePublishedTrack(context.room, targetId, microphone.sid, true);
        }
        await rooms.updateParticipant(context.room, targetId, { permission: publishingPermission(participant, muted) });
        const reconnectBlockedUntil = muted
          ? new Date(Date.now() + (this.tokenTtlSeconds + 5) * 1000).toISOString()
          : null;
        await transaction.query(
          `INSERT INTO voice_participant_moderation
            (community_id, channel_id, user_id, microphone_forced_muted, reconnect_blocked_until, updated_by, reason, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, now())
           ON CONFLICT (channel_id, user_id) DO UPDATE
             SET microphone_forced_muted = EXCLUDED.microphone_forced_muted,
                 reconnect_blocked_until = EXCLUDED.reconnect_blocked_until,
                 updated_by = EXCLUDED.updated_by, reason = EXCLUDED.reason, updated_at = now()`,
          [context.communityId, channelId, targetId, muted, reconnectBlockedUntil, actorId, reason?.trim().slice(0, 500) || null],
        );
        // Self-hosted LiveKit cannot retroactively narrow every already-issued
        // token. Disconnect and block rejoin until the short token lifetime has
        // elapsed; subsequent tokens are issued without microphone publishing.
        if (muted) await rooms.removeParticipant(context.room, targetId, { revokeTokenTs: BigInt(Math.floor(Date.now() / 1000)) });
        await audit(transaction, { communityId: context.communityId, actorId, targetId, sourceChannelId: channelId, action, succeeded: true });
        await writeAuditEvent(transaction, {
          communityId: context.communityId,
          actorId,
          action: muted ? "voice.participant_muted" : "voice.participant_unmuted",
          targetType: "user",
          targetId,
          metadata: { channelId },
        });
        return { ok: true, muted, reconnectBlockedUntil };
      });
    } catch (error) {
      if (context) await audit(this.database, { communityId: context.communityId, actorId, targetId, sourceChannelId: channelId, action, succeeded: false, result: error instanceof Error ? error.message : "failed" }).catch(() => undefined);
      throw error;
    }
  }

  async disconnect(actorId: string, channelId: string, targetId: string, reason?: string) {
    if (!this.rooms) throw new Error("livekit_admin_not_configured");
    if (!this.database.transaction) throw new Error("database_transaction_not_configured");
    let context: Awaited<ReturnType<typeof resolveVoiceContext>> | undefined;
    try {
      return await this.database.transaction(async (transaction) => {
        context = await resolveVoiceContext(transaction, actorId, channelId, targetId, "voice.disconnect");
        const blockedUntil = new Date(Date.now() + 15_000).toISOString();
        await transaction.query(
          `INSERT INTO voice_participant_moderation
            (community_id, channel_id, user_id, reconnect_blocked_until, updated_by, reason, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, now())
           ON CONFLICT (channel_id, user_id) DO UPDATE
             SET reconnect_blocked_until = EXCLUDED.reconnect_blocked_until,
                 updated_by = EXCLUDED.updated_by, reason = EXCLUDED.reason, updated_at = now()`,
          [context.communityId, channelId, targetId, blockedUntil, actorId, reason?.trim().slice(0, 500) || null],
        );
        await this.rooms!.removeParticipant(context.room, targetId, { revokeTokenTs: BigInt(Math.floor(Date.now() / 1000)) });
        await audit(transaction, { communityId: context.communityId, actorId, targetId, sourceChannelId: channelId, action: "disconnect", succeeded: true });
        await writeAuditEvent(transaction, {
          communityId: context.communityId,
          actorId,
          action: "voice.participant_disconnected",
          targetType: "user",
          targetId,
          metadata: { channelId },
        });
        return { ok: true };
      });
    } catch (error) {
      if (context) await audit(this.database, { communityId: context.communityId, actorId, targetId, sourceChannelId: channelId, action: "disconnect", succeeded: false, result: error instanceof Error ? error.message : "failed" }).catch(() => undefined);
      throw error;
    }
  }

  async move(actorId: string, channelId: string, targetId: string, destinationChannelId: string) {
    if (!this.rooms) throw new Error("livekit_admin_not_configured");
    if (!this.database.transaction) throw new Error("database_transaction_not_configured");
    let context: Awaited<ReturnType<typeof resolveVoiceContext>> | undefined;
    try {
      return await this.database.transaction(async (transaction) => {
        context = await resolveVoiceContext(transaction, actorId, channelId, targetId, "voice.move");
        const destination = await transaction.query<Row>(
          `SELECT v.livekit_room_id FROM channels c
           JOIN voice_channel_bindings v ON v.channel_id = c.id AND v.community_id = c.community_id
           WHERE c.id = $1 AND c.community_id = $2 AND c.type = 'voice' AND NOT c.is_archived`,
          [destinationChannelId, context.communityId],
        );
        if (!destination.rows[0] || destinationChannelId === channelId) throw new Error("bad_request");
        // Native MoveParticipant is cloud-only. For self-hosting, force the
        // source disconnect and report that the target must reconnect itself.
        await this.rooms!.removeParticipant(context.room, targetId, { revokeTokenTs: BigInt(Math.floor(Date.now() / 1000)) });
        await audit(transaction, { communityId: context.communityId, actorId, targetId, sourceChannelId: channelId, destinationChannelId, action: "move_requested", succeeded: true });
        await writeAuditEvent(transaction, {
          communityId: context.communityId,
          actorId,
          action: "voice.participant_move_requested",
          targetType: "user",
          targetId,
          metadata: { sourceChannelId: channelId, destinationChannelId },
        });
        return { ok: true, destinationChannelId, reconnectRequired: true };
      });
    } catch (error) {
      if (context) await audit(this.database, { communityId: context.communityId, actorId, targetId, sourceChannelId: channelId, destinationChannelId, action: "move_requested", succeeded: false, result: error instanceof Error ? error.message : "failed" }).catch(() => undefined);
      throw error;
    }
  }
}
