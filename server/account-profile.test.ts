import test from "node:test";
import assert from "node:assert/strict";
import type { PasswordHasher } from "./auth.js";
import type { DatabaseBoundary } from "./database.js";
import { changeOwnPassword, updateOwnDisplayName, validateDisplayName, validatePasswordChange } from "./account-profile.js";

test("profile validation trims safe display names and rejects control characters", () => {
  assert.equal(validateDisplayName("  Home User  "), "Home User");
  assert.throws(() => validateDisplayName(""), /bad_request/u);
  assert.throws(() => validateDisplayName("bad\nname"), /bad_request/u);
  assert.throws(() => validatePasswordChange({ currentPassword: "old", newPassword: "short" }), /bad_request/u);
});

test("display-name updates are scoped to the active authenticated user", async () => {
  const queries: Array<{ text: string; values: readonly unknown[] }> = [];
  const database: DatabaseBoundary = {
    configured: true,
    query: async <T extends Record<string, unknown> = Record<string, unknown>>(text: string, values: readonly unknown[] = []) => {
      queries.push({ text, values });
      return { rows: [{ id: "user-1" } as unknown as T] };
    },
    close: async () => {},
  };
  await updateOwnDisplayName(database, "user-1", " Updated Name ");
  assert.match(queries[0]!.text, /WHERE id = \$2 AND is_active/u);
  assert.deepEqual(queries[0]!.values, ["Updated Name", "user-1"]);
});

test("password changes verify the current secret and revoke only other sessions", async () => {
  const queries: Array<{ text: string; values: readonly unknown[] }> = [];
  const transactionDatabase: DatabaseBoundary = {
    configured: true,
    query: async <T extends Record<string, unknown> = Record<string, unknown>>(text: string, values: readonly unknown[] = []) => {
      queries.push({ text, values });
      if (text.includes("SELECT password_hash")) return { rows: [{ password_hash: "old-hash" } as unknown as T] };
      return { rows: [] };
    },
    close: async () => {},
  };
  const database: DatabaseBoundary = {
    ...transactionDatabase,
    transaction: async (callback) => callback(transactionDatabase),
  };
  const passwordHasher: PasswordHasher = {
    verify: async (password, hash) => password === "correct-current" && hash === "old-hash",
    hash: async (password) => `argon2id:${password}`,
  };

  await changeOwnPassword(database, passwordHasher, "user-1", "session-current", {
    currentPassword: "correct-current",
    newPassword: "new-password-long-enough",
  });

  const passwordWrite = queries.find((query) => query.text.includes("UPDATE users SET password_hash"));
  const sessionWrite = queries.find((query) => query.text.includes("UPDATE user_sessions"));
  assert.deepEqual(passwordWrite?.values, ["argon2id:new-password-long-enough", "user-1"]);
  assert.deepEqual(sessionWrite?.values, ["user-1", "session-current"]);
  assert.match(sessionWrite!.text, /id <> \$2/u);
  assert.match(sessionWrite!.text, /password_changed/u);

  queries.length = 0;
  await assert.rejects(() => changeOwnPassword(database, passwordHasher, "user-1", "session-current", {
    currentPassword: "wrong-current",
    newPassword: "another-password-long-enough",
  }), /invalid_credentials/u);
  assert.equal(queries.some((query) => query.text.includes("UPDATE users SET password_hash")), false);
});
