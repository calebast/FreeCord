import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryRateLimiter } from "./rate-limiter.js";

test("in-memory limiter rejects after the window budget and stays bounded", () => {
  const limiter = new InMemoryRateLimiter({ windowMs: 1_000, max: 2, maxKeys: 2 });
  assert.equal(limiter.consume("a", 0).allowed, true);
  assert.equal(limiter.consume("a", 1).allowed, true);
  assert.deepEqual(limiter.consume("a", 2), { allowed: false, retryAfterSeconds: 1 });
  limiter.consume("b", 3);
  limiter.consume("c", 4);
  assert.equal(limiter.size, 2);
  assert.equal(limiter.consume("a", 1_001).allowed, true);
});
