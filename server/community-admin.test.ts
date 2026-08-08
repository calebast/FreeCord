import test from "node:test";
import assert from "node:assert/strict";
import { mayGrantPermissions } from "./authorization.js";
import type { DatabaseBoundary } from "./database.js";
import { assignRole, createRole, validateRoleInput } from "./community-admin.js";

test("custom role input is bounded and deduplicates permissions", () => {
  assert.deepEqual(validateRoleInput({
    name: " Moderators ", description: " Can manage voice ", position: 20,
    permissions: ["voice.mute", "voice.mute", "voice.move"],
  }), {
    name: "Moderators", description: "Can manage voice", position: 20,
    permissions: ["voice.mute", "voice.move"],
  });
  assert.throws(() => validateRoleInput({ name: "owner", permissions: [] }), /bad_request/);
  assert.throws(() => validateRoleInput({ name: "role", permissions: ["INVALID PERMISSION"] }), /bad_request/);
});

test("non-owner role managers cannot grant permissions they do not hold", () => {
  const actor = { communityId: "community", isOwner: false, highestPosition: 10, permissions: ["voice.mute"] };
  assert.equal(mayGrantPermissions(actor, ["voice.mute"]), true);
  assert.equal(mayGrantPermissions(actor, ["voice.move"]), false);
  assert.equal(mayGrantPermissions({ ...actor, isOwner: true }, ["voice.move"]), true);
});

function transactionalDatabase(handler: (text: string, values: readonly unknown[]) => Record<string, unknown>[]): DatabaseBoundary {
  const transaction: DatabaseBoundary = {
    configured: true,
    query: async <T extends Record<string, unknown> = Record<string, unknown>>(text: string, values: readonly unknown[] = []) => ({
      rows: handler(text, values) as T[],
    }),
    close: async () => {},
  };
  return {
    ...transaction,
    transaction: async <T>(callback: (database: DatabaseBoundary) => Promise<T>) => callback(transaction),
  };
}

test("custom role creation enforces permission delegation and role hierarchy before writing", async () => {
  const writes: string[] = [];
  const database = transactionalDatabase((text) => {
    if (/^\s*(?:INSERT|UPDATE|DELETE)\b/u.test(text)) writes.push(text);
    if (text.includes("FROM community_members cm")) {
      return [{ community_id: "community-1", is_owner: false, highest_position: 10, permissions: ["roles.manage", "voice.mute"] }];
    }
    if (text.includes("SELECT key FROM permissions")) return [{ key: "voice.mute" }];
    return [];
  });

  await assert.rejects(
    createRole(database, "actor-1", { name: "Too High", description: "", position: 10, permissions: ["voice.mute"] }),
    /forbidden/,
  );
  await assert.rejects(
    createRole(database, "actor-1", { name: "Overpowered", description: "", position: 5, permissions: ["voice.move"] }),
    /forbidden/,
  );
  assert.deepEqual(writes, [], "rejected role changes must not reach a write query");
});

test("role assignment rejects peers, owner targets, and roles at the actor's level", async () => {
  const scenarios = [
    { target: { user_id: "target", is_owner: false, highest_position: 10 }, role: { id: "role", position: 5, kind: "custom" } },
    { target: { user_id: "target", is_owner: true, highest_position: 0 }, role: { id: "role", position: 5, kind: "custom" } },
    { target: { user_id: "target", is_owner: false, highest_position: 1 }, role: { id: "role", position: 10, kind: "custom" } },
  ];

  for (const scenario of scenarios) {
    const writes: string[] = [];
    const database = transactionalDatabase((text) => {
      if (/^\s*(?:INSERT|UPDATE|DELETE)\b/u.test(text)) writes.push(text);
      if (text.includes("FROM community_members cm") && text.includes("array_agg")) {
        return [{ community_id: "community-1", is_owner: false, highest_position: 10, permissions: ["roles.assign", "voice.mute"] }];
      }
      if (text.includes("FOR UPDATE OF cm")) return [scenario.target];
      if (text.includes("FROM roles WHERE community_id")) return [scenario.role];
      return [];
    });
    await assert.rejects(assignRole(database, "actor", "target", "role", true), /forbidden/);
    assert.deepEqual(writes, [], "rejected assignment must not modify member roles");
  }
});
