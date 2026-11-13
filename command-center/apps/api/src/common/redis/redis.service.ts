import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { config } from '../../config';

/**
 * Redis is used for transient data only: event fan-out between API nodes,
 * per-org event sequence counters and a short replay buffer, device last-seen
 * caching and rate-limit counters. Nothing that must survive is kept only in
 * Redis: calls, queue, presence and audit are durable in PostgreSQL.
 *
 * With REDIS_URL empty (development) the service is disabled and callers use
 * their in-process fallbacks.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly log = new Logger(RedisService.name);
  readonly client: Redis | null;
  readonly subscriber: Redis | null;
  private healthy = false;

  constructor() {
    const url = config().REDIS_URL;
    if (!url) {
      this.client = null;
      this.subscriber = null;
      this.log.warn('REDIS_URL not set: running single-node without Redis');
      return;
    }
    const opts = { maxRetriesPerRequest: 2, enableOfflineQueue: false, lazyConnect: false } as const;
    this.client = new Redis(url, opts);
    this.subscriber = new Redis(url, { ...opts, enableOfflineQueue: true });
    this.client.on('ready', () => {
      this.healthy = true;
      this.log.log('redis ready');
    });
    this.client.on('error', (e) => {
      if (this.healthy) this.log.error(`redis error: ${e.message}`);
      this.healthy = false;
    });
    this.client.on('end', () => (this.healthy = false));
  }

  get enabled() {
    return this.client !== null;
  }

  get isHealthy() {
    return this.healthy;
  }

  async ping(): Promise<number | null> {
    if (!this.client) return null;
    const t = Date.now();
    await this.client.ping();
    return Date.now() - t;
  }

  async onModuleDestroy() {
    await Promise.all([this.client?.quit().catch(() => undefined), this.subscriber?.quit().catch(() => undefined)]);
  }
}
