import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RealtimeEvent, RealtimeEventKind } from "./contracts.js";
import type { DatabaseBoundary } from "./database.js";
import { effectiveAccess, resolveChannelPermission } from "./authorization.js";

export interface RealtimeEventInput {
  kind: RealtimeEventKind;
  communityId: string;
  actorId: string;
  channelId?: string;
  messageId?: string;
}

interface Subscriber {
  id: string;
  userId: string;
  communityId: string;
  response: ServerResponse;
  revalidate: () => Promise<void>;
  delivery: Promise<void>;
  close: () => void;
}

interface HistoryEntry {
  input: RealtimeEventInput;
  event: RealtimeEvent;
}

interface SubscribeOptions {
  maxConnectionMs?: number;
  revalidate: () => Promise<void>;
}

export interface RealtimeBrokerOptions {
  heartbeatMs?: number;
  maxConnections?: number;
  maxConnectionsPerUser?: number;
  maxConnectionMs?: number;
  maxHistory?: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function validIdentifier(value: string): boolean {
  return UUID.test(value) || /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(value);
}

function clientEvent(input: RealtimeEventInput): RealtimeEvent {
  if (!validIdentifier(input.actorId)
    || input.channelId !== undefined && !validIdentifier(input.channelId)
    || input.messageId !== undefined && !validIdentifier(input.messageId)) throw new Error("bad_request");
  return {
    id: randomUUID(),
    kind: input.kind,
    occurredAt: new Date().toISOString(),
    actorId: input.actorId,
    ...(input.channelId ? { channelId: input.channelId } : {}),
    ...(input.messageId ? { messageId: input.messageId } : {}),
  };
}

function writeEvent(response: ServerResponse, event: RealtimeEvent): boolean {
  return response.write(`id: ${event.id}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`);
}

/**
 * Single-process realtime invalidation broker. It deliberately carries only
 * identifiers; the authenticated REST API remains authoritative for content.
 */
export class RealtimeBroker {
  private readonly subscribers = new Map<string, Subscriber>();
  private readonly heartbeat: NodeJS.Timeout;
  private readonly heartbeatMs: number;
  private readonly maxConnections: number;
  private readonly maxConnectionsPerUser: number;
  private readonly maxConnectionMs: number;
  private readonly maxHistory: number;
  private readonly history: HistoryEntry[] = [];

  constructor(private readonly database: DatabaseBoundary, options: RealtimeBrokerOptions = {}) {
    this.heartbeatMs = options.heartbeatMs ?? 15_000;
    this.maxConnections = options.maxConnections ?? 256;
    this.maxConnectionsPerUser = options.maxConnectionsPerUser ?? 5;
    this.maxConnectionMs = options.maxConnectionMs ?? 6 * 60 * 60 * 1000;
    this.maxHistory = options.maxHistory ?? 1_000;
    this.heartbeat = setInterval(() => {
      for (const subscriber of this.subscribers.values()) {
        void this.authorized(subscriber).then((authorized) => {
          if (authorized && !subscriber.response.write(`: heartbeat ${Date.now()}\n\n`)) subscriber.close();
        });
      }
    }, this.heartbeatMs);
    this.heartbeat.unref();
  }

  private async authorized(subscriber: Subscriber): Promise<boolean> {
    try {
      await subscriber.revalidate();
      const access = await effectiveAccess(this.database, subscriber.userId);
      if (access.communityId !== subscriber.communityId) throw new Error("forbidden");
      return true;
    } catch {
      subscriber.close();
      return false;
    }
  }

  private async deliver(subscriber: Subscriber, entry: HistoryEntry): Promise<void> {
    if (subscriber.communityId !== entry.input.communityId || subscriber.response.writableEnded) return;
    if (!await this.authorized(subscriber)) return;
    if (entry.input.channelId) {
      try {
        const access = await resolveChannelPermission(this.database, subscriber.userId, entry.input.channelId, "messages.read", "text");
        if (!access.allowed || access.communityId !== entry.input.communityId) return;
      } catch {
        return;
      }
    }
    if (!writeEvent(subscriber.response, entry.event)) subscriber.close();
  }

  private enqueue(subscriber: Subscriber, entry: HistoryEntry): Promise<void> {
    subscriber.delivery = subscriber.delivery
      .then(() => this.deliver(subscriber, entry))
      .catch(() => subscriber.close());
    return subscriber.delivery;
  }

  async subscribe(request: IncomingMessage, response: ServerResponse, userId: string, options: SubscribeOptions): Promise<() => void> {
    if (this.subscribers.size >= this.maxConnections) throw new Error("rate_limited");
    let perUser = 0;
    for (const subscriber of this.subscribers.values()) if (subscriber.userId === userId) perUser += 1;
    if (perUser >= this.maxConnectionsPerUser) throw new Error("rate_limited");
    const access = await effectiveAccess(this.database, userId);
    response.statusCode = 200;
    response.setHeader("content-type", "text/event-stream; charset=utf-8");
    response.setHeader("cache-control", "no-store, no-transform");
    response.setHeader("connection", "keep-alive");
    response.setHeader("x-accel-buffering", "no");
    response.flushHeaders();
    response.write(`: connected ${Date.now()}\n\n`);

    const id = randomUUID();
    let closed = false;
    let lifetime: NodeJS.Timeout;
    const close = () => {
      if (closed) return;
      closed = true;
      clearTimeout(lifetime);
      this.subscribers.delete(id);
      if (!response.writableEnded) response.end();
    };
    lifetime = setTimeout(close, Math.min(this.maxConnectionMs, options.maxConnectionMs ?? this.maxConnectionMs));
    lifetime.unref();
    const subscriber: Subscriber = { id, userId, communityId: access.communityId, response, revalidate: options.revalidate, delivery: Promise.resolve(), close };
    this.subscribers.set(id, subscriber);
    request.once("close", close);
    response.once("close", close);
    const lastEventId = Array.isArray(request.headers["last-event-id"])
      ? request.headers["last-event-id"][0]
      : request.headers["last-event-id"];
    if (lastEventId) {
      const cursor = this.history.findIndex((entry) => entry.event.id === lastEventId);
      if (cursor < 0) {
        this.enqueue(subscriber, {
          input: { kind: "sync.required", communityId: access.communityId, actorId: userId },
          event: clientEvent({ kind: "sync.required", communityId: access.communityId, actorId: userId }),
        });
      } else {
        for (const entry of this.history.slice(cursor + 1)) this.enqueue(subscriber, entry);
      }
      await subscriber.delivery;
    }
    return close;
  }

  async publish(input: RealtimeEventInput): Promise<RealtimeEvent> {
    const event = clientEvent(input);
    const entry = { input, event };
    this.history.push(entry);
    if (this.history.length > this.maxHistory) this.history.splice(0, this.history.length - this.maxHistory);
    await Promise.all([...this.subscribers.values()].map((subscriber) => this.enqueue(subscriber, entry)));
    return event;
  }

  close(): void {
    clearInterval(this.heartbeat);
    for (const subscriber of [...this.subscribers.values()]) subscriber.close();
  }

  get connectionCount(): number {
    return this.subscribers.size;
  }
}
