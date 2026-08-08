import { createHash, randomUUID } from "node:crypto";
import { DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { ServerResponse } from "node:http";
import type { DatabaseBoundary } from "./database.js";
import type { CommunityEmote, MediaReference } from "./contracts.js";
import { effectiveAccess, requirePermission, resolveChannelPermission } from "./authorization.js";
import { writeAuditEvent } from "./audit-log.js";
import type { ServerConfig } from "./env.js";

type Row = Record<string, unknown>;
export type MediaPurpose = "message" | "avatar" | "emote";

export interface MediaUploadInput {
  purpose: MediaPurpose;
  name: string;
  contentType: string;
  dataBase64: string;
}

export interface MediaDownload {
  contentType: string;
  contentLength: number;
  contentRange?: string;
  etag?: string;
  status: 200 | 206;
  body: AsyncIterable<Uint8Array>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const EMOTE_TYPES = new Set([...IMAGE_TYPES, "image/gif"]);
const VIDEO_TYPES = new Set(["video/mp4", "video/webm"]);
const AUDIO_TYPES = new Set(["audio/mpeg", "audio/ogg", "audio/wav"]);

function decodeBase64(value: unknown, maxBytes: number): Buffer {
  if (typeof value !== "string" || !value || value.length > Math.ceil(maxBytes / 3) * 4 + 4
    || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value) || value.length % 4 !== 0) throw new Error("bad_request");
  const decoded = Buffer.from(value, "base64");
  if (!decoded.length || decoded.length > maxBytes) throw new Error("bad_request");
  const normalizedInput = value.replace(/=+$/u, "");
  if (decoded.toString("base64").replace(/=+$/u, "") !== normalizedInput) throw new Error("bad_request");
  return decoded;
}

function sniffContentType(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a") return "image/gif";
  if (bytes.subarray(0, 3).toString("ascii") === "ID3" || bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0) return "audio/mpeg";
  if (bytes.subarray(0, 4).toString("ascii") === "OggS") return "audio/ogg";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WAVE") return "audio/wav";
  if (bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return "video/webm";
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString("ascii") === "ftyp") return "video/mp4";
  return undefined;
}

function validateName(value: unknown): string {
  if (typeof value !== "string") throw new Error("bad_request");
  const name = value.trim();
  if (!name || name.length > 255 || /[\u0000-\u001f\u007f]/u.test(name)) throw new Error("bad_request");
  return name;
}

export function parseMediaUpload(input: unknown, maxBytes: number): { input: Omit<MediaUploadInput, "dataBase64">; bytes: Buffer } {
  if (!input || typeof input !== "object") throw new Error("bad_request");
  const value = input as Record<string, unknown>;
  if (value.purpose !== "message" && value.purpose !== "avatar" && value.purpose !== "emote") throw new Error("bad_request");
  if (typeof value.contentType !== "string") throw new Error("bad_request");
  const contentType = value.contentType.toLowerCase().split(";", 1)[0]?.trim() ?? "";
  const bytes = decodeBase64(value.dataBase64, maxBytes);
  const sniffed = sniffContentType(bytes);
  if (value.purpose === "avatar" && (!IMAGE_TYPES.has(contentType) || sniffed !== contentType)) throw new Error("bad_request");
  if (value.purpose === "emote" && (!EMOTE_TYPES.has(contentType) || sniffed !== contentType)) throw new Error("bad_request");
  // Opaque message objects may be client-side ciphertext. MP4/WebM are an
  // explicit V1 exception so Chromium can seek with HTTP Range requests; they
  // are transport-protected but are not attachment-E2EE.
  if (value.purpose === "message" && contentType !== "application/octet-stream"
    && (!VIDEO_TYPES.has(contentType) && !EMOTE_TYPES.has(contentType) && !AUDIO_TYPES.has(contentType) || sniffed !== contentType)) throw new Error("bad_request");
  return { input: { purpose: value.purpose, name: validateName(value.name), contentType }, bytes };
}

export function parseRange(value: string | undefined, size: number): { start: number; end: number } | undefined {
  if (!value) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value.trim());
  if (!match || (!match[1] && !match[2]) || value.includes(",")) throw new Error("bad_request");
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) throw new Error("bad_request");
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) throw new Error("bad_request");
  return { start, end: Math.min(end, size - 1) };
}

