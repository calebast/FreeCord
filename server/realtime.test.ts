import test from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AuthenticatedUser } from "./contracts.js";
import type { DatabaseBoundary } from "./database.js";
import { loadConfig } from "./env.js";
import { createHttpServer, type ApiRuntime } from "./http-server.js";
import { createLocalApi } from "./local-adapter.js";
import { RealtimeBroker } from "./realtime.js";

const user: AuthenticatedUser = {
  id: "11111111-1111-4111-8111-111111111111",
  username: "tester",
  displayName: "Tester",
  role: "member",
  status: "active",
};
const communityId = "22222222-2222-4222-8222-222222222222";
const allowedChannel = "33333333-3333-4333-8333-333333333333";
const deniedChannel = "44444444-4444-4444-8444-444444444444";

function localApi() {
  return createLocalApi({
    auth: { login: async () => { throw new Error("unused"); }, refresh: async () => { throw new Error("unused"); }, logout: async () => {}, getSession: async () => { throw new Error("unused"); } },
    community: { getCommunity: async () => { throw new Error("unused"); }, listChannels: async () => { throw new Error("unused"); } },
    channelAuthorizer: { authorizeVoiceJoin: async () => { throw new Error("unused"); } },
    livekit: { issue: async () => { throw new Error("unused"); } },
  });
}

async function listen(server: Server): Promise<{ origin: string; close: () => Promise<void> }> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

test("authenticated SSE publishes identifier-only events and filters unreadable channels", async () => {
  const database: DatabaseBoundary = {
    configured: true,
    query: async <T extends Record<string, unknown> = Record<string, unknown>>(text: string, values: readonly unknown[] = []) => {
      if (text.includes("FROM community_members cm") && text.includes("highest_position")) {
        return { rows: [{ community_id: communityId, is_owner: false, highest_position: 0, permissions: ["messages.read"] } as unknown as T] };
      }
      if (text.includes("AS role_allowed")) {
        return { rows: [{ community_id: communityId, channel_id: values[1], channel_type: "text", is_owner: false, role_allowed: values[1] === allowedChannel } as unknown as T] };
      }
      return { rows: [] };
    },
    close: async () => {},
  };
  const broker = new RealtimeBroker(database, { heartbeatMs: 60_000 });
  const runtime: ApiRuntime = { config: loadConfig({ NODE_ENV: "test" }), database, realtime: broker, authenticate: async () => user, api: localApi() };
  const server = createHttpServer(runtime);
  const listening = await listen(server);
  const controller = new AbortController();
  try {
    const response = await fetch(`${listening.origin}/v1/realtime/events`, {
      headers: { authorization: "Bearer test" },
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/u);
    assert.equal(broker.connectionCount, 1);

    await broker.publish({ kind: "message.created", communityId, actorId: user.id, channelId: deniedChannel, messageId: "55555555-5555-4555-8555-555555555555" });
    await broker.publish({ kind: "message.created", communityId, actorId: user.id, channelId: allowedChannel, messageId: "66666666-6666-4666-8666-666666666666" });

    const reader = response.body!.getReader();
    let received = "";
    while (!received.includes("66666666-6666-4666-8666-666666666666")) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      received += new TextDecoder().decode(chunk.value);
    }
    assert.doesNotMatch(received, /55555555-5555-4555-8555-555555555555/u);
    assert.match(received, /event: message\.created/u);
    assert.doesNotMatch(received, /ciphertext|nonce|content|filename|token/ui);
  } finally {
    controller.abort();
    await new Promise((resolve) => setImmediate(resolve));
    await listening.close();
  }
});

test("SSE requires authentication", async () => {
  const database: DatabaseBoundary = { configured: true, query: async () => ({ rows: [] }), close: async () => {} };
  const server = createHttpServer({ config: loadConfig({ NODE_ENV: "test" }), database, api: localApi(), authenticate: async () => user });
  const listening = await listen(server);
  try {
    const response = await fetch(`${listening.origin}/v1/realtime/events`);
    assert.equal(response.status, 401);
  } finally {
    await listening.close();
  }
});

