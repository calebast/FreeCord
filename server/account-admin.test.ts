import test from "node:test";
import assert from "node:assert/strict";
import type { PasswordHasher } from "./auth.js";
import type { DatabaseBoundary } from "./database.js";
import { clearMemberVoiceRestrictions, deactivateMemberAccount, resetMemberPassword } from "./account-admin.js";

interface QueryRecord { text: string; values: readonly unknown[] }

function fixture(options: { owner?: boolean; targetOwner?: boolean; targetAdmin?: boolean; targetPosition?: number; moderationRows?: number } = {}) {
  const queries: QueryRecord[] = [];
  const database: DatabaseBoundary = {
    configured: true,
    query: async <T extends Record<string, unknown> = Record<string, unknown>>(text: string, values: readonly unknown[] = []) => {
      queries.push({ text, values });
      if (text.includes("GROUP BY cm.community_id")) return { rows: [{
        community_id: "community-1", is_owner: options.owner === true, highest_position: options.owner ? 100 : 50,
        permissions: ["members.password.reset", "members.deactivate", "voice.restrictions.manage"],
      } as unknown as T] };
      if (text.includes("SELECT cm.user_id, u.is_active")) return { rows: [{
        user_id: "target-1", is_active: true, is_owner: options.targetOwner === true,
        is_admin: options.targetAdmin === true, highest_position: options.targetPosition ?? 10,
      } as unknown as T] };
      if (text.includes("DELETE FROM voice_participant_moderation") && text.includes("RETURNING channel_id")) {
        return { rows: Array.from({ length: options.moderationRows ?? 0 }, (_, index) => ({ channel_id: `channel-${index}` } as unknown as T)) };
      }
      if (text.includes("RETURNING id")) return { rows: [{ id: "target-1" } as unknown as T] };
      return { rows: [] };
    },
    transaction: async <T>(callback: (transaction: DatabaseBoundary) => Promise<T>) => callback(database),
    close: async () => {},
  };
  return { database, queries };
}

const hasher: PasswordHasher = {
  hash: async (password) => `argon:${password.length}`,
  verify: async () => false,
};

test("administrator password replacement hashes the secret and revokes every target session", async () => {
  const { database, queries } = fixture();
  const replacement = "a temporary password";
  const result = await resetMemberPassword(database, hasher, "actor-1", "target-1", { newPassword: replacement });
  assert.equal(result.communityId, "community-1");
  assert.ok(queries.some((query) => query.text.includes("UPDATE users SET password_hash")));
  assert.ok(queries.some((query) => query.text.includes("admin_password_reset") && query.text.includes("user_sessions")));
  assert.ok(queries.some((query) => query.text.includes("INSERT INTO audit_events") && query.values.includes("account.password_reset")));
  assert.ok(!queries.some((query) => query.text.includes(replacement) || query.values.includes(replacement)));
});

test("account deactivation anonymizes instead of deleting the user and relies on the session-revocation trigger", async () => {
  const { database, queries } = fixture();
  await deactivateMemberAccount(database, hasher, "actor-1", "target-1");
  const statements = queries.map((query) => query.text).join("\n");
  assert.match(statements, /SET username = 'deleted-'/);
  assert.match(statements, /is_active = false/);
  assert.doesNotMatch(statements, /status = 'offline'/);
  assert.match(statements, /DELETE FROM member_roles/);
  assert.match(statements, /DELETE FROM user_profiles/);
  assert.ok(queries.some((query) => query.text.includes("INSERT INTO audit_events") && query.values.includes("account.deactivated")));
  assert.doesNotMatch(statements, /DELETE FROM users/);
});

test("voice restriction reset is account-wide and idempotent", async () => {
  const first = fixture({ moderationRows: 2 });
  assert.deepEqual(await clearMemberVoiceRestrictions(first.database, "actor-1", "target-1"), { communityId: "community-1", cleared: 2 });
  assert.ok(first.queries.some((query) => query.text.includes("WHERE community_id = $1 AND user_id = $2") && query.text.includes("voice_participant_moderation")));
  assert.ok(first.queries.some((query) => query.text.includes("INSERT INTO audit_events") && query.values.includes("voice.restrictions_cleared")));
  const second = fixture();
  assert.deepEqual(await clearMemberVoiceRestrictions(second.database, "actor-1", "target-1"), { communityId: "community-1", cleared: 0 });
});

test("administrative account actions reject self, owner, administrator, and peer targets", async () => {
  const self = fixture();
  await assert.rejects(() => clearMemberVoiceRestrictions(self.database, "target-1", "target-1"), /forbidden/);
  const owner = fixture({ targetOwner: true });
  await assert.rejects(() => resetMemberPassword(owner.database, hasher, "actor-1", "target-1", { newPassword: "a sufficiently long reset" }), /forbidden/);
  const admin = fixture({ targetAdmin: true });
  await assert.rejects(() => deactivateMemberAccount(admin.database, hasher, "actor-1", "target-1"), /forbidden/);
  const peer = fixture({ targetPosition: 50 });
  await assert.rejects(() => clearMemberVoiceRestrictions(peer.database, "actor-1", "target-1"), /forbidden/);
});

test("installation owner may manage a non-owner administrator but never the owner account", async () => {
  const admin = fixture({ owner: true, targetAdmin: true, targetPosition: 90 });
  await assert.doesNotReject(() => clearMemberVoiceRestrictions(admin.database, "actor-1", "target-1"));
  const ownerTarget = fixture({ owner: true, targetOwner: true });
  await assert.rejects(() => clearMemberVoiceRestrictions(ownerTarget.database, "actor-1", "target-1"), /forbidden/);
});
