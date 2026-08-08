import { readFileSync } from "node:fs";

export interface ServerConfig {
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  version: string;
  databaseUrl?: string;
  databaseSsl: boolean;
  livekitUrl?: string;
  /** Server-only LiveKit credentials; never include these in API contracts. */
  livekitApiKey?: string;
  livekitApiSecret?: string;
  livekitTokenTtlSeconds: number;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  sessionSecretConfigured: boolean;
  /** Server-only value; never serialize this config or return it from an API. */
  sessionSecret?: string;
  initialAdminUsername?: string;
  initialAdminPassword?: string;
  /** Server-only Giphy API key; never return this from an API. */
  giphyApiKey?: string;
  /** Server-only S3-compatible object storage settings. */
  s3Endpoint?: string;
  s3Region: string;
  s3Bucket?: string;
  s3AccessKey?: string;
  s3SecretKey?: string;
  s3ForcePathStyle: boolean;
  mediaMaxUploadBytes: number;
  /** Server-only Room Service URL, normally the internal LiveKit HTTP URL. */
  livekitApiUrl?: string;
  allowedOrigins: string[];
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

function optionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function secretString(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const direct = optionalString(env[name]);
  const filePath = optionalString(env[`${name}_FILE`]);
  if (direct && filePath) {
    throw new ConfigurationError(`${name} and ${name}_FILE must not both be provided`);
  }
  if (!filePath) return direct;
  try {
    const value = optionalString(readFileSync(filePath, "utf8"));
    if (!value) throw new ConfigurationError(`${name}_FILE is empty`);
    return value;
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    throw new ConfigurationError(`${name}_FILE could not be read`);
  }
}

function positiveInteger(name: string, value: string | undefined, fallback: number): number {
  const raw = value ?? String(fallback);
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ConfigurationError(`${name} must be a positive integer`);
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const nodeEnv = env.NODE_ENV ?? "development";
  if (nodeEnv !== "development" && nodeEnv !== "test" && nodeEnv !== "production") {
    throw new ConfigurationError("NODE_ENV must be development, test, or production");
  }

  const databasePassword = secretString(env, "DATABASE_PASSWORD");
  const databaseUrl = optionalString(env.DATABASE_URL) ?? (databasePassword
    ? `postgresql://${encodeURIComponent(env.POSTGRES_USER?.trim() || "freecord")}:${encodeURIComponent(databasePassword)}@postgres:5432/${encodeURIComponent(env.POSTGRES_DB?.trim() || "freecord")}`
    : undefined);
  const livekitUrl = optionalString(env.LIVEKIT_URL);
  const livekitApiKey = secretString(env, "LIVEKIT_API_KEY");
  const livekitApiSecret = secretString(env, "LIVEKIT_API_SECRET");
  const livekitApiUrl = optionalString(env.LIVEKIT_API_URL);
  const sessionSecret = secretString(env, "SESSION_SECRET");
  const initialAdminPassword = secretString(env, "FREECORD_INITIAL_ADMIN_PASSWORD");
  if (env === process.env) delete process.env.FREECORD_INITIAL_ADMIN_PASSWORD;
  const initialAdminUsername = initialAdminPassword
    ? optionalString(env.FREECORD_INITIAL_ADMIN_USERNAME) ?? "admin"
    : undefined;
  const giphyApiKey = optionalString(env.GIPHY_API_KEY);
  const s3Endpoint = optionalString(env.S3_ENDPOINT);
  const s3Bucket = optionalString(env.S3_BUCKET);
  const s3AccessKey = secretString(env, "S3_ACCESS_KEY");
  const s3SecretKey = secretString(env, "S3_SECRET_KEY");
  if (nodeEnv === "production" && !databaseUrl) {
    throw new ConfigurationError("DATABASE_URL is required in production");
  }
  if (nodeEnv === "production" && !sessionSecret) {
    throw new ConfigurationError("SESSION_SECRET is required in production");
  }
  if (nodeEnv === "production" && sessionSecret && sessionSecret.length < 32) {
    throw new ConfigurationError("SESSION_SECRET must contain at least 32 characters in production");
  }
  if (Boolean(livekitApiKey) !== Boolean(livekitApiSecret)) {
    throw new ConfigurationError("LIVEKIT_API_KEY and LIVEKIT_API_SECRET must be provided together");
  }
  if (nodeEnv === "production" && livekitApiSecret && (livekitApiSecret.length < 32 || livekitApiSecret === sessionSecret)) {
    throw new ConfigurationError("LIVEKIT_API_SECRET must be at least 32 characters and distinct from SESSION_SECRET");
  }
  const s3Values = [s3Endpoint, s3Bucket, s3AccessKey, s3SecretKey];
  if (s3Values.some(Boolean) && !s3Values.every(Boolean)) {
    throw new ConfigurationError("S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY, and S3_SECRET_KEY must be provided together");
  }
  if (nodeEnv === "production" && s3SecretKey && (s3SecretKey.length < 32 || s3SecretKey === sessionSecret || s3SecretKey === livekitApiSecret)) {
    throw new ConfigurationError("S3_SECRET_KEY must be at least 32 characters and distinct from other service secrets");
  }
  if (nodeEnv === "production" && initialAdminPassword && initialAdminPassword.length < 12) {
    throw new ConfigurationError("FREECORD_INITIAL_ADMIN_PASSWORD must contain at least 12 characters in production");
  }

  const allowedOrigins = (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  const mediaMaxUploadBytes = positiveInteger("MEDIA_MAX_UPLOAD_BYTES", env.MEDIA_MAX_UPLOAD_BYTES, 25 * 1024 * 1024);
  if (mediaMaxUploadBytes > 25 * 1024 * 1024) throw new ConfigurationError("MEDIA_MAX_UPLOAD_BYTES cannot exceed 26214400");

  return {
    nodeEnv,
    host: env.HOST?.trim() || "127.0.0.1",
    port: positiveInteger("PORT", env.PORT, 8081),
    version: env.APP_VERSION?.trim() || "development",
    databaseSsl: env.DATABASE_SSL === "true",
    accessTokenTtlSeconds: positiveInteger("ACCESS_TOKEN_TTL_SECONDS", env.ACCESS_TOKEN_TTL_SECONDS, 600),
    refreshTokenTtlSeconds: positiveInteger("REFRESH_TOKEN_TTL_SECONDS", env.REFRESH_TOKEN_TTL_SECONDS, 2_592_000),
    livekitTokenTtlSeconds: positiveInteger("LIVEKIT_TOKEN_TTL_SECONDS", env.LIVEKIT_TOKEN_TTL_SECONDS, 60),
    s3Region: optionalString(env.S3_REGION) ?? "us-east-1",
    s3ForcePathStyle: env.S3_FORCE_PATH_STYLE !== "false",
    mediaMaxUploadBytes,
    sessionSecretConfigured: Boolean(sessionSecret),
    allowedOrigins,
    ...(databaseUrl ? { databaseUrl } : {}),
    ...(livekitUrl ? { livekitUrl } : {}),
    ...(livekitApiKey ? { livekitApiKey } : {}),
    ...(livekitApiSecret ? { livekitApiSecret } : {}),
    ...(sessionSecret ? { sessionSecret } : {}),
    ...(initialAdminUsername ? { initialAdminUsername } : {}),
    ...(initialAdminPassword ? { initialAdminPassword } : {}),
    ...(giphyApiKey ? { giphyApiKey } : {}),
    ...(livekitApiUrl ? { livekitApiUrl } : {}),
    ...(s3Endpoint ? { s3Endpoint } : {}),
    ...(s3Bucket ? { s3Bucket } : {}),
    ...(s3AccessKey ? { s3AccessKey } : {}),
    ...(s3SecretKey ? { s3SecretKey } : {}),
  };
}
