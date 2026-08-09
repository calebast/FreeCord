import { TrackSource, type ParticipantInfo } from "livekit-server-sdk";
import { resolveChannelPermission } from "./authorization.js";
import type { VoiceChannelPresence, VoicePresenceOccupant, VoicePresenceResponse } from "./contracts.js";
import type { DatabaseBoundary } from "./database.js";
import type { RoomPresenceBoundary } from "./voice-moderation.js";

interface VoiceRoomRow extends Record<string, unknown> {
  channel_id: string;
  livekit_room_id: string;
}

interface CachedRoom {
  participants: ParticipantInfo[];
  refreshedAt: number;
  successfulAt: number | undefined;
  stale: boolean;
  inFlight?: Promise<CachedRoom>;
}

const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function participantMetadata(participant: ParticipantInfo): { deafened?: boolean } {
  try {
    const value = participant.metadata ? JSON.parse(participant.metadata) as unknown : {};
    return value && typeof value === "object" && !Array.isArray(value) ? value as { deafened?: boolean } : {};
  } catch {
    return {};
  }
}

function occupant(participant: ParticipantInfo): VoicePresenceOccupant {
  const microphone = participant.tracks.find((track) => track.source === TrackSource.MICROPHONE);
  const screenSharing = participant.tracks.some((track) =>
    (track.source === TrackSource.SCREEN_SHARE || track.source === TrackSource.SCREEN_SHARE_AUDIO) && !track.muted,
  );
  return {
    userId: participant.identity,
    microphone: !microphone ? "not-published" : microphone.muted ? "muted" : "active",
    deafened: participantMetadata(participant).deafened === true,
    screenSharing,
  };
}

/**
 * Read-only, permission-filtered presence for voice channel rosters. This does
 * not join rooms and never exposes LiveKit room names, SIDs, or connection data.
 */
export class VoicePresenceService {
  private readonly cache = new Map<string, CachedRoom>();

  constructor(
    private readonly database: DatabaseBoundary,
    private readonly rooms?: RoomPresenceBoundary,
    private readonly cacheTtlMs = 3_000,
    private readonly staleRetentionMs = 10_000,
  ) {}

  private async refreshRoom(room: string): Promise<CachedRoom> {
    const existing = this.cache.get(room);
    if (existing?.inFlight) return existing.inFlight;
    if (existing && Date.now() - existing.refreshedAt < this.cacheTtlMs) return existing;

    const work = (async (): Promise<CachedRoom> => {
      try {
        const participants = this.rooms ? await this.rooms.listParticipants(room) : [];
        const now = Date.now();
        const fresh = { participants, refreshedAt: now, successfulAt: this.rooms ? now : undefined, stale: !this.rooms };
        this.cache.set(room, fresh);
        return fresh;
      } catch {
        const now = Date.now();
        const mayRetain = existing?.successfulAt !== undefined && now - existing.successfulAt <= this.staleRetentionMs;
        // Preserve a last-known roster only through a short outage. After the
        // retention window, fail closed so departed users cannot remain visible.
        const stale = { participants: mayRetain ? existing.participants : [], refreshedAt: now, successfulAt: existing?.successfulAt, stale: true };
        this.cache.set(room, stale);
        return stale;
      }
    })();
    this.cache.set(room, { participants: existing?.participants ?? [], refreshedAt: existing?.refreshedAt ?? 0, successfulAt: existing?.successfulAt, stale: existing?.stale ?? true, inFlight: work });
    return work;
  }

  async listForUser(userId: string): Promise<VoicePresenceResponse> {
    const result = await this.database.query<VoiceRoomRow>(
      `SELECT c.id AS channel_id, v.livekit_room_id
         FROM channels c
         JOIN community_members cm ON cm.community_id = c.community_id AND cm.user_id = $1
         JOIN voice_channel_bindings v ON v.channel_id = c.id AND v.community_id = c.community_id
        WHERE c.type = 'voice' AND NOT c.is_archived
          AND NOT (cm.is_banned AND (cm.banned_until IS NULL OR cm.banned_until > now()))
        ORDER BY c.position, c.created_at, c.id`,
      [userId],
    );
    const authorized: VoiceRoomRow[] = [];
    for (const row of result.rows) {
      const access = await resolveChannelPermission(this.database, userId, row.channel_id, "voice.connect", "voice");
      if (access.allowed) authorized.push(row);
    }

    const snapshots = await Promise.all(authorized.map(async (row) => ({ row, snapshot: await this.refreshRoom(row.livekit_room_id) })));
    const identities = [...new Set(snapshots.flatMap(({ snapshot }) => snapshot.participants.map((item) => item.identity).filter((identity) => USER_ID.test(identity))))];
    const activeUsers = new Set<string>();
    if (identities.length) {
      const active = await this.database.query<{ id: string }>(
        `SELECT u.id
           FROM users u
           JOIN community_members cm ON cm.user_id = u.id
          WHERE cm.community_id = (SELECT community_id FROM community_members WHERE user_id = $1 LIMIT 1)
            AND u.is_active AND NOT cm.is_banned AND u.id = ANY($2::uuid[])`,
        [userId, identities],
      );
      for (const row of active.rows) activeUsers.add(row.id);
    }

    const channels: VoiceChannelPresence[] = snapshots.map(({ row, snapshot }) => ({
      channelId: row.channel_id,
      occupants: snapshot.participants
        .filter((participant) => activeUsers.has(participant.identity))
        .map(occupant),
    }));
    return { observedAt: new Date().toISOString(), stale: snapshots.some(({ snapshot }) => snapshot.stale), channels };
  }
}
