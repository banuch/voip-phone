import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { config } from '../../config';

export type Queryable = Pick<PoolClient, 'query'>;

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly log = new Logger(DatabaseService.name);
  readonly pool: Pool;

  constructor() {
    this.pool = new Pool({
      connectionString: config().DATABASE_URL,
      max: config().DATABASE_POOL_MAX,
      application_name: config().NODE_ID,
      statement_timeout: 10_000,
      idle_in_transaction_session_timeout: 15_000,
    });
    this.pool.on('error', (e) => this.log.error(`idle client error: ${e.message}`));
  }

  async query<T extends QueryResultRow = any>(sql: string, params: unknown[] = []): Promise<T[]> {
    const r = await this.pool.query<T>(sql, params);
    return r.rows;
  }

  async one<T extends QueryResultRow = any>(sql: string, params: unknown[] = []): Promise<T | null> {
    return (await this.query<T>(sql, params))[0] ?? null;
  }

  /**
   * Run `fn` in a READ COMMITTED transaction. Callers take row locks with
   * SELECT ... FOR UPDATE; unique indexes are the last line of defence.
   * Serialization failures and deadlocks are retried.
   */
  async tx<T>(fn: (c: PoolClient) => Promise<T>, retries = 3): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const c = await this.pool.connect();
      try {
        await c.query('BEGIN');
        const out = await fn(c);
        await c.query('COMMIT');
        return out;
      } catch (e: any) {
        await c.query('ROLLBACK').catch(() => undefined);
        if (attempt < retries && (e?.code === '40001' || e?.code === '40P01')) continue;
        throw e;
      } finally {
        c.release();
      }
    }
  }

  /**
   * Cluster-wide leader election for a background job using a session-level
   * advisory lock. Returns a release function, or null if another node holds it.
   * The lock disappears with the connection, so a crashed node never keeps it.
   */
  async tryLeader(key: number): Promise<(() => Promise<void>) | null> {
    const c = await this.pool.connect();
    try {
      const r = await c.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [key]);
      if (!r.rows[0]?.ok) {
        c.release();
        return null;
      }
      return async () => {
        await c.query('SELECT pg_advisory_unlock($1)', [key]).catch(() => undefined);
        c.release();
      };
    } catch (e) {
      c.release();
      throw e;
    }
  }

  /**
   * Long-lived leadership (e.g. "this node consumes ARI events for media node X").
   * Holds a dedicated connection with a session advisory lock. `alive()` checks
   * the connection still works; if it fails the lock is gone (PostgreSQL
   * released it with the session) and the caller must step down.
   */
  async holdLeadership(key: number): Promise<{ alive: () => Promise<boolean>; release: () => Promise<void> } | null> {
    const c = await this.pool.connect();
    let ok = false;
    try {
      ok = !!(await c.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [key])).rows[0]?.ok;
    } finally {
      if (!ok) c.release();
    }
    if (!ok) return null;
    let broken = false;
    c.on('error', () => (broken = true));
    return {
      alive: async () => {
        if (broken) return false;
        try {
          await c.query('SELECT 1');
          return true;
        } catch {
          broken = true;
          return false;
        }
      },
      release: async () => {
        await c.query('SELECT pg_advisory_unlock($1)', [key]).catch(() => undefined);
        c.release(broken);
      },
    };
  }

  async ping(): Promise<number> {
    const t = Date.now();
    await this.pool.query('SELECT 1');
    return Date.now() - t;
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}

export const isUniqueViolation = (e: any, constraint?: string) =>
  e?.code === '23505' && (!constraint || e?.constraint === constraint);
