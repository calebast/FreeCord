import test from "node:test";
import assert from "node:assert/strict";
import { TokenVerifier } from "livekit-server-sdk";
import { OfficialLiveKitTokenIssuer, PostgresChannelAuthorizer } from "./postgres-voice.js";
import type { DatabaseBoundary } from "./database.js";

test("LiveKit issuer creates a short-lived least-privilege room token", async () => {
  const issuer = new OfficialLiveKitTokenIssuer({ apiKey: "API", apiSecret: "SECRET", url: "wss://livekit.test", ttlSeconds: 60 });
  const response = await issuer.issue({
    user: { id: "user-1", username: "alice", displayName: "Alice", role: "member", status: "active" },
    channelId: "channel-1", livekitRoomName: "room-1", canPublish: false, canPublishMicrophone: false, canSubscribe: true, canPublishData: false,
  });
  const claims = await new TokenVerifier("API", "SECRET").verify(response.token);
  assert.equal(claims.sub, "user-1");
  assert.deepEqual(claims.video, { room: "room-1", roomJoin: true, canPublish: false, canSubscribe: true, canPublishData: false });
  assert.equal(response.livekitUrl, "wss://livekit.test");
  assert.equal(response.permissions.canPublish, false);
});

test("LiveKit issuer restricts publishers to microphone and screen-share media", async () => {
  const issuer = new OfficialLiveKitTokenIssuer({ apiKey: "API", apiSecret: "SECRET", url: "wss://livekit.test", ttlSeconds: 60 });
  const response = await issuer.issue({
    user: { id: "user-1", username: "alice", displayName: "Alice", role: "member", status: "active" },
    channelId: "channel-1", livekitRoomName: "room-1", canPublish: true, canPublishMicrophone: true, canSubscribe: true, canPublishData: true,
  });
  const claims = await new TokenVerifier("API", "SECRET").verify(response.token);
  assert.deepEqual(claims.video, {
    room: "room-1",
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
    canPublishSources: ["microphone", "screen_share", "screen_share_audio"],
  });
  assert.ok(!claims.video?.canPublishSources?.includes("camera"));
  assert.equal(response.permissions.canPublish, true);
  assert.equal(response.permissions.canPublishMicrophone, true);
});

test("forced microphone mute still permits screen media publication", async () => {
  const issuer = new OfficialLiveKitTokenIssuer({ apiKey: "API", apiSecret: "SECRET", url: "wss://livekit.test", ttlSeconds: 60 });
  const response = await issuer.issue({
    user: { id: "user-1", username: "alice", displayName: "Alice", role: "member", status: "active" },
    channelId: "channel-1", livekitRoomName: "room-1", canPublish: true, canPublishMicrophone: false, canSubscribe: true, canPublishData: true,
  });
  const claims = await new TokenVerifier("API", "SECRET").verify(response.token);
  assert.deepEqual(claims.video?.canPublishSources, ["screen_share", "screen_share_audio"]);
  assert.equal(claims.video?.canPublish, true);
  assert.equal(claims.video?.roomJoin, true);
  assert.equal(claims.video?.canSubscribe, true);
  assert.equal(response.permissions.canPublish, false);
  assert.equal(response.permissions.canPublishMicrophone, false);
});

test("Postgres channel authorizer rejects non-voice, banned, or unpermitted rows", async () => {
  let sql = "";
  let values: readonly unknown[] = [];
  const database: DatabaseBoundary = {
    configured: true,
    query: async <T extends Record<string, unknown> = Record<string, unknown>>(text: string, parameters: readonly unknown[] = []) => {
      sql = text;
      values = parameters;
      return { rows: [{ community_id: "community-1", channel_id: "channel-1", channel_type: "voice", is_owner: false, role_allowed: false } as unknown as T] };
    },
    close: async () => {},
  };
  await assert.rejects(() => new PostgresChannelAuthorizer(database).authorizeVoiceJoin(
    { id: "user-1", username: "alice", displayName: "Alice", role: "member", status: "active" }, "channel-1",
  ), /forbidden/);
  assert.match(sql, /community_members/);
  assert.match(sql, /is_banned/);
  assert.match(sql, /channel_permission_overrides/);
  assert.deepEqual(values, ["user-1", "channel-1", "voice.connect", "voice"]);
});
