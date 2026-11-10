import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { EVENT_SCHEMA_VERSION, type EventEnvelope, type EventType } from '@wintek/shared';
import { RedisService } from '../../common/redis/redis.service';
import { correlationId as currentCorrelationId } from '../../common/http/request-context';
import { config } from '../../config';

export interface PublishInput<T = unknown> {
  type: EventType;
  orgId: string;
  entityType: EventEnvelope['entityType'];
  entityId: string;
  entityVersion?: number;
  correlationId?: string | null;
  data: T;
}

type Listener = (e: EventEnvelope) => void;

const CHANNEL = 'wintek:events';
const REPLAY_KEEP = 5000;
const seqKey = (org: string) => `wintek:ev:seq:${org}`;
const bufKey = (org: string) => `wintek:ev:buf:${org}`;

/**
 * Cluster-wide event bus for dashboard updates.
 *
 * Ordering: each organization has one monotonically increasing sequence
 * (Redis INCR). Every event is stored in a capped per-org replay buffer
 * (sorted set by seq) and published to all API nodes, which forward it to
 * their WebSocket clients. Clients detect gaps and ask for a replay; if the
 * buffer no longer reaches back far enough they are told to resync from REST.
 *
 * Events are notifications, not the record: the durable state is always in
 * PostgreSQL and is written BEFORE the event is published, so a lost event
 * costs freshness, never correctness.
 *
 * Without Redis (dev, or during a Redis outage) events are delivered to this
 * node's clients only, with seq = 0 ("unsequenced"); clients apply them by
 * entityVersion and resync when sequencing resumes.
 */
@Injectable()
export class EventBusService implements OnModuleInit {
  private readonly log = new Logger(EventBusService.name);
  private readonly listeners = new Set<Listener>();
  private localSeq = new Map<string, number>();
  private localBuf = new Map<string, EventEnvelope[]>();
  private redisWasDown = false;

  constructor(private readonly redis: RedisService) {}

  async onModuleInit() {
    const sub = this.redis.subscriber;
    if (!sub) return;
    await sub.subscribe(CHANNEL).catch((e) => this.log.error(`subscribe failed: ${e.message}`));
    sub.on('message', (_ch, msg) => {
      try {
        this.dispatch(JSON.parse(msg));
      } catch (e: any) {
        this.log.warn(`bad event payload: ${e.message}`);
      }
    });
  }

  on(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private dispatch(e: EventEnvelope) {
    for (const l of this.listeners) {
      try {
        l(e);
      } catch (err: any) {
        this.log.error(`listener failed: ${err.message}`);
      }
    }
  }

  async publish<T>(input: PublishInput<T>): Promise<EventEnvelope<EventType, T>> {
    const base = {
      id: randomUUID(),
      type: input.type,
      schemaVersion: EVENT_SCHEMA_VERSION,
      ts: new Date().toISOString(),
      orgId: input.orgId,
      entityType: input.entityType,
      entityId: input.entityId,
      entityVersion: input.entityVersion ?? 0,
      correlationId: input.correlationId ?? currentCorrelationId(),
      data: input.data,
    };
    const r = this.redis.client;
    if (r && this.redis.isHealthy) {
      try {
        const seq = await r.incr(seqKey(input.orgId));
        const env = { ...base, seq } as EventEnvelope<EventType, T>;
        const json = JSON.stringify(env);
        await r
          .multi()
          .zadd(bufKey(input.orgId), seq, json)
          .zremrangebyrank(bufKey(input.orgId), 0, -REPLAY_KEEP - 1)
          .publish(CHANNEL, json)
          .exec();
        if (this.redisWasDown) {
          this.redisWasDown = false;
          this.dispatch(this.resyncEnvelope(input.orgId, 'event sequencing restored'));
        }
        return env;
      } catch (e: any) {
        this.log.error(`redis publish failed, delivering locally: ${e.message}`);
      }
    }
    if (r) this.redisWasDown = true;
    const seq = r ? 0 : this.nextLocalSeq(input.orgId);
    const env = { ...base, seq } as EventEnvelope<EventType, T>;
    if (!r) this.pushLocal(env);
    this.dispatch(env);
    return env;
  }

  /** Events with seq > since, or null when the buffer can't cover the gap (client must resync). */
  async replay(orgId: string, since: number): Promise<EventEnvelope[] | null> {
    const r = this.redis.client;
    if (r) {
      const items = await r.zrangebyscore(bufKey(orgId), `(${since}`, '+inf');
      const events = items.map((i) => JSON.parse(i) as EventEnvelope);
      const current = Number((await r.get(seqKey(orgId))) ?? 0);
      if (since > current) return null; // sequence went backwards: Redis was reset
      if (current > since && (events.length === 0 || events[0]!.seq !== since + 1)) return null;
      return events;
    }
    const buf = this.localBuf.get(orgId) ?? [];
    const current = this.localSeq.get(orgId) ?? 0;
    if (since > current) return null;
    const events = buf.filter((e) => e.seq > since);
    if (current > since && (events.length === 0 || events[0]!.seq !== since + 1)) return null;
    return events;
  }

  async currentSeq(orgId: string): Promise<number> {
    const r = this.redis.client;
    if (r) return Number((await r.get(seqKey(orgId)).catch(() => 0)) ?? 0);
    return this.localSeq.get(orgId) ?? 0;
  }

  resyncEnvelope(orgId: string, reason: string): EventEnvelope {
    return {
      id: randomUUID(),
      type: 'system.resync_required',
      schemaVersion: EVENT_SCHEMA_VERSION,
      ts: new Date().toISOString(),
      orgId,
      entityType: 'system',
      entityId: config().NODE_ID,
      seq: 0,
      entityVersion: 0,
      correlationId: null,
      data: { reason },
    };
  }

  private nextLocalSeq(org: string) {
    const n = (this.localSeq.get(org) ?? 0) + 1;
    this.localSeq.set(org, n);
    return n;
  }

  private pushLocal(e: EventEnvelope) {
    const b = this.localBuf.get(e.orgId) ?? [];
    b.push(e);
    if (b.length > REPLAY_KEEP) b.splice(0, b.length - REPLAY_KEEP);
    this.localBuf.set(e.orgId, b);
  }
}