function reference(row: Row): MediaReference {
  return {
    id: String(row.id ?? row.media_id),
    contentType: String(row.content_type),
    ...(row.width == null ? {} : { width: Number(row.width) }),
    ...(row.height == null ? {} : { height: Number(row.height) }),
    version: new Date(String(row.ready_at ?? row.updated_at ?? row.created_at)).toISOString(),
  };
}

export function communityEmoteFromRow(row: Row): CommunityEmote {
  return {
    id: String(row.emote_id),
    name: String(row.name),
    animated: false,
    media: reference(row),
  };
}

export class MediaService {
  private readonly s3?: S3Client;
  private readonly bucket?: string;
  private bucketReady: Promise<void> | undefined;

  constructor(private readonly database: DatabaseBoundary, private readonly config: ServerConfig) {
    if (config.s3Endpoint && config.s3Bucket && config.s3AccessKey && config.s3SecretKey) {
      this.bucket = config.s3Bucket;
      this.s3 = new S3Client({
        endpoint: config.s3Endpoint,
        region: config.s3Region,
        forcePathStyle: config.s3ForcePathStyle,
        credentials: { accessKeyId: config.s3AccessKey, secretAccessKey: config.s3SecretKey },
      });
    }
  }

  get configured(): boolean { return Boolean(this.s3 && this.bucket); }

  private async ensureBucket(): Promise<void> {
    if (!this.s3 || !this.bucket) throw new Error("media_not_configured");
    this.bucketReady ??= (async () => {
      await this.s3!.send(new HeadBucketCommand({ Bucket: this.bucket! }));
    })().catch((error) => {
      this.bucketReady = undefined;
      throw error;
    });
    await this.bucketReady;
  }

