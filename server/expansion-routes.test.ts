import test from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AuthenticatedUser } from "./contracts.js";
import type { DatabaseBoundary } from "./database.js";
import { loadConfig } from "./env.js";
import { createHttpServer, type ApiRuntime } from "./http-server.js";
import { createLocalApi } from "./local-adapter.js";

const user: AuthenticatedUser = {
  id: "11111111-1111-4111-8111-111111111111",
  username: "tester",
  displayName: "Tester",
  role: "member",
  status: "active",
};

function runtime(database: DatabaseBoundary): ApiRuntime {
  return {
    config: loadConfig({ NODE_ENV: "test" }),
    database,
    authenticate: async () => user,
    api: createLocalApi({
      auth: {
        login: async () => { throw new Error("unused"); },
        refresh: async () => { throw new Error("unused"); },
        logout: async () => {},
        getSession: async () => { throw new Error("unused"); },
      },
      community: {
        getCommunity: async () => { throw new Error("unused"); },
        listChannels: async () => { throw new Error("unused"); },
      },
      channelAuthorizer: { authorizeVoiceJoin: async () => { throw new Error("unused"); } },
      livekit: { issue: async () => { throw new Error("unused"); } },
    }),
  };
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

function request(origin: string, path: string, method: string, body: unknown): Promise<Response> {
  return fetch(`${origin}${path}`, {
    method,
    headers: { authorization: "Bearer test-token", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("custom-emote reactions require one valid target and stay scoped to the message community", async () => {
  const emoteId = "22222222-2222-4222-8222-222222222222";
  const queries: Array<{ text: string; values: readonly unknown[] }> = [];
  const database: DatabaseBoundary = {
    configured: true,
    query: async <T extends Record<string, unknown> = Record<string, unknown>>(text: string, values: readonly unknown[] = []) => {
      queries.push({ text, values });
      if (text.includes("AS role_allowed")) return { rows: [{ community_id: "community-1", channel_id: "channel-1", channel_type: "text", is_owner: false, role_allowed: true } as unknown as T] };
      if (text.includes("INSERT INTO message_reactions")) return { rows: [{ message_id: "message-1" } as unknown as T] };
      return { rows: [] };
    },
    close: async () => {},
  };
  const server = createHttpServer(runtime(database));
  const listening = await listen(server);
  try {
    const path = "/v1/channels/channel-1/messages/message-1/reactions";
    const added = await request(listening.origin, path, "POST", { emoteId });
    assert.equal(added.status, 200);
    assert.deepEqual((await added.json()).target, { kind: "emote", emoteId });

    const insert = queries.find((query) => query.text.includes("INSERT INTO message_reactions"));
    assert.ok(insert);
    assert.match(insert.text, /JOIN custom_emotes ce ON ce\.id = \$4/u);
    assert.match(insert.text, /ce\.community_id = c\.community_id/u);
    assert.match(insert.text, /ce\.deleted_at IS NULL/u);
    assert.deepEqual(insert.values, ["message-1", "channel-1", user.id, emoteId]);

    const removed = await request(listening.origin, path, "DELETE", { emoteId });
    assert.equal(removed.status, 200);
    const removal = queries.find((query) => query.text.includes("DELETE FROM message_reactions") && query.text.includes("custom_emote_id"));
    assert.deepEqual(removal?.values, ["message-1", "channel-1", user.id, emoteId]);

    const beforeInvalid = queries.filter((query) => query.text.includes("INSERT INTO message_reactions")).length;
    const ambiguous = await request(listening.origin, path, "POST", { unicode: "👍", emoteId });
    assert.equal(ambiguous.status, 400);
    const invalidId = await request(listening.origin, path, "POST", { emoteId: "not-a-uuid" });
    assert.equal(invalidId.status, 400);
    assert.equal(queries.filter((query) => query.text.includes("INSERT INTO message_reactions")).length, beforeInvalid);
  } finally {
    await listening.close();
  }
});

test("message attachments reject malformed or duplicate IDs and atomically link eligible media", async () => {
  const attachmentIds = [
    "33333333-3333-4333-8333-333333333333",
    "44444444-4444-4444-8444-444444444444",
  ];
  const writes: Array<{ text: string; values: readonly unknown[] }> = [];
  const database: DatabaseBoundary = {
    configured: true,
    query: async <T extends Record<string, unknown> = Record<string, unknown>>(text: string, values: readonly unknown[] = []) => {
      if (text.includes("AS role_allowed")) return { rows: [{ community_id: "community-1", channel_id: "channel-1", channel_type: "text", is_owner: false, role_allowed: true } as unknown as T] };
      if (text.includes("WITH eligible AS")) {
        writes.push({ text, values });
        return { rows: [{
          id: "55555555-5555-4555-8555-555555555555",
          channel_id: "channel-1",
          author_id: user.id,
          author_username: user.username,
          author_display_name: user.displayName,
          content: "video",
          ciphertext: null,
          nonce: null,
          created_at: "2026-08-08T00:00:00.000Z",
          edited_at: null,
          deleted_at: null,
          reactions: [],
        } as unknown as T] };
      }
      return { rows: [] };
    },
    close: async () => {},
  };
  const server = createHttpServer(runtime(database));
  const listening = await listen(server);
  try {
    const path = "/v1/channels/channel-1/messages";
    assert.equal((await request(listening.origin, path, "POST", { content: "video", attachmentIds: ["bad-id"] })).status, 400);
    assert.equal((await request(listening.origin, path, "POST", { content: "video", attachmentIds: [attachmentIds[0], attachmentIds[0]] })).status, 400);
    assert.equal(writes.length, 0, "invalid attachment IDs must not reach the message write");

    const created = await request(listening.origin, path, "POST", { content: " video ", attachmentIds });
    assert.equal(created.status, 201);
    assert.equal((await created.json()).id, "55555555-5555-4555-8555-555555555555");
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0]?.values, ["channel-1", user.id, "video", null, null, attachmentIds]);
    assert.match(writes[0]!.text, /mo\.uploaded_by = \$2/u);
    assert.match(writes[0]!.text, /mo\.purpose = 'message' AND mo\.state = 'ready'/u);
    assert.match(writes[0]!.text, /cardinality\(\$6::uuid\[\]\) = \(SELECT count\(\*\) FROM eligible\)/u);
    assert.match(writes[0]!.text, /INSERT INTO message_attachments/u);
    assert.match(writes[0]!.text, /array_position\(\$6::uuid\[\], eligible\.id\)/u);
  } finally {
    await listening.close();
  }
});

test("a channel override denial blocks message writes before database mutation", async () => {
  let mutated = false;
  const database: DatabaseBoundary = {
    configured: true,
    query: async <T extends Record<string, unknown> = Record<string, unknown>>(text: string) => {
      if (text.includes("AS role_allowed")) {
        assert.match(text, /channel_permission_overrides/u);
        assert.match(text, /ORDER BY r\.position DESC, cpo\.granted ASC/u);
        return { rows: [{ community_id: "community-1", channel_id: "channel-1", channel_type: "text", is_owner: false, role_allowed: false } as unknown as T] };
      }
      if (text.includes("INSERT INTO messages")) mutated = true;
      return { rows: [] };
    },
    close: async () => {},
  };
  const server = createHttpServer(runtime(database));
  const listening = await listen(server);
  try {
    const denied = await request(listening.origin, "/v1/channels/channel-1/messages", "POST", { content: "must not send" });
    assert.equal(denied.status, 403);
    assert.equal(mutated, false);
  } finally {
    await listening.close();
  }
});