test("SSE closes when the access token session is revoked", async () => {
  const database: DatabaseBoundary = {
    configured: true,
    query: async <T extends Record<string, unknown> = Record<string, unknown>>(text: string) => ({
      rows: text.includes("FROM community_members cm")
        ? [{ community_id: communityId, is_owner: false, highest_position: 0, permissions: ["messages.read"] as string[] } as unknown as T]
        : [],
    }),
    close: async () => {},
  };
  let valid = true;
  const broker = new RealtimeBroker(database, { heartbeatMs: 60_000 });
  const server = createHttpServer({
    config: loadConfig({ NODE_ENV: "test", ACCESS_TOKEN_TTL_SECONDS: "60" }),
    database,
    realtime: broker,
    authenticate: async () => {
      if (!valid) throw new Error("unauthorized");
      return user;
    },
    api: localApi(),
  });
  const listening = await listen(server);
  const controller = new AbortController();
  try {
    const response = await fetch(`${listening.origin}/v1/realtime/events`, { headers: { authorization: "Bearer test" }, signal: controller.signal });
    assert.equal(response.status, 200);
    assert.equal(broker.connectionCount, 1);
    valid = false;
    await broker.publish({ kind: "members.changed", communityId, actorId: user.id });
    assert.equal(broker.connectionCount, 0);
  } finally {
    controller.abort();
    await listening.close();
  }
});

test("SSE replays bounded missed events from Last-Event-ID", async () => {
  const database: DatabaseBoundary = {
    configured: true,
    query: async <T extends Record<string, unknown> = Record<string, unknown>>(text: string) => ({
      rows: text.includes("FROM community_members cm")
        ? [{ community_id: communityId, is_owner: false, highest_position: 0, permissions: ["messages.read"] as string[] } as unknown as T]
        : [],
    }),
    close: async () => {},
  };
  const broker = new RealtimeBroker(database, { heartbeatMs: 60_000, maxHistory: 10 });
  const first = await broker.publish({ kind: "members.changed", communityId, actorId: user.id });
  const second = await broker.publish({ kind: "roles.changed", communityId, actorId: user.id });
  const server = createHttpServer({ config: loadConfig({ NODE_ENV: "test" }), database, realtime: broker, authenticate: async () => user, api: localApi() });
  const listening = await listen(server);
  const controller = new AbortController();
  try {
    const response = await fetch(`${listening.origin}/v1/realtime/events`, {
      headers: { authorization: "Bearer test", "last-event-id": first.id },
      signal: controller.signal,
    });
    const reader = response.body!.getReader();
    let received = "";
    while (!received.includes(second.id)) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      received += new TextDecoder().decode(chunk.value);
    }
    assert.doesNotMatch(received, new RegExp(first.id, "u"));
    assert.match(received, /event: roles\.changed/u);
  } finally {
    controller.abort();
    await listening.close();
  }
});

test("SSE serializes replay before concurrently published live events", async () => {
  const database: DatabaseBoundary = {
    configured: true,
    query: async <T extends Record<string, unknown> = Record<string, unknown>>(text: string) => ({
      rows: text.includes("FROM community_members cm")
        ? [{ community_id: communityId, is_owner: false, highest_position: 0, permissions: ["messages.read"] as string[] } as unknown as T]
        : [],
    }),
    close: async () => {},
  };
  const broker = new RealtimeBroker(database, { heartbeatMs: 60_000, maxHistory: 10 });
  const cursor = await broker.publish({ kind: "members.changed", communityId, actorId: user.id });
  const replay = await broker.publish({ kind: "roles.changed", communityId, actorId: user.id });
  let authenticationCalls = 0;
  let releaseReplay!: () => void;
  const replayGate = new Promise<void>((resolve) => { releaseReplay = resolve; });
  const server = createHttpServer({
    config: loadConfig({ NODE_ENV: "test" }), database, realtime: broker, api: localApi(),
    authenticate: async () => {
      authenticationCalls += 1;
      if (authenticationCalls === 2) await replayGate;
      return user;
    },
  });
  const listening = await listen(server);
  const controller = new AbortController();
  try {
    const response = await fetch(`${listening.origin}/v1/realtime/events`, {
      headers: { authorization: "Bearer test", "last-event-id": cursor.id }, signal: controller.signal,
    });
    while (authenticationCalls < 2) await new Promise((resolve) => setImmediate(resolve));
    const livePromise = broker.publish({ kind: "audit.changed", communityId, actorId: user.id });
    releaseReplay();
    const live = await livePromise;
    const reader = response.body!.getReader();
    let received = "";
    while (!received.includes(live.id)) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      received += new TextDecoder().decode(chunk.value);
    }
    assert.ok(received.indexOf(replay.id) < received.indexOf(live.id));
  } finally {
    controller.abort();
    releaseReplay();
    await listening.close();
  }
});
