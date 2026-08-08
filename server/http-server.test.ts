import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig, ConfigurationError } from "./env.js";
import { createHttpServer, type ApiRuntime } from "./http-server.js";
import type { DatabaseBoundary } from "./database.js";
import { createLocalApi } from "./local-adapter.js";
import { InMemoryRateLimiter } from "./rate-limiter.js";

const database: DatabaseBoundary = { configured: false, query: async () => ({ rows: [] }), close: async () => {} };

test("production configuration rejects missing database and session secret", () => {
  assert.throws(() => loadConfig({ NODE_ENV: "production" }), ConfigurationError);
});

test("object storage configuration is all-or-nothing and remains server-only", () => {
  assert.throws(() => loadConfig({ NODE_ENV: "test", S3_ENDPOINT: "http://minio:9000" }), ConfigurationError);
  const config = loadConfig({
    NODE_ENV: "test", S3_ENDPOINT: "http://minio:9000", S3_BUCKET: "freecord-media",
    S3_ACCESS_KEY: "access", S3_SECRET_KEY: "secret", MEDIA_MAX_UPLOAD_BYTES: "1024",
  });
  assert.equal(config.s3Bucket, "freecord-media");
  assert.equal(config.mediaMaxUploadBytes, 1024);
});

test("health endpoint is available without configured dependencies", async () => {
  const config = loadConfig({ NODE_ENV: "test", APP_VERSION: "test" });
  const runtime: ApiRuntime = {
    config,
    database,
    api: createLocalApi({
      auth: { login: async () => { throw new Error("auth_not_configured"); }, refresh: async () => { throw new Error("auth_not_configured"); }, logout: async () => {}, getSession: async () => { throw new Error("auth_not_configured"); } },
      community: { getCommunity: async () => { throw new Error("community_not_configured"); }, listChannels: async () => { throw new Error("community_not_configured"); } },
      channelAuthorizer: { authorizeVoiceJoin: async () => { throw new Error("authorization_not_configured"); } },
      livekit: { issue: async () => { throw new Error("livekit_not_configured"); } },
      version: "test",
    }),
  };
  const server = createHttpServer(runtime);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const response = await fetch(`http://127.0.0.1:${address.port}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).checks.database, "not-configured");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test("protected mutation routes return a generic 429 when the seam is exhausted", async () => {
  const config = loadConfig({ NODE_ENV: "test" });
  const runtime: ApiRuntime = {
    config,
    database,
    rateLimiter: new InMemoryRateLimiter({ windowMs: 60_000, max: 1, maxKeys: 10 }),
    api: createLocalApi({
      auth: { login: async () => ({ accessToken: "a", refreshToken: "r", expiresInSeconds: 60, user: { id: "u", username: "u", displayName: "U", role: "member", status: "active" }, session: { id: "s", userId: "u", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() } }), refresh: async () => { throw new Error("auth_not_configured"); }, logout: async () => {}, getSession: async () => { throw new Error("auth_not_configured"); } },
      community: { getCommunity: async () => { throw new Error("community_not_configured"); }, listChannels: async () => { throw new Error("community_not_configured"); } },
      channelAuthorizer: { authorizeVoiceJoin: async () => { throw new Error("authorization_not_configured"); } },
      livekit: { issue: async () => { throw new Error("livekit_not_configured"); } },
    }),
  };
  const server = createHttpServer(runtime);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const endpoint = `http://127.0.0.1:${address.port}/v1/auth/login`;
  const request = () => fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "u", password: "p" }) });
  assert.equal((await request()).status, 200);
  const limited = await request();
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).error.message, "Too many requests");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test("public credential routes ignore stale bearer tokens before refresh routing", async () => {
  const config = loadConfig({ NODE_ENV: "test" });
  let authenticateCalls = 0;
  let logoutCalls = 0;
  const runtime: ApiRuntime = {
    config,
    database,
    authenticate: async () => { authenticateCalls += 1; throw new Error("unauthorized"); },
    api: createLocalApi({
      auth: {
        login: async () => { throw new Error("auth_not_configured"); },
        refresh: async () => ({ accessToken: "new-access", refreshToken: "new-refresh", expiresInSeconds: 60, user: { id: "u", username: "u", displayName: "U", role: "member", status: "active" }, session: { id: "s", userId: "u", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() } }),
        logout: async () => { logoutCalls += 1; },
        getSession: async () => { throw new Error("auth_not_configured"); },
      },
      community: { getCommunity: async () => { throw new Error("community_not_configured"); }, listChannels: async () => { throw new Error("community_not_configured"); } },
      channelAuthorizer: { authorizeVoiceJoin: async () => { throw new Error("authorization_not_configured"); } },
      livekit: { issue: async () => { throw new Error("livekit_not_configured"); } },
    }),
  };
  const server = createHttpServer(runtime);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/auth/refresh`, {
    method: "POST",
    headers: { authorization: "Bearer expired", "content-type": "application/json" },
    body: JSON.stringify({ refreshToken: "still-valid" }),
  });
  assert.equal(response.status, 200);
  const logoutResponse = await fetch(`http://127.0.0.1:${address.port}/v1/auth/logout`, {
    method: "POST",
    headers: { authorization: "Bearer expired", "content-type": "application/json" },
    body: JSON.stringify({ refreshToken: "still-valid" }),
  });
  assert.equal(logoutResponse.status, 204);
  assert.equal(authenticateCalls, 0);
  assert.equal(logoutCalls, 1);
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test("chat mutations use a higher independent rate-limit budget", async () => {
  const config = loadConfig({ NODE_ENV: "test" });
  const runtime: ApiRuntime = {
    config,
    database,
    rateLimiter: new InMemoryRateLimiter({ windowMs: 60_000, max: 1, maxKeys: 10 }),
    chatRateLimiter: new InMemoryRateLimiter({ windowMs: 60_000, max: 2, maxKeys: 10 }),
    api: createLocalApi({
      auth: { login: async () => ({ accessToken: "a", refreshToken: "r", expiresInSeconds: 60, user: { id: "u", username: "u", displayName: "U", role: "member", status: "active" }, session: { id: "s", userId: "u", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() } }), refresh: async () => { throw new Error("auth_not_configured"); }, logout: async () => {}, getSession: async () => { throw new Error("auth_not_configured"); } },
      community: { getCommunity: async () => { throw new Error("community_not_configured"); }, listChannels: async () => { throw new Error("community_not_configured"); } },
      channelAuthorizer: { authorizeVoiceJoin: async () => { throw new Error("authorization_not_configured"); } },
      livekit: { issue: async () => { throw new Error("livekit_not_configured"); } },
    }),
  };
  const server = createHttpServer(runtime);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const chatRequest = () => fetch(`${origin}/v1/channels/channel/messages`, { method: "POST" });
  assert.equal((await chatRequest()).status, 401);
  assert.equal((await chatRequest()).status, 401);
  assert.equal((await chatRequest()).status, 429);
  const loginRequest = () => fetch(`${origin}/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "u", password: "p" }) });
  assert.equal((await loginRequest()).status, 200);
  assert.equal((await loginRequest()).status, 429);
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test("CORS preflight allows encrypted message mutations and reactions", async () => {
  const config = loadConfig({ NODE_ENV: "test", ALLOWED_ORIGINS: "https://client.example" });
  const runtime: ApiRuntime = {
    config,
    database,
    api: createLocalApi({
      auth: { login: async () => { throw new Error("auth_not_configured"); }, refresh: async () => { throw new Error("auth_not_configured"); }, logout: async () => {}, getSession: async () => { throw new Error("auth_not_configured"); } },
      community: { getCommunity: async () => { throw new Error("community_not_configured"); }, listChannels: async () => { throw new Error("community_not_configured"); } },
      channelAuthorizer: { authorizeVoiceJoin: async () => { throw new Error("authorization_not_configured"); } },
      livekit: { issue: async () => { throw new Error("livekit_not_configured"); } },
    }),
  };
  const server = createHttpServer(runtime);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/channels/channel/messages/message`, {
    method: "OPTIONS",
    headers: { origin: "https://client.example", "access-control-request-method": "PATCH" },
  });
  assert.equal(response.status, 204);
  assert.match(response.headers.get("access-control-allow-methods") ?? "", /PATCH/);
  assert.match(response.headers.get("access-control-allow-methods") ?? "", /DELETE/);
  assert.match(response.headers.get("access-control-allow-methods") ?? "", /PUT/);
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});
