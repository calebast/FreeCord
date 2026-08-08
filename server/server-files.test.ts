import test from "node:test";
import assert from "node:assert/strict";
import type { DatabaseBoundary } from "./database.js";
import { listSharedFiles } from "./server-files.js";

const communityId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const mediaId = "33333333-3333-4333-8333-333333333333";

test("server files list only readable live message attachments with a stable cursor", async () => {
  let query = "";
  let values: readonly unknown[] = [];
  const database: DatabaseBoundary = {
    configured: true,
    query: async <T extends Record<string, unknown> = Record<string, unknown>>(text: string, parameters: readonly unknown[] = []) => {
      if (text.includes("FROM community_members cm")) {
        return { rows: [{ community_id: communityId, is_owner: false, highest_position: 0, permissions: ["messages.read"] } as unknown as T] };
      }
      query = text;
      values = parameters;
      return { rows: [
        { media_id: mediaId, content_type: "video/mp4", byte_size: 1234, encrypted: false, width: 1280, height: 720, ready_at: "2026-08-08T00:00:00.000Z", position: 0, shared_at: "2026-08-08T01:00:00.000Z", message_id: "44444444-4444-4444-8444-444444444444", channel_id: "55555555-5555-4555-8555-555555555555", channel_name: "general", author_id: userId, author_username: "tester", author_display_name: "Tester", ciphertext: "opaque", nonce: "opaque-nonce" },
        { media_id: "66666666-6666-4666-8666-666666666666", content_type: "application/octet-stream", byte_size: 50, encrypted: true, ready_at: "2026-08-08T00:00:00.000Z", position: 1, shared_at: "2026-08-08T00:30:00.000Z", message_id: "77777777-7777-4777-8777-777777777777", channel_id: "55555555-5555-4555-8555-555555555555", channel_name: "general", author_id: userId, author_username: "tester", author_display_name: "Tester", ciphertext: "opaque", nonce: "opaque-nonce" },
      ] as unknown as T[] };
    },
    close: async () => {},
  };
  const page = await listSharedFiles(database, userId, { limit: 1 });
  assert.equal(page.files.length, 1);
  assert.equal(page.files[0]?.media.id, mediaId);
  assert.equal("messageCiphertext" in page.files[0]!, false);
  assert.ok(page.nextCursor);
  assert.doesNotMatch(query, /m\.ciphertext|m\.nonce/u);
  assert.match(query, /m\.deleted_at IS NULL/u);
  assert.match(query, /mo\.state = 'ready'/u);
  assert.match(query, /channel_permission_overrides/u);
  assert.match(query, /ORDER BY ma\.created_at DESC, mo\.id DESC/u);
  assert.deepEqual(values.slice(0, 2), [communityId, null]);
});
