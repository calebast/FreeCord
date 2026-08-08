import type { SharedFile, SharedFilesResponse } from "./contracts.js";
import type { DatabaseBoundary } from "./database.js";
import { effectiveAccess, requireChannelPermission } from "./authorization.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function decodeCursor(value: string | undefined): { mediaId: string; sharedAt: string } | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { mediaId?: unknown; sharedAt?: unknown };
    if (typeof parsed.mediaId !== "string" || !UUID.test(parsed.mediaId)
      || typeof parsed.sharedAt !== "string" || Number.isNaN(Date.parse(parsed.sharedAt))) throw new Error("bad_cursor");
    return { mediaId: parsed.mediaId, sharedAt: new Date(parsed.sharedAt).toISOString() };
  } catch {
    throw new Error("bad_request");
  }
}

function encodeCursor(row: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify({ mediaId: String(row.media_id), sharedAt: new Date(String(row.shared_at)).toISOString() }), "utf8").toString("base64url");
}

function fromRow(row: Record<string, unknown>): SharedFile {
  return {
    media: {
      id: String(row.media_id),
      contentType: String(row.content_type),
      ...(row.width == null ? {} : { width: Number(row.width) }),
      ...(row.height == null ? {} : { height: Number(row.height) }),
      version: new Date(String(row.ready_at)).toISOString(),
    },
    byteSize: Number(row.byte_size),
    encrypted: row.encrypted === true,
    position: Number(row.position),
    messageId: String(row.message_id),
    channelId: String(row.channel_id),
    channelName: String(row.channel_name),
    authorId: String(row.author_id),
    authorUsername: String(row.author_username),
    authorDisplayName: String(row.author_display_name),
    sharedAt: new Date(String(row.shared_at)).toISOString(),
  };
}

export async function listSharedFiles(
  database: DatabaseBoundary,
  userId: string,
  options: { limit?: number; before?: string; channelId?: string } = {},
): Promise<SharedFilesResponse> {
  const access = await effectiveAccess(database, userId);
  if (options.channelId) {
    if (!UUID.test(options.channelId)) throw new Error("bad_request");
    await requireChannelPermission(database, userId, options.channelId, "messages.read", "text");
  }
  const limit = Number.isInteger(options.limit) ? Math.max(1, Math.min(options.limit!, 100)) : 50;
  const cursor = decodeCursor(options.before);
  const result = await database.query<Record<string, unknown>>(
    `SELECT mo.id AS media_id, mo.content_type, mo.byte_size, mo.encrypted,
            mo.width, mo.height, mo.ready_at, ma.position, ma.created_at AS shared_at,
            m.id AS message_id, m.channel_id,
            c.name AS channel_name, u.id AS author_id, u.username AS author_username,
            u.display_name AS author_display_name
       FROM message_attachments ma
       JOIN media_objects mo ON mo.id = ma.media_id AND mo.state = 'ready' AND mo.deleted_at IS NULL
       JOIN messages m ON m.id = ma.message_id AND m.deleted_at IS NULL
       JOIN channels c ON c.id = m.channel_id AND c.community_id = $1 AND c.type = 'text' AND NOT c.is_archived
       JOIN users u ON u.id = m.author_id
      WHERE ($2::uuid IS NULL OR c.id = $2::uuid)
        AND ($3::timestamptz IS NULL OR (ma.created_at, mo.id) < ($3::timestamptz, $4::uuid))
        AND ($6::boolean OR COALESCE(
          (SELECT cpo.granted
             FROM channel_permission_overrides cpo
             JOIN member_roles mr ON mr.community_id = cpo.community_id
              AND mr.role_id = cpo.role_id AND mr.user_id = $7
             JOIN roles r ON r.community_id = mr.community_id AND r.id = mr.role_id
            WHERE cpo.community_id = c.community_id AND cpo.channel_id = c.id
              AND cpo.permission_key = 'messages.read'
            ORDER BY r.position DESC, cpo.granted ASC, r.id LIMIT 1),
          (SELECT rp.granted
             FROM member_roles mr
             JOIN roles r ON r.community_id = mr.community_id AND r.id = mr.role_id
             JOIN role_permissions rp ON rp.role_id = r.id AND rp.permission_key = 'messages.read'
            WHERE mr.community_id = c.community_id AND mr.user_id = $7
            ORDER BY r.position DESC, rp.granted ASC, r.id LIMIT 1), false))
      ORDER BY ma.created_at DESC, mo.id DESC LIMIT $5`,
    [access.communityId, options.channelId ?? null, cursor?.sharedAt ?? null, cursor?.mediaId ?? null, limit + 1, access.isOwner, userId],
  );
  const hasMore = result.rows.length > limit;
  const rows = result.rows.slice(0, limit);
  return { files: rows.map(fromRow), ...(hasMore && rows.at(-1) ? { nextCursor: encodeCursor(rows.at(-1)!) } : {}) };
}
