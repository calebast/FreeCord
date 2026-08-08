import test from "node:test";
import assert from "node:assert/strict";
import type { DatabaseBoundary } from "./database.js";
import { listAuditEvents, writeAuditEvent } from "./audit-log.js";

const communityId = "11111111-1111-4111-8111-111111111111";
const actorId = "22222222-2222-4222-8222-222222222222";
const targetId = "33333333-3333-4333-8333-333333333333";

test("audit writes are bounded and never require secret payloads", async () => {
  const writes: Array<{ text: string; values: readonly unknown[] }> = [];
  const database: DatabaseBoundary = {
    configured: true,
    query: async <T extends Record<string, unknown> = Record<string, unknown>>(text: string, values: readonly unknown[] = []) => {
      writes.push({ text, values });
      return { rows: [] as T[] };
    },
    close: async () => {},
  };
  await writeAuditEvent(database, {
    communityId,
    actorId,
    action: "channel.created",
    targetType: "channel",
    targetId,
    metadata: { name: "general", type: "text" },
  });
  assert.equal(writes.length, 1);
  assert.match(writes[0]!.text, /INSERT INTO audit_events/u);
  assert.deepEqual(JSON.parse(String(writes[0]!.values[5])), { name: "general", type: "text" });
  await assert.rejects(writeAuditEvent(database, { communityId, actorId, action: "bad action" }), /bad_request/u);
  await assert.rejects(writeAuditEvent(database, { communityId, actorId, action: "invite.created", targetType: "invite" }), /bad_request/u);
  await assert.rejects(writeAuditEvent(database, { communityId, actorId, action: "role.updated", metadata: { value: "x".repeat(501) } }), /bad_request/u);
});

test("audit listing is permission-gated and uses stable cursor pagination", async () => {
  let select = "";
  const database: DatabaseBoundary = {
    configured: true,
    query: async <T extends Record<string, unknown> = Record<string, unknown>>(text: string) => {
      if (text.includes("FROM community_members cm")) {
        return { rows: [{ community_id: communityId, is_owner: false, highest_position: 10, permissions: ["audit.view"] } as unknown as T] };
      }
      select = text;
      return { rows: [
        { id: targetId, actor_user_id: actorId, actor_username: "admin", actor_display_name: "Admin", action: "channel.created", target_type: "channel", target_id: targetId, metadata: { name: "general" }, created_at: "2026-08-08T01:00:00.000Z" },
        { id: "44444444-4444-4444-8444-444444444444", actor_user_id: actorId, actor_username: "admin", actor_display_name: "Admin", action: "role.created", target_type: "role", target_id: targetId, metadata: {}, created_at: "2026-08-08T00:00:00.000Z" },
      ] as unknown as T[] };
    },
    close: async () => {},
  };
  const page = await listAuditEvents(database, actorId, { limit: 1 });
  assert.equal(page.events.length, 1);
  assert.ok(page.nextCursor);
  assert.match(select, /ORDER BY ae\.created_at DESC, ae\.id DESC/u);
  assert.match(select, /LEFT JOIN users/u);
});
