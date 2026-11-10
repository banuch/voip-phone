/**
 * Integration tests against a real PostgreSQL (TEST_DATABASE_URL or DATABASE_URL,
 * migrated). Exercise the HTTP API with the simulated SIP driver, so the same
 * reservation SQL, unique indexes, state machine and sweeper run as in production.
 */
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { createApp } from '../src/bootstrap';
import { CallSweeperService } from '../src/modules/calls/call-sweeper.service';
import { QueueService } from '../src/modules/queue/queue.service';
import { DB_URL, createOrgFixture, describeDb, freshHeartbeats, sleep, tokenFor, waitFor, type OrgFixture } from './fixtures';


describeDb('call control (integration)', () => {
  let app: INestApplication;
  let pool: Pool;
  let f: OrgFixture;
  let tokens: string[];
  let n = 0;
  const rid = () => `test-${Date.now()}-${n++}`;
  const http = () => request(app.getHttpServer());
  const initiate = (tok: string, body: Record<string, unknown>) =>
    http().post('/api/v1/calls/initiate').set('Authorization', `Bearer ${tok}`).send({ requestId: rid(), ...body });
  const status = async (tok: string, id: string) => (await http().get(`/api/v1/calls/${id}/status`).set('Authorization', `Bearer ${tok}`)).body;
  const hangup = (tok: string, id: string) => http().post(`/api/v1/calls/${id}/hangup`).set('Authorization', `Bearer ${tok}`);

  beforeAll(async () => {
    pool = new Pool({ connectionString: DB_URL });
    app = await createApp({ logger: false });
    await app.init();
    f = await createOrgFixture(pool, 3, 4);
    tokens = await Promise.all(f.operators.map((_, i) => tokenFor(app, f, i)));
  });

  afterAll(async () => {
    await sleep(300);
    await app?.close();
    await pool?.end();
  });

  beforeEach(async () => {
    await freshHeartbeats(pool, f);
  });

  async function endAll() {
    const active = await pool.query(
      `SELECT id, operator_id FROM call_sessions WHERE organization_id = $1 AND state IN ('RESERVED','DIALING','RINGING','CONNECTED','TERMINATING')`,
      [f.orgId],
    );
    for (const c of active.rows) {
      const idx = f.operators.findIndex((o) => o.operatorId === c.operator_id);
      await hangup(tokens[idx]!, c.id);
    }
    await waitFor(
      async () => (await pool.query(`SELECT count(*)::int AS n FROM call_sessions WHERE organization_id = $1 AND state IN ('RESERVED','DIALING','RINGING','CONNECTED','TERMINATING')`, [f.orgId])).rows[0].n,
      (v) => v === 0,
    );
    await pool.query(`UPDATE call_queue SET state = 'CANCELLED', closed_at = now() WHERE organization_id = $1 AND state IN ('WAITING','OFFERED')`, [f.orgId]);
  }
  afterEach(endAll);

  it('runs the full operator-initiated flow and only reports CONNECTED after the ATM answers', async () => {
    const r = await initiate(tokens[1]!, { atmId: f.atms[0] });
    expect(r.status).toBe(200);
    expect(r.body.call.state).toBe('RESERVED');
    expect(r.body.dial.target).toMatch(/^sip:call-/);
    expect(r.body.dial.headers['X-Wintek-Call-Token']).toBeTruthy();
    const id = r.body.call.id;

    const connected = await waitFor(() => status(tokens[1]!, id), (s) => s.state === 'CONNECTED');
    expect(connected.answeredAt).toBeTruthy();
    expect(connected.events.map((e: any) => e.to)).toEqual(['REQUESTED', 'VALIDATING', 'RESERVED', 'DIALING', 'RINGING', 'CONNECTED']);

    const presence = await pool.query(`SELECT effective FROM operator_presence WHERE operator_id = $1`, [f.operators[1]!.operatorId]);
    expect(presence.rows[0].effective).toBe('BUSY');

    await sleep(200);
    expect((await hangup(tokens[1]!, id)).status).toBe(200);
    const done = await waitFor(() => status(tokens[1]!, id), (s) => s.state === 'COMPLETED');
    expect(done.durationMs).toBeGreaterThan(0);
    expect(done.hangupBy).toBe('OPERATOR');
    const after = await pool.query(`SELECT effective FROM operator_presence WHERE operator_id = $1`, [f.operators[1]!.operatorId]);
    expect(after.rows[0].effective).toBe('AVAILABLE');
  });

  it('allows exactly one reservation when many operators call the same ATM at once', async () => {
    // Operators 1 and 2 are both authorized (same region); operator 0 is a supervisor (call any).
    const attempts = await Promise.all(
      [0, 1, 2, 0, 1, 2].map((i) => initiate(tokens[i]!, { atmId: f.atms[1] })),
    );
    const ok = attempts.filter((a) => a.status === 200);
    const codes = attempts.filter((a) => a.status !== 200).map((a) => a.body.code);
    expect(ok).toHaveLength(1);
    expect(codes.every((c) => c === 'ATM_BUSY' || c === 'OPERATOR_BUSY')).toBe(true);
    const active = await pool.query(`SELECT count(*)::int AS n FROM call_sessions WHERE atm_id = $1 AND state IN ('RESERVED','DIALING','RINGING','CONNECTED','TERMINATING')`, [f.atms[1]]);
    expect(active.rows[0].n).toBe(1);
  });

  it('allows one active call per operator even when they dial two ATMs concurrently', async () => {
    const [a, b] = await Promise.all([initiate(tokens[2]!, { atmId: f.atms[2] }), initiate(tokens[2]!, { atmId: f.atms[3] })]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    expect([a.body.code, b.body.code]).toContain('OPERATOR_BUSY');
  });

  it('is idempotent on requestId', async () => {
    const requestId = rid();
    const one = await initiate(tokens[1]!, { atmId: f.atms[0], requestId });
    const two = await initiate(tokens[1]!, { atmId: f.atms[0], requestId });
    expect(one.status).toBe(200);
    expect(two.status).toBe(200);
    expect(two.body.call.id).toBe(one.body.call.id);
    expect(two.body.replayed).toBe(true);
    const count = await pool.query(`SELECT count(*)::int AS n FROM call_sessions WHERE request_id = $1`, [requestId]);
    expect(count.rows[0].n).toBe(1);
  });

  it('refuses offline ATMs, unassigned ATMs, offline operators and other tenants', async () => {
    expect((await initiate(tokens[1]!, { atmId: f.offlineAtm })).body.code).toBe('ATM_OFFLINE');
    expect((await initiate(tokens[1]!, { atmId: f.otherRegionAtm })).body.code).toBe('NOT_AUTHORIZED');
    // Supervisors hold call:initiate:any.
    const sup = await initiate(tokens[0]!, { atmId: f.otherRegionAtm });
    expect(sup.status).toBe(200);
    expect(sup.body.call.routingDecision).toBe('SUPERVISOR');

    await pool.query(`UPDATE operator_presence SET last_heartbeat_at = now() - interval '5 minutes' WHERE operator_id = $1`, [f.operators[2]!.operatorId]);
    const off = await initiate(tokens[2]!, { atmId: f.atms[2] });
    expect(off.body.code).toBe('OPERATOR_UNAVAILABLE');
    expect(off.body.details.availability).toBe('OFFLINE');

    const other = await createOrgFixture(pool, 1, 1);
    const foreign = await initiate(tokens[1]!, { atmId: other.atms[0] });
    expect(foreign.status).toBe(404);
  });

  it('times out a reservation whose browser never dials and releases ATM and operator', async () => {
    // Stop the simulator from "dialing" by voiding the token right after reserving.
    const r = await initiate(tokens[1]!, { atmId: f.atms[2] });
    await pool.query(`UPDATE call_sessions SET dial_token_hash = NULL, state_changed_at = now() - interval '20 seconds' WHERE id = $1`, [r.body.call.id]);
    await sleep(500); // simulated INVITE arrives and is rejected (no token)
    // (Another API node sharing this database may sweep it first; the outcome is what matters.)
    await app.get(CallSweeperService).sweepTimeouts();
    const s = await status(tokens[1]!, r.body.call.id);
    expect(s.state).toBe('TIMEOUT');
    // Released: the same operator can immediately call the same ATM.
    const again = await initiate(tokens[1]!, { atmId: f.atms[2] });
    expect(again.status).toBe(200);
  });

  it('queues a request for a busy ATM and offers it to the requester when the ATM frees up', async () => {
    const first = await initiate(tokens[1]!, { atmId: f.atms[3] });
    expect(first.status).toBe(200);
    const q = await initiate(tokens[2]!, { atmId: f.atms[3], queueIfBusy: true, priority: 'P1' });
    expect(q.status).toBe(200);
    expect(q.body.queued).toBe(true);
    const itemId = q.body.queueItem.id;

    await waitFor(() => status(tokens[1]!, first.body.call.id), (s) => s.state === 'CONNECTED');
    await hangup(tokens[1]!, first.body.call.id);
    await waitFor(() => status(tokens[1]!, first.body.call.id), (s) => s.state === 'COMPLETED');

    await app.get(QueueService).dispatch();
    const row = (await pool.query(`SELECT state, offered_operator_id FROM call_queue WHERE id = $1`, [itemId])).rows[0];
    expect(row.state).toBe('OFFERED');
    expect(row.offered_operator_id).toBe(f.operators[2]!.operatorId);

    // Accepting the offer = placing the call; it fulfils the queue item.
    const accept = await initiate(tokens[2]!, { atmId: f.atms[3], queueItemId: itemId, priority: 'P1' });
    expect(accept.status).toBe(200);
    const closed = (await pool.query(`SELECT state, fulfilled_call_id FROM call_queue WHERE id = $1`, [itemId])).rows[0];
    expect(closed.state).toBe('FULFILLED');
    expect(closed.fulfilled_call_id).toBe(accept.body.call.id);
  });

  it('forbids hanging up another operator\'s call without call:hangup:any, but lets a supervisor do it', async () => {
    const r = await initiate(tokens[1]!, { atmId: f.atms[0] });
    expect((await hangup(tokens[2]!, r.body.call.id)).status).toBe(403);
    expect((await hangup(tokens[0]!, r.body.call.id)).status).toBe(200);
    const s = await waitFor(() => status(tokens[0]!, r.body.call.id), (x) => ['CANCELLED', 'COMPLETED'].includes(x.state));
    expect(s.hangupBy).toBe('SUPERVISOR');
  });

  it('writes audit records for call initiation and refusals, and never stores the dial token', async () => {
    await initiate(tokens[1]!, { atmId: f.otherRegionAtm });
    const ok = await initiate(tokens[1]!, { atmId: f.atms[1] });
    const secret: string = ok.body.dial.headers['X-Wintek-Call-Token'];
    expect(secret.length).toBeGreaterThan(20);
    const rows = await pool.query(`SELECT action, outcome, detail::text AS detail FROM audit_logs WHERE organization_id = $1 ORDER BY id DESC LIMIT 100`, [f.orgId]);
    expect(rows.rows.some((r) => r.action === 'call.initiate.rejected' && r.outcome === 'DENIED')).toBe(true);
    expect(rows.rows.some((r) => r.action === 'call.initiated')).toBe(true);
    const events = await pool.query(`SELECT detail::text AS detail FROM call_events WHERE organization_id = $1`, [f.orgId]);
    for (const r of [...rows.rows, ...events.rows]) expect(r.detail ?? '').not.toContain(secret);
    // Only a hash is persisted, and it is cleared once the INVITE has been accepted.
    const s = await waitFor(() => status(tokens[1]!, ok.body.call.id), (x) => x.state === 'CONNECTED');
    const h = await pool.query(`SELECT dial_token_hash FROM call_sessions WHERE id = $1`, [s.id]);
    expect(h.rows[0].dial_token_hash).toBeNull();
  });
});
