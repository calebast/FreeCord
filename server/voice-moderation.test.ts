import test from "node:test";
import assert from "node:assert/strict";
import { TrackSource, type ParticipantInfo } from "livekit-server-sdk";
import type { DatabaseBoundary } from "./database.js";
import { VoiceModerationService, type RoomAdminBoundary } from "./voice-moderation.js";

test("force mute resolves the microphone SID server-side and records state", async () => {
  const sql: string[] = [];
  const database: DatabaseBoundary = {
    configured: true,
    query: async <T extends Record<string, unknown> = Record<string, unknown>>(text: string) => {
      sql.push(text);
      if (text.includes("FROM community_members cm") && text.includes("highest_position")) {
        return { rows: [{ community_id: "community-1", is_owner: false, highest_position: 50, permissions: ["voice.mute"] } as unknown as T] };
      }
      if (text.includes("FROM channels c") && text.includes("livekit_room_id")) {
        return { rows: [{ livekit_room_id: "room-1" } as unknown as T] };
      }
      return { rows: [] };
    },
    transaction: async <T>(work: (transaction: DatabaseBoundary) => Promise<T>) => work(database),
    close: async () => {},
  };
  let mutedTrack = "";
  let removedParticipant = "";
  let publishSources: TrackSource[] = [];
  const rooms: RoomAdminBoundary = {
    getParticipant: async () => ({ tracks: [{ source: TrackSource.MICROPHONE, sid: "track-1" }] } as ParticipantInfo),
    mutePublishedTrack: async (_room, _identity, sid) => { mutedTrack = sid; return {}; },
    updateParticipant: async (_room, _identity, options) => { publishSources = options.permission.canPublishSources; return { permission: options.permission } as ParticipantInfo; },
    removeParticipant: async (_room, identity) => { removedParticipant = identity; },
  };
  const result = await new VoiceModerationService(database, rooms).forceMute("actor", "channel", "target", true);
  assert.equal(result.ok, true);
  assert.equal(result.muted, true);
  assert.ok(result.reconnectBlockedUntil);
  assert.equal(mutedTrack, "track-1");
  assert.equal(removedParticipant, "target");
  assert.deepEqual(publishSources, [TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO]);
  assert.ok(sql.some((statement) => statement.includes("voice_participant_moderation")));
  assert.ok(sql.some((statement) => statement.includes("voice_moderation_actions")));
});

test("voice moderation cannot target the installation owner or an equal-ranked member", async () => {
  let targetOwner = true;
  let roomCalls = 0;
  const database: DatabaseBoundary = {
    configured: true,
    query: async <T extends Record<string, unknown> = Record<string, unknown>>(text: string) => {
      if (text.includes("FROM community_members cm") && text.includes("highest_position")) {
        return { rows: [{ community_id: "community-1", is_owner: false, highest_position: 50, permissions: ["voice.disconnect"] } as unknown as T] };
      }
      if (text.includes("FROM channels c") && text.includes("target_is_owner")) {
        return { rows: [{ livekit_room_id: "room-1", target_is_owner: targetOwner, target_highest_position: 50 } as unknown as T] };
      }
      return { rows: [] };
    },
    transaction: async <T>(work: (transaction: DatabaseBoundary) => Promise<T>) => work(database),
    close: async () => {},
  };
  const rooms: RoomAdminBoundary = {
    getParticipant: async () => { roomCalls += 1; return { tracks: [] } as unknown as ParticipantInfo; },
    mutePublishedTrack: async () => ({}),
    updateParticipant: async () => { roomCalls += 1; return {} as ParticipantInfo; },
    removeParticipant: async () => { roomCalls += 1; },
  };
  const service = new VoiceModerationService(database, rooms);
  await assert.rejects(() => service.disconnect("actor", "channel", "target"), /forbidden/);
  targetOwner = false;
  await assert.rejects(() => service.disconnect("actor", "channel", "target"), /forbidden/);
  assert.equal(roomCalls, 0);
});