  async upload(userId: string, raw: unknown): Promise<{ media: MediaReference; name: string }> {
    if (!this.s3 || !this.bucket) throw new Error("media_not_configured");
    await this.ensureBucket();
    const parsed = parseMediaUpload(raw, this.config.mediaMaxUploadBytes);
    const access = await effectiveAccess(this.database, userId);
    if (parsed.input.purpose === "message") await requirePermission(this.database, userId, "attachments.create");
    if (parsed.input.purpose === "emote") await requirePermission(this.database, userId, "emotes.create");
    let bytes = parsed.bytes;
    let contentType = parsed.input.contentType;
    let width: number | undefined;
    let height: number | undefined;
    if (parsed.input.purpose === "avatar" || parsed.input.purpose === "emote") {
      // Load the native codec only for image work. This keeps health/auth
      // startup independent from an optional platform binary while the
      // production Node image still installs Sharp for validated uploads.
      const sharp = (await import("sharp")).default;
      const image = sharp(bytes, { animated: parsed.input.purpose === "emote", limitInputPixels: 4096 * 4096 });
      const metadata = await image.metadata().catch(() => { throw new Error("bad_request"); });
      if (!metadata.width || !metadata.height || metadata.width > 4096 || metadata.height > 4096 || (metadata.pages ?? 1) > 100) throw new Error("bad_request");
      const maxDimension = parsed.input.purpose === "avatar" ? 256 : 128;
      bytes = await image.rotate().resize(maxDimension, maxDimension, { fit: "inside", withoutEnlargement: true }).webp({ quality: 86 }).toBuffer();
      const output = await sharp(bytes, { animated: true }).metadata();
      width = output.width;
      height = output.pageHeight ?? output.height;
      contentType = "image/webp";
    }
    if (bytes.length > this.config.mediaMaxUploadBytes) throw new Error("bad_request");

    const mediaId = randomUUID();
    const objectKey = `${access.communityId}/${parsed.input.purpose}/${mediaId}`;
    const sha256 = createHash("sha256").update(bytes).digest();
    if (!this.database.transaction) throw new Error("database_transaction_not_configured");
    await this.database.transaction(async (transaction) => {
      // Serialize quota reservations for this user across API replicas. The
      // pending row is committed before object storage work begins.
      await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [userId]);
      const usage = await transaction.query<Row>(
        `SELECT count(*) FILTER (WHERE state = 'pending' AND created_at > now() - interval '10 minutes')::int AS pending_count,
                COALESCE(sum(byte_size) FILTER (WHERE created_at > now() - interval '24 hours'), 0)::bigint AS recent_bytes
           FROM media_objects WHERE community_id = $1 AND uploaded_by = $2`,
        [access.communityId, userId],
      );
      const pendingCount = Number(usage.rows[0]?.pending_count ?? 0);
      const recentBytes = Number(usage.rows[0]?.recent_bytes ?? 0);
      if (pendingCount >= 2 || !Number.isSafeInteger(recentBytes) || recentBytes + bytes.length > 250 * 1024 * 1024) throw new Error("rate_limited");
      await transaction.query(
        `INSERT INTO media_objects
          (id, community_id, uploaded_by, purpose, object_key, state, encrypted, byte_size, sha256, content_type, width, height)
         VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8, $9, $10, $11)`,
        [mediaId, access.communityId, userId, parsed.input.purpose, objectKey, parsed.input.purpose === "message" && contentType === "application/octet-stream", bytes.length, sha256, contentType, width ?? null, height ?? null],
      );
    });
    try {
      await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: objectKey, Body: bytes, ContentType: contentType }));
      const ready = await this.database.query<Row>(
        `UPDATE media_objects SET state = 'ready', ready_at = now() WHERE id = $1 AND state = 'pending'
         RETURNING id, content_type, width, height, ready_at`, [mediaId],
      );
      if (!ready.rows[0]) throw new Error("internal_error");
      return { media: reference(ready.rows[0]), name: parsed.input.name };
    } catch (error) {
      await this.database.query(`UPDATE media_objects SET state = 'failed' WHERE id = $1 AND state = 'pending'`, [mediaId]).catch(() => undefined);
      await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: objectKey })).catch(() => undefined);
      throw error;
    }
  }

  async open(userId: string, mediaId: string, rangeHeader?: string): Promise<MediaDownload> {
    if (!this.s3 || !this.bucket) throw new Error("media_not_configured");
    await this.ensureBucket();
    if (!UUID.test(mediaId)) throw new Error("not_found");
    const access = await effectiveAccess(this.database, userId);
    const result = await this.database.query<Row>(
      `SELECT mo.*,
              EXISTS (SELECT 1 FROM user_profiles up WHERE up.avatar_media_id = mo.id) AS avatar_active,
              EXISTS (SELECT 1 FROM custom_emotes ce WHERE ce.media_id = mo.id AND ce.deleted_at IS NULL) AS emote_active,
              (SELECT m.channel_id FROM message_attachments ma
                 JOIN messages m ON m.id = ma.message_id AND m.deleted_at IS NULL
                WHERE ma.media_id = mo.id ORDER BY ma.created_at LIMIT 1) AS attachment_channel_id
         FROM media_objects mo
        WHERE mo.id = $1 AND mo.community_id = $2 AND mo.state = 'ready'`,
      [mediaId, access.communityId],
    );
    const row = result.rows[0];
    if (!row) throw new Error("not_found");
    const purpose = String(row.purpose);
    if (purpose === "avatar" && row.avatar_active !== true) throw new Error("not_found");
    if (purpose === "emote" && row.emote_active !== true) throw new Error("not_found");
    if (purpose === "message") {
      const channelId = row.attachment_channel_id ? String(row.attachment_channel_id) : "";
      if (!channelId) throw new Error("not_found");
      const channelAccess = await resolveChannelPermission(this.database, userId, channelId, "messages.read", "text");
      if (!channelAccess.allowed) throw new Error("not_found");
    }
    const size = Number(row.byte_size);
    const range = parseRange(rangeHeader, size);
    const object = await this.s3.send(new GetObjectCommand({
      Bucket: this.bucket,
      Key: String(row.object_key),
      ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}),
    }));
    if (!object.Body || !(Symbol.asyncIterator in object.Body)) throw new Error("internal_error");
    const contentLength = range ? range.end - range.start + 1 : Number(object.ContentLength ?? size);
    return {
      contentType: String(row.content_type),
      contentLength,
      ...(range ? { contentRange: `bytes ${range.start}-${range.end}/${size}` } : {}),
      ...(object.ETag ? { etag: object.ETag } : {}),
      status: range ? 206 : 200,
      body: object.Body as AsyncIterable<Uint8Array>,
    };
  }

  async setAvatar(userId: string, mediaId: string): Promise<{ avatar: MediaReference }> {
    if (!UUID.test(mediaId)) throw new Error("bad_request");
    const access = await effectiveAccess(this.database, userId);
    const media = await this.database.query<Row>(
      `SELECT id, content_type, width, height, ready_at FROM media_objects
        WHERE id = $1 AND community_id = $2 AND uploaded_by = $3 AND purpose = 'avatar' AND state = 'ready'`,
      [mediaId, access.communityId, userId],
    );
    if (!media.rows[0]) throw new Error("not_found");
    await this.database.query(
      `INSERT INTO user_profiles (user_id, avatar_media_id, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (user_id) DO UPDATE SET avatar_media_id = EXCLUDED.avatar_media_id, updated_at = now()`,
      [userId, mediaId],
    );
    return { avatar: reference(media.rows[0]) };
  }

  async removeAvatar(userId: string): Promise<void> {
    await this.database.query(`UPDATE user_profiles SET avatar_media_id = NULL, updated_at = now() WHERE user_id = $1`, [userId]);
  }

  async listEmotes(userId: string): Promise<{ emotes: CommunityEmote[] }> {
    const access = await effectiveAccess(this.database, userId);
    const result = await this.database.query<Row>(
      `SELECT ce.id AS emote_id, ce.name, mo.id AS media_id, mo.content_type, mo.width, mo.height, mo.ready_at
         FROM custom_emotes ce JOIN media_objects mo ON mo.id = ce.media_id AND mo.state = 'ready'
        WHERE ce.community_id = $1 AND ce.deleted_at IS NULL ORDER BY lower(ce.name), ce.id`,
      [access.communityId],
    );
    return { emotes: result.rows.map(communityEmoteFromRow) };
  }

  async createEmote(userId: string, raw: unknown): Promise<{ emote: CommunityEmote }> {
    const value = raw as { name?: unknown; mediaId?: unknown } | null;
    const name = typeof value?.name === "string" ? value.name.trim() : "";
    const mediaId = typeof value?.mediaId === "string" ? value.mediaId : "";
    if (!/^[A-Za-z0-9_]{2,48}$/u.test(name) || !UUID.test(mediaId)) throw new Error("bad_request");
    if (!this.database.transaction) throw new Error("database_transaction_not_configured");
    return this.database.transaction(async (transaction) => {
      const access = await requirePermission(transaction, userId, "emotes.create");
      const result = await transaction.query<Row>(
        `INSERT INTO custom_emotes (community_id, name, media_id, created_by)
         SELECT $1, $2, mo.id, $3
           FROM media_objects mo
          WHERE mo.id = $4 AND mo.community_id = $1 AND mo.uploaded_by = $3
            AND mo.purpose = 'emote' AND mo.state = 'ready'
         RETURNING id, name, media_id`,
        [access.communityId, name, userId, mediaId],
      );
      const created = result.rows[0];
      if (!created) throw new Error("not_found");
      const media = await transaction.query<Row>(
        `SELECT id AS media_id, content_type, width, height, ready_at FROM media_objects WHERE id = $1`, [mediaId],
      );
      await writeAuditEvent(transaction, {
        communityId: access.communityId,
        actorId: userId,
        action: "emote.created",
        targetType: "emote",
        targetId: String(created.id),
        metadata: { name },
      });
      return { emote: { id: String(created.id), name: String(created.name), animated: false, media: reference(media.rows[0]!) } };
    });
  }

  async deleteEmote(userId: string, emoteId: string): Promise<void> {
    if (!UUID.test(emoteId)) throw new Error("not_found");
    if (!this.database.transaction) throw new Error("database_transaction_not_configured");
    await this.database.transaction(async (transaction) => {
      const access = await requirePermission(transaction, userId, "emotes.manage");
      const result = await transaction.query<Row>(
        `UPDATE custom_emotes SET deleted_at = now()
          WHERE id = $1 AND community_id = $2 AND deleted_at IS NULL RETURNING id, name`,
        [emoteId, access.communityId],
      );
      if (!result.rows[0]) throw new Error("not_found");
      await writeAuditEvent(transaction, {
        communityId: access.communityId,
        actorId: userId,
        action: "emote.deleted",
        targetType: "emote",
        targetId: emoteId,
        metadata: { name: String(result.rows[0].name) },
      });
    });
  }
}

export async function writeMediaResponse(response: ServerResponse, download: MediaDownload): Promise<void> {
  response.statusCode = download.status;
  response.setHeader("content-type", download.contentType);
  response.setHeader("content-length", String(download.contentLength));
  response.setHeader("accept-ranges", "bytes");
  response.setHeader("cache-control", "private, max-age=300");
  response.setHeader("x-content-type-options", "nosniff");
  if (download.contentRange) response.setHeader("content-range", download.contentRange);
  if (download.etag) response.setHeader("etag", download.etag);
  try {
    for await (const chunk of download.body) {
      if (!response.write(chunk)) await new Promise<void>((resolve) => response.once("drain", resolve));
    }
    response.end();
  } catch (error) {
    response.destroy(error instanceof Error ? error : new Error("media_stream_failed"));
  }
}
