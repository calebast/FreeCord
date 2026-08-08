import type { AuditEvent, AuditLogResponse } from "./contracts.js";
import type { DatabaseBoundary } from "./database.js";
import { requirePermission } from "./authorization.js";

type AuditMetadataValue = string | number | boolean | null;

export interface WriteAuditEventInput {
  communityId: string;
  actorId: string;
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, AuditMetadataValue>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const LABEL = /^[a-z][a-z0-9_.-]{0,79}$/u;

function boundedMetadata(value: Record<string, AuditMetadataValue> | undefined): Record<string, AuditMetadataValue> {
  const metadata = value ?? {};
  if (Object.getPrototypeOf(metadata) !== Object.prototype || Object.keys(metadata).length > 20) throw new Error("bad_request");
  for (const [key, item] of Object.entries(metadata)) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(key)
      || !(item === null || typeof item === "string" || typeof item === "number" && Number.isFinite(item) || typeof item === "boolean")
      || typeof item === "string" && item.length > 500) throw new Error("bad_request");
  }
  if (Buffer.byteLength(JSON.stringify(metadata), "utf8") > 4096) throw new Error("bad_request");
  return metadata;
}

export async function writeAuditEvent(database: DatabaseBoundary, input: WriteAuditEventInput): Promise<void> {
  if (!input.communityId || input.communityId.length > 160 || !input.actorId || input.actorId.length > 160 || !LABEL.test(input.action)
    || input.targetType !== undefined && !LABEL.test(input.targetType)
    || (input.targetType === undefined) !== (input.targetId === undefined)
    || input.targetId !== undefined && (!input.targetId || input.targetId.length > 160)) throw new Error("bad_request");
  await database.query(
    `INSERT INTO audit_events (community_id, actor_user_id, action, target_type, target_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [input.communityId, input.actorId, input.action, input.targetType ?? null, input.targetId ?? null, JSON.stringify(boundedMetadata(input.metadata))],
  );
}

function encodeCursor(row: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify({ id: String(row.id), createdAt: new Date(String(row.created_at)).toISOString() }), "utf8").toString("base64url");
}

function decodeCursor(value: string | undefined): { id: string; createdAt: string } | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { id?: unknown; createdAt?: unknown };
    if (typeof parsed.id !== "string" || !UUID.test(parsed.id) || typeof parsed.createdAt !== "string" || Number.isNaN(Date.parse(parsed.createdAt))) throw new Error("bad_cursor");
    return { id: parsed.id, createdAt: new Date(parsed.createdAt).toISOString() };
  } catch {
    throw new Error("bad_request");
  }
}

function fromRow(row: Record<string, unknown>): AuditEvent {
  const rawMetadata = row.metadata;
  const metadata = rawMetadata && typeof rawMetadata === "object" && !Array.isArray(rawMetadata)
    ? rawMetadata as Record<string, AuditMetadataValue>
    : {};
  return {
    id: String(row.id),
    action: String(row.action),
    ...(row.actor_user_id == null ? {} : { actorId: String(row.actor_user_id) }),
    actorUsername: String(row.actor_username),
    actorDisplayName: String(row.actor_display_name),
    ...(row.target_type == null ? {} : { targetType: String(row.target_type) }),
    ...(row.target_id == null ? {} : { targetId: String(row.target_id) }),
    metadata,
    createdAt: new Date(String(row.created_at)).toISOString(),
  };
}

export async function listAuditEvents(
  database: DatabaseBoundary,
  userId: string,
  options: { limit?: number; before?: string } = {},
): Promise<AuditLogResponse> {
  const access = await requirePermission(database, userId, "audit.view");
  const limit = Number.isInteger(options.limit) ? Math.max(1, Math.min(options.limit!, 100)) : 50;
  const cursor = decodeCursor(options.before);
  const result = await database.query<Record<string, unknown>>(
    `SELECT ae.id, ae.actor_user_id, COALESCE(actor.username, '[deleted]') AS actor_username,
            COALESCE(actor.display_name, 'Deleted user') AS actor_display_name, ae.action,
            ae.target_type, ae.target_id, ae.metadata, ae.created_at
       FROM audit_events ae LEFT JOIN users actor ON actor.id = ae.actor_user_id
      WHERE ae.community_id = $1
        AND ($2::timestamptz IS NULL OR (ae.created_at, ae.id) < ($2::timestamptz, $3::uuid))
      ORDER BY ae.created_at DESC, ae.id DESC LIMIT $4`,
    [access.communityId, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1],
  );
  const hasMore = result.rows.length > limit;
  const rows = result.rows.slice(0, limit);
  return { events: rows.map(fromRow), ...(hasMore && rows.at(-1) ? { nextCursor: encodeCursor(rows.at(-1)!) } : {}) };
}
