/* Minimal forward-only migration runner: applies migrations/NNN_*.sql in order, once. */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { config } from '../../config';

export async function migrate(databaseUrl = config().DATABASE_URL, log = console.log): Promise<string[]> {
  const dir = join(__dirname, '../../../migrations');
  const c = new Client({ connectionString: databaseUrl });
  await c.connect();
  const applied: string[] = [];
  try {
    await c.query('SELECT pg_advisory_lock(7300001)');
    await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set((await c.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    for (const f of readdirSync(dir).filter((f) => /^\d+_.*\.sql$/.test(f)).sort()) {
      if (done.has(f)) continue;
      log(`applying ${f}`);
      await c.query('BEGIN');
      try {
        await c.query(readFileSync(join(dir, f), 'utf8'));
        await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
        await c.query('COMMIT');
        applied.push(f);
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      }
    }
  } finally {
    await c.query('SELECT pg_advisory_unlock(7300001)').catch(() => undefined);
    await c.end();
  }
  return applied;
}

if (require.main === module) {
  migrate().then(
    (a) => console.log(a.length ? `applied ${a.length} migration(s)` : 'schema up to date'),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}
