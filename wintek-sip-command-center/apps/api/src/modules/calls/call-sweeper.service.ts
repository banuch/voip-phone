import { Inject, Injectable, Logger } from '@nestjs/common';
import { CALL_STATE_TIMEOUTS_MS, DEFAULT_MAX_CALL_DURATION_MS, type CallState } from '@wintek/shared';
import { DatabaseService } from '../../common/db/database.service';
import { CallsService, type CallRow } from './calls.service';
import { SIP_DRIVER, type SipDriver } from './sip/sip-driver';

/**
 * Safety nets that make sure no call, and therefore no ATM or operator
 * reservation, outlives its purpose - even if an API process, the browser or
 * a media node dies mid-call:
 *
 *  1. per-state timeouts (RESERVED 15 s, DIALING 10 s, RINGING 30 s, TERMINATING 10 s),
 *  2. maximum connected duration,
 *  3. media reconciliation: calls whose channels no longer exist on their
 *     Asterisk node (node restarted) are closed as FAILED.
 *
 * Runs on one API node at a time (PostgreSQL advisory lock).
 */
@Injectable()
export class CallSweeperService {
  private readonly log = new Logger(CallSweeperService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly calls: CallsService,
    @Inject(SIP_DRIVER) private readonly driver: SipDriver,
  ) {}

  async sweepTimeouts(now = Date.now()): Promise<number> {
    const open = await this.db.query<CallRow>(
      `SELECT * FROM call_sessions WHERE state NOT IN ('COMPLETED','BUSY','FAILED','TIMEOUT','CANCELLED','IDLE')`,
    );
    let n = 0;
    for (const c of open) {
      const age = now - new Date(c.state_changed_at).getTime();
      let to: CallState | null = null;
      let reason = '';
      if (c.state === 'CONNECTED') {
        if (now - new Date(c.answered_at ?? c.state_changed_at).getTime() > DEFAULT_MAX_CALL_DURATION_MS) {
          to = 'TERMINATING';
          reason = 'maximum call duration reached';
        }
      } else {
        const t = CALL_STATE_TIMEOUTS_MS[c.state];
        if (t && age > t.ms) {
          to = t.onExpire;
          // A TERMINATING call that never connected ends as CANCELLED, not COMPLETED.
          if (c.state === 'TERMINATING' && !c.answered_at) to = 'CANCELLED';
          reason = `${c.state} timeout after ${Math.round(age / 1000)} s`;
        }
      }
      if (!to) continue;
      const row = await this.calls.transition(c.id, to, {
        source: 'SWEEPER',
        from: [c.state],
        patch: to === 'TERMINATING' ? { hangup_by: 'SYSTEM' } : { failure_reason: c.failure_reason ?? reason, hangup_by: c.hangup_by ?? 'SYSTEM' },
        detail: { reason },
      });
      if (!row) continue;
      n++;
      this.log.warn(`call ${c.id}: ${c.state} -> ${to} (${reason})`);
      await this.driver.hangup(this.calls.plumbing(row)).catch(() => undefined);
      if (to !== 'TERMINATING') await this.calls.afterEnd(row);
    }
    return n;
  }

  /** Close calls whose media legs vanished from this driver's node. */
  async reconcileMedia(): Promise<number> {
    const live = await this.driver.liveChannelIds();
    if (!live) return 0; // node unreachable: don't guess; timeouts and the reconnect pass handle it
    const rows = await this.db.query<CallRow>(
      `SELECT * FROM call_sessions
        WHERE state IN ('DIALING','RINGING','CONNECTED','TERMINATING') AND media_node = $1
          AND state_changed_at < now() - interval '5 seconds'`,
      [this.driver.node],
    );
    let n = 0;
    for (const c of rows) {
      const opLive = c.operator_channel_id ? live.has(c.operator_channel_id) : false;
      const atmLive = c.atm_channel_id ? live.has(c.atm_channel_id) : false;
      if (opLive || atmLive) continue;
      const to: CallState = c.answered_at ? 'COMPLETED' : 'FAILED';
      const row = await this.calls.transition(c.id, c.state === 'CONNECTED' ? 'FAILED' : to, {
        source: 'SWEEPER',
        patch: { failure_reason: c.failure_reason ?? 'media channels lost (media node restart or network loss)', hangup_by: c.hangup_by ?? 'SYSTEM' },
      });
      if (row) {
        n++;
        await this.calls.afterEnd(row);
      }
    }
    if (n) this.log.error(`closed ${n} call(s) whose media legs no longer exist on ${this.driver.node}`);
    return n;
  }
}
