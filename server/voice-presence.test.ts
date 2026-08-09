import test from "node:test";
import assert from "node:assert/strict";
import { TrackSource, type ParticipantInfo } from "livekit-server-sdk";
import type { DatabaseBoundary } from "./database.js";
import type { RoomPresenceBoundary } from "./voice-moderation.js";
import { VoicePresenceService } from "./voice-presence.js";

const viewerId = "11111111-1111-4111-8111-111111111111";
const memberId = "22222222-2222-4222-8222-222222222222";
const deniedMemberId = "33333333-3333-4333-8333-333333333333";

function participant(identity: string, muted: boolean, deafened = false): ParticipantInfo {
  return {
    identity,
    metadata: JSON.stringify({ deafened }),
    tracks: [
      { source: TrackSource.MICROPHONE, muted },
      { source: TrackSource.SCREEN_SHARE, muted: false },
    ],
  } as unknown as ParticipantInfo;
}

function databaseFixture(): DatabaseBoundary {
  return {
    configured: true,
    query: async <T extends Record<string, unknown> = Record<string, unknown>>(text: string, values: readonly unknown[] = []) => {
      if (text.includes("JOIN voice_channel_bindings")) return { rows: [
        { channel_id: "voice-allowed", livekit_room_id: "room-allowed" },
        { channel_id: "voice-denied", livekit_room_id: "room-denied" },
      ] as unknown as T[] };
      if (text.includes("channel_permission_overrides")) {
        const channelId = String(values[1]);
        return { rows: [{ community_id: "community-1", channel_id: channelId, channel_type: "voice", is_owner: false, role_allowed: channelId === "voice-allowed" }] as unknown as T[] };
      }
      if (text.includes("u.id = ANY")) return { rows: [{ id: memberId }] as unknown as T[] };
      return { rows: [] };
    },
    close: async () => {},
  };
}

test("voice presence exposes only authorized rooms and active community users", async () => {
  const requestedRooms: string[] = [];
  const rooms: RoomPresenceBoundary = {
    listParticipants: async (room) => {
      requestedRooms.push(room);
      return [participant(memberId, true, true), participant(deniedMemberId, false), participant("not-a-user-id", false)];
    },
  };
  const service = new VoicePresenceService(databaseFixture(), rooms, 10_000);
  const result = await service.listForUser(viewerId);

  assert.deepEqual(requestedRooms, ["room-allowed"]);
  assert.equal(result.stale, false);
  assert.deepEqual(result.channels, [{
    channelId: "voice-allowed",
    occupants: [{ userId: memberId, microphone: "muted", deafened: true, screenSharing: true }],
  }]);

  await service.listForUser(viewerId);
  assert.deepEqual(requestedRooms, ["room-allowed"], "the bounded cache prevents one LiveKit request per desktop poll");
});

test("voice presence fails closed with a stale empty roster when LiveKit is unavailable", async () => {
  const rooms: RoomPresenceBoundary = { listParticipants: async () => { throw new Error("unavailable"); } };
  const result = await new VoicePresenceService(databaseFixture(), rooms).listForUser(viewerId);
  assert.equal(result.stale, true);
  assert.deepEqual(result.channels, [{ channelId: "voice-allowed", occupants: [] }]);
});

test("a prior roster is cleared after the bounded stale-retention window", async () => {
  let available = true;
  const rooms: RoomPresenceBoundary = {
    listParticipants: async () => {
      if (!available) throw new Error("unavailable");
      return [participant(memberId, false)];
    },
  };
  const service = new VoicePresenceService(databaseFixture(), rooms, 0, -1);
  assert.equal((await service.listForUser(viewerId)).channels[0]?.occupants.length, 1);
  available = false;
  const stale = await service.listForUser(viewerId);
  assert.equal(stale.stale, true);
  assert.deepEqual(stale.channels, [{ channelId: "voice-allowed", occupants: [] }]);
});
