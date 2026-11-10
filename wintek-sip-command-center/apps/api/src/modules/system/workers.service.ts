import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Counter, Gauge, Histogram } from 'prom-client';
import { DatabaseService } from '../../common/db/database.service';
import { config } from '../../config';
import { CallSweeperService } from '../calls/call-sweeper.service';
import { DeviceStatusService } from '../atms/device-status.service';
import { PresenceService } from '../operators/presence.service';
import { QueueService } from '../queue/queue.service';

interface Job {
  name: string;
  everyMs: number;
  lockKey: number;
  run: () => Promise<unknown>;
}

export interface JobStatus {
  name: string;
  lastRunAt: string | null;
  lastDurationMs: number | null;
  lastError: string | null;
  ranHere: number;
  skippedNotLeader: number;
}

const jobRuns = new Counter({ name: 'wintek_worker_runs_total', help: 'Background job runs', labelNames: ['task', 'outcome'] });
const jobDuration = new Histogram({ name: 'wintek_worker_duration_seconds', help: 'Background job duration', labelNames: ['task'], buckets: [0.01, 0.05, 0.1, 0.5, 1, 5] });
export const activeCallsGauge = new Gauge({ name: 'wintek_active_calls', help: 'Calls in an active state' });
export const onlineAtmsGauge = new Gauge({ name: 'wintek_online_atms', help: 'ATMs with a live SIP registration' });
export const availableOperatorsGauge = new Gauge({ name: 'wintek_available_operators', help: 'Operators effectively AVAILABLE' });
export const queueDepthGauge = new Gauge({ name: 'wintek_queue_depth', help: 'Open call requests' });

/**
 * Periodic jobs. Every node schedules every job, but each run first takes a
 * PostgreSQL advisory lock, so exactly one node does the work per tick and a
 * dead node's lock is released with its connection - no leader to fail over.
 */
@Injectable()
export class WorkersService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(WorkersService.name);
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly running = new Set<string>();
  readonly status = new Map<string, JobStatus>();

  constructor(
    private readonly db: DatabaseService,
    private readonly sweeper: CallSweeperService,
    private readonly presence: PresenceService,
    private readonly devices: DeviceStatusService,
    private readonly queue: QueueService,
  ) {}

  private jobs(): Job[] {
    return [
      { name: 'call-timeouts', everyMs: 2_000, lockKey: 7300101, run: () => this.sweeper.sweepTimeouts() },
      // Per media node: only the node consuming that node's ARI events can see its channels (others no-op).
      { name: 'media-reconcile', everyMs: 30_000, lockKey: 0, run: () => this.sweeper.reconcileMedia() },
      { name: 'presence-stale', everyMs: 5_000, lockKey: 7300103, run: () => this.presence.sweepStale() },
      { name: 'registration-stale', everyMs: 60_000, lockKey: 7300104, run: () => this.devices.sweepStaleRegistrations() },
      { name: 'queue-dispatch', everyMs: 2_000, lockKey: 7300201, run: () => this.queue.dispatch() },
      { name: 'metrics', everyMs: 15_000, lockKey: 0, run: () => this.refreshGauges() },
      { name: 'retention', everyMs: 3_600_000, lockKey: 7300105, run: () => this.retention() },
    ];
  }

  onApplicationBootstrap() {
    if (!config().WORKERS_ENABLED) {
      this.log.warn('background workers disabled on this node');
      return;
    }
    for (const j of this.jobs()) {
      this.status.set(j.name, { name: j.name, lastRunAt: null, lastDurationMs: null, lastError: null, ranHere: 0, skippedNotLeader: 0 });
      this.timers.push(setInterval(() => void this.tick(j), j.everyMs));
    }
  }

  onModuleDestroy() {
    this.timers.forEach(clearInterval);
  }

  private async tick(j: Job) {
    if (this.running.has(j.name)) return; // never overlap with ourselves
    this.running.add(j.name);
    const st = this.status.get(j.name)!;
    try {
      const release = j.lockKey ? await this.db.tryLeader(j.lockKey) : async () => undefined;
      if (!release) {
        st.skippedNotLeader++;
        return;
      }
      const t = Date.now();
      const end = jobDuration.startTimer({ task: j.name });
      try {
        await j.run();
        st.lastError = null;
        jobRuns.inc({ task: j.name, outcome: 'ok' });
      } catch (e: any) {
        st.lastError = e.message;
        jobRuns.inc({ task: j.name, outcome: 'error' });
        this.log.error(`job ${j.name} failed: ${e.message}`);
      } finally {
        end();
        st.lastRunAt = new Date().toISOString();
        st.lastDurationMs = Date.now() - t;
        st.ranHere++;
        await release();
      }
    } catch (e: any) {
      st.lastError = `lock: ${e.message}`; // database unreachable
    } finally {
      this.running.delete(j.name);
    }
  }

  private async refreshGauges() {
    const r = await this.db.one(
      `SELECT (SELECT count(*) FROM call_sessions WHERE state IN ('RESERVED','DIALING','RINGING','CONNECTED','TERMINATING'))::int AS calls,
              (SELECT count(*) FROM atm_devices WHERE deleted_at IS NULL AND registration_status = 'REGISTERED')::int AS atms,
              (SELECT count(*) FROM operator_presence WHERE effective = 'AVAILABLE')::int AS ops,
              (SELECT count(*) FROM call_queue WHERE state IN ('WAITING','OFFERED'))::int AS queue`,
    );
    activeCallsGauge.set(r.calls);
    onlineAtmsGauge.set(r.atms);
    availableOperatorsGauge.set(r.ops);
    queueDepthGauge.set(r.queue);
  }

  /** Metadata retention. Audit rows can only be deleted with the retention flag set (see trigger). */
  private async retention() {
    const { AUDIT_RETENTION_DAYS: audit, CALL_HISTORY_RETENTION_DAYS: calls } = config();
    await this.db.tx(async (c) => {
      await c.query(`SET LOCAL wintek.retention_job = 'on'`);
      await c.query(`DELETE FROM audit_logs WHERE occurred_at < now() - make_interval(days => $1)`, [audit]);
    });
    await this.db.query(`DELETE FROM device_events WHERE occurred_at < now() - make_interval(days => $1)`, [calls]);
    await this.db.query(
      `DELETE FROM call_events WHERE call_id IN (SELECT id FROM call_sessions WHERE ended_at < now() - make_interval(days => $1))`,
      [calls],
    );
    await this.db.query(
      `UPDATE call_queue SET fulfilled_call_id = NULL WHERE fulfilled_call_id IN (SELECT id FROM call_sessions WHERE ended_at < now() - make_interval(days => $1))`,
      [calls],
    );
    await this.db.query(`DELETE FROM call_sessions WHERE ended_at < now() - make_interval(days => $1)`, [calls]);
    await this.db.query(`DELETE FROM call_queue WHERE closed_at < now() - make_interval(days => $1)`, [calls]);
    await this.db.query(`DELETE FROM refresh_tokens WHERE expires_at < now() - interval '1 day'`);
  }
}
