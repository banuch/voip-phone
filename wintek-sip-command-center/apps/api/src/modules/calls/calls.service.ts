import { ForbiddenException, HttpStatus, Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Request } from 'express';
import {
  ACTIVE_CALL_STATES,
  Permission,
  TERMINAL_CALL_STATES,
  canTransition,
  eventTypeForCallState,
  terminalStateForSipCode,
  type CallEventData,
  type CallState,
  type Priority,
} from '@wintek/shared';
import { DatabaseService, isUniqueViolation, type Queryable } from '../../common/db/database.service';
import type { AuthUser } from '../../common/auth/auth-user';
import { DomainError, notFound } from '../../common/http/errors';
import { AuditService } from '../audit/audit.service';
import { EventBusService } from '../realtime/event-bus.service';
import { PresenceService } from '../operators/presence.service';
import { QueueService } from '../queue/queue.service';
import { AssignmentsService } from '../assignments/assignments.service';
import { DeviceStatusService } from '../atms/device-status.service';
import { OPERATOR_AUTHORIZED_FOR_ATM_SQL } from '../assignments/authorization.sql';
import { SIP_DRIVER, type CallPlumbing, type SipDriver, type SipSignal } from './sip/sip-driver';
import { config } from '../../config';

const ACTIVE_SQL = `(${[...ACTIVE_CALL_STATES].map((s) => `'${s}'`).join(',')})`;
const sha256 = (s: string) => createHash('sha256').update(s).digest();

export interface InitiateInput {
  atmId: string;
  requestId: string;
  priority?: Priority;
  queueIfBusy?: boolean;
  queueItemId?: string;
  reason?: string;
}

export interface CallRow {
  id: string;
  organization_id: string;
  atm_id: string;
  operator_id: string;
  initiated_by: string;
  request_id: string;
  correlation_id: string;
  state: CallState;
  priority: Priority;
  routing_decision: string;
  dial_token_hash: Buffer | null;
  operator_channel_id: string | null;
  atm_channel_id: string | null;
  bridge_id: string | null;
  media_node: string | null;
  sip_code: number | null;
  failure_reason: string | null;
  hangup_by: string | null;
  requested_at: Date;
  answered_at: Date | null;
  ended_at: Date | null;
  state_changed_at: Date;
  version: number;
}

type Source = 'API' | 'ARI' | 'SWEEPER' | 'QUEUE' | 'SUPERVISOR';

const STATE_TIMESTAMP: Partial<Record<CallState, string>> = {
  RESERVED: 'reserved_at',
  DIALING: 'dialing_at',
  RINGING: 'ringing_at',
  CONNECTED: 'answered_at',
};

/** Outcome of the reservation transaction, handled after commit/rollback. */
type ReserveOutcome =
  | { kind: 'reserved'; call: CallRow; token: string; queueRow: any | null }
  | { kind: 'replay'; call: CallRow; token: string | null }
  | { kind: 'queued'; queueRow: any; orgId: string }
  | { kind: 'rejected'; status: HttpStatus; code: string; message: string; orgId: string | null; details?: Record<string, unknown> };

/**
 * Call control. This service is the single authority over call_sessions.state:
 *  - reservation is one transaction holding row locks on the ATM and operator,
 *    backed by partial unique indexes (one active call per ATM / per operator),
 *  - every later state comes from a SIP signal (ARI event) or a timeout,
 *  - transitions are validated against the shared state machine and logged
 *    to call_events; events are published only after commit.
 */
@Injectable()
export class CallsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(CallsService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly bus: EventBusService,
    private readonly presence: PresenceService,
    private readonly queue: QueueService,
    private readonly assignments: AssignmentsService,
    private readonly devices: DeviceStatusService,
    @Inject(SIP_DRIVER) private readonly driver: SipDriver,
  ) {}

  private leadershipTimer?: NodeJS.Timeout;
  private leadership: { alive: () => Promise<boolean>; release: () => Promise<void> } | null = null;

  async onModuleInit() {
    if (this.driver.name !== 'ari') {
      await this.startDriver(); // simulator: in-process, single node
      return;
    }
    // Exactly one API node per media node consumes ARI events; otherwise two
    // nodes would both act on the same StasisStart. Every node can still send
    // ARI REST commands (hangup etc.). If the leader dies its DB session ends,
    // the lock is released and another node takes over within ~5 s.
    const key = 7300300 + (Array.from(this.driver.node).reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) | 0, 0) & 0xffff);
    const tick = async () => {
      try {
        if (this.leadership) {
          if (!(await this.leadership.alive())) {
            this.log.error(`lost ARI leadership for ${this.driver.node}; stopping event consumer`);
            this.leadership = null;
            await this.driver.stop();
          }
          return;
        }
        const l = await this.db.holdLeadership(key);
        if (l) {
          this.leadership = l;
          this.log.log(`this node consumes ARI events for ${this.driver.node}`);
          await this.startDriver();
        }
      } catch (e: any) {
        this.log.warn(`ARI leadership check failed: ${e.message}`);
      }
    };
    await tick();
    this.leadershipTimer = setInterval(() => void tick(), 5_000);
  }

  private async startDriver() {
    await this.driver.start((s) => {
      void this.onSignal(s).catch((e) => this.log.error(`signal ${s.type} failed: ${e.message}`, e.stack));
    });
  }

  async onModuleDestroy() {
    clearInterval(this.leadershipTimer);
    await this.driver.stop();
    await this.leadership?.release();
  }

  // =============================================================== initiate
  async initiate(user: AuthUser, input: InitiateInput, req?: Request) {
    if (!user.operatorId || !user.organizationId) {
      throw new ForbiddenException({ code: 'NOT_AN_OPERATOR', message: 'Only operators can place calls' });
    }
    const outcome = await this.reserve(user, input);
    switch (outcome.kind) {
      case 'rejected':
        await this.audit.record({
          actor: user, organizationId: outcome.orgId, action: 'call.initiate.rejected', outcome: outcome.code === 'NOT_AUTHORIZED' ? 'DENIED' : 'FAILURE',
          entityType: 'atm', entityId: input.atmId, detail: { code: outcome.code, requestId: input.requestId }, req,
        });
        throw new DomainError(outcome.status, outcome.code, outcome.message, outcome.details);
      case 'queued':
        await this.queue.publish(outcome.queueRow);
        this.queue.dispatchSoon();
        return { queued: true, queueItem: { id: outcome.queueRow.id, priority: outcome.queueRow.priority, state: outcome.queueRow.state } };
      case 'replay':
        // A retry gets a fresh token (the previous one is void), so the simulator dials again with it.
        if (outcome.token) await this.simulateBrowserInvite(outcome.call, outcome.token);
        return { queued: false, call: await this.view(outcome.call.id), dial: outcome.token ? this.dialInfo(outcome.call, outcome.token) : null, replayed: true };
      case 'reserved': {
        await this.publishCall(outcome.call);
        if (outcome.queueRow) await this.queue.publish(outcome.queueRow);
        await this.presence.recompute(outcome.call.operator_id);
        await this.simulateBrowserInvite(outcome.call, outcome.token);
        return { queued: false, call: await this.view(outcome.call.id), dial: this.dialInfo(outcome.call, outcome.token), replayed: false };
      }
    }
  }

  /** SIP_DRIVER=simulated only: stand in for the console's INVITE. */
  private async simulateBrowserInvite(call: CallRow, token: string) {
    if (!this.driver.simulateOperatorLeg) return;
    this.driver.simulateOperatorLeg(call.id, token, (await this.operatorEndpoint(call.operator_id)) ?? '');
  }

  /** What the browser dials: a per-call URI plus a one-time token header checked when the INVITE reaches Stasis. */
  private dialInfo(call: CallRow, token: string) {
    return {
      target: `sip:call-${call.id}@${config().SIP_DOMAIN}`,
      headers: { 'X-Wintek-Call-Token': token },
      expiresInMs: 15_000,
    };
  }

  private async reserve(user: AuthUser, input: InitiateInput): Promise<ReserveOutcome> {
    const operatorId = user.operatorId!;
    const reject = (status: HttpStatus, code: string, message: string, orgId: string | null, details?: Record<string, unknown>): ReserveOutcome => ({
      kind: 'rejected', status, code, message, orgId, details,
    });

    // Idempotency: the same (operator, requestId) always maps to the same call.
    const existing = await this.db.one<CallRow>(`SELECT * FROM call_sessions WHERE operator_id = $1 AND request_id = $2`, [operatorId, input.requestId]);
    if (existing) return this.replay(existing);

    const active = await this.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM call_sessions WHERE state IN ${ACTIVE_SQL}`);
    if ((active?.n ?? 0) >= config().MAX_CONCURRENT_CALLS) {
      throw new ServiceUnavailableException({ code: 'CAPACITY', message: 'Platform call capacity reached; try again shortly' });
    }

    try {
      return await this.db.tx(async (c): Promise<ReserveOutcome> => {
        // Lock order is always ATM then operator, so concurrent reservations can't deadlock.
        const atm = (
          await c.query(
            `SELECT d.id, d.organization_id, d.atm_code, d.name, d.status, d.registration_status, si.sip_username
               FROM atm_devices d LEFT JOIN sip_identities si ON si.atm_id = d.id
              WHERE d.id = $1 AND d.deleted_at IS NULL FOR UPDATE OF d`,
            [input.atmId],
          )
        ).rows[0];
        if (!atm || atm.organization_id !== user.organizationId) return reject(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'ATM not found', user.organizationId);
        const org = atm.organization_id as string;

        const op = (await c.query(`SELECT id, status FROM operators WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [operatorId])).rows[0];
        if (!op || op.status !== 'ACTIVE') return reject(HttpStatus.FORBIDDEN, 'OPERATOR_DISABLED', 'Operator account is disabled', org);

        // Authorization (server-side, always).
        const authz = (
          await c.query(
            `SELECT
               EXISTS (SELECT 1 FROM assignment_overrides o WHERE o.atm_id = $1 AND o.operator_id = $2 AND o.revoked_at IS NULL AND now() >= o.starts_at AND now() < o.ends_at) AS is_override,
               EXISTS (SELECT 1 FROM atm_assignments a WHERE a.atm_id = $1 AND a.primary_operator_id = $2) AS is_primary,
               EXISTS (SELECT 1 FROM atm_assignments a WHERE a.atm_id = $1 AND a.backup_operator_id = $2) AS is_backup,
               ${OPERATOR_AUTHORIZED_FOR_ATM_SQL('$2::uuid', '$1::uuid')} AS authorized`,
            [input.atmId, operatorId],
          )
        ).rows[0];
        const canAny = user.permissions.has(Permission.CALL_INITIATE_ANY);
        if (!authz.authorized && !canAny) {
          return reject(HttpStatus.FORBIDDEN, 'NOT_AUTHORIZED', 'You are not assigned to this ATM', org);
        }
        const routing = authz.is_override ? 'OVERRIDE' : authz.is_primary ? 'PRIMARY' : authz.is_backup ? 'BACKUP' : authz.authorized ? 'DYNAMIC' : 'SUPERVISOR';

        // Device availability.
        if (atm.status !== 'ACTIVE') return reject(HttpStatus.CONFLICT, 'ATM_DISABLED', `ATM is ${atm.status.toLowerCase()}`, org);
        if (atm.registration_status !== 'REGISTERED' || !atm.sip_username) {
          return reject(HttpStatus.CONFLICT, 'ATM_OFFLINE', 'ATM intercom is not registered', org, { registration: atm.registration_status });
        }

        // Operator availability (live, server-computed; includes "already in a call").
        const availability = await this.presence.liveAvailability(operatorId, c);
        if (availability === 'BUSY') return reject(HttpStatus.CONFLICT, 'OPERATOR_BUSY', 'You already have an active call', org);
        if (availability !== 'AVAILABLE') {
          return reject(HttpStatus.CONFLICT, 'OPERATOR_UNAVAILABLE', `Your status is ${availability}; set yourself AVAILABLE with a connected console`, org, { availability });
        }

        // ATM busy?
        const busy = (await c.query(`SELECT id, operator_id FROM call_sessions WHERE atm_id = $1 AND state IN ${ACTIVE_SQL}`, [input.atmId])).rows[0];
        if (busy) {
          const policy = await this.assignments.effectivePolicy(input.atmId, c);
          if (input.queueIfBusy && policy.allowQueueWhenBusy) {
            const { row } = await this.queue.enqueue(c, {
              orgId: org, atmId: input.atmId, priority: input.priority ?? 'P3', source: 'OPERATOR', requestedBy: user.userId,
              preferredOperatorId: operatorId, reason: input.reason ?? 'ATM busy when called', timeoutSeconds: policy.queueTimeoutSeconds,
            });
            return { kind: 'queued', queueRow: row, orgId: org };
          }
          return reject(HttpStatus.CONFLICT, 'ATM_BUSY', 'ATM is already in a call', org, { queueAllowed: policy.allowQueueWhenBusy });
        }

        // Reserve. REQUESTED and VALIDATING are recorded for the timeline; RESERVED is the persisted state.
        const token = randomBytes(24).toString('base64url');
        const call = (
          await c.query<CallRow>(
            `INSERT INTO call_sessions (organization_id, atm_id, operator_id, initiated_by, request_id, state, priority, routing_decision,
                                        routing_trace, queue_item_id, dial_token_hash, reserved_at, api_node)
             VALUES ($1,$2,$3,$4,$5,'RESERVED',$6,$7,$8,$9,$10, now(), $11) RETURNING *`,
            [org, input.atmId, operatorId, user.userId, input.requestId, input.priority ?? 'P3', routing,
             JSON.stringify({ authorizedBy: routing, canInitiateAny: canAny }), input.queueItemId ?? null, sha256(token), config().NODE_ID],
          )
        ).rows[0]!;
        await c.query(
          `INSERT INTO call_events (call_id, organization_id, from_state, to_state, source, detail) VALUES
             ($1,$2,'IDLE','REQUESTED','API',$3), ($1,$2,'REQUESTED','VALIDATING','API',NULL), ($1,$2,'VALIDATING','RESERVED','API',$4)`,
          [call.id, org, JSON.stringify({ requestId: input.requestId, priority: call.priority }), JSON.stringify({ routing })],
        );
        const queueRow = await this.queue.fulfil(c, input.atmId, call.id);
        await this.audit.record(
          {
            actor: user, organizationId: org, action: 'call.initiated', entityType: 'call', entityId: call.id,
            detail: { atmId: input.atmId, atmCode: atm.atm_code, priority: call.priority, routing, queueItemId: queueRow?.id ?? null },
          },
          c,
        );
        return { kind: 'reserved', call, token, queueRow };
      });
    } catch (e: any) {
      // Unique indexes are the backstop if two transactions race past the checks.
      if (isUniqueViolation(e, 'ux_call_active_atm')) return reject(HttpStatus.CONFLICT, 'ATM_BUSY', 'ATM is already in a call', user.organizationId);
      if (isUniqueViolation(e, 'ux_call_active_operator')) return reject(HttpStatus.CONFLICT, 'OPERATOR_BUSY', 'You already have an active call', user.organizationId);
      if (isUniqueViolation(e, 'call_sessions_operator_id_request_id_key')) {
        const again = await this.db.one<CallRow>(`SELECT * FROM call_sessions WHERE operator_id = $1 AND request_id = $2`, [operatorId, input.requestId]);
        if (again) return this.replay(again);
      }
      throw e;
    }
  }

  /** Retried request: same call. While still RESERVED a fresh one-time token is issued (the old one is void). */
  private async replay(call: CallRow): Promise<ReserveOutcome> {
    if (call.state !== 'RESERVED') return { kind: 'replay', call, token: null };
    const token = randomBytes(24).toString('base64url');
    const r = await this.db.one<CallRow>(
      `UPDATE call_sessions SET dial_token_hash = $2 WHERE id = $1 AND state = 'RESERVED' RETURNING *`,
      [call.id, sha256(token)],
    );
    return { kind: 'replay', call: r ?? call, token: r ? token : null };
  }

  // =============================================================== hangup
  async hangup(user: AuthUser, callId: string, req?: Request) {
    const call = await this.db.one<CallRow>(`SELECT * FROM call_sessions WHERE id = $1`, [callId]);
    if (!call || (user.organizationId && call.organization_id !== user.organizationId)) throw notFound('Call');
    const own = call.operator_id === user.operatorId;
    if (!own && !user.permissions.has(Permission.CALL_HANGUP_ANY)) {
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'You can only hang up your own calls' });
    }
    if (TERMINAL_CALL_STATES.has(call.state)) return this.view(callId); // idempotent
    const by = own ? 'OPERATOR' : 'SUPERVISOR';
    await this.audit.record({ actor: user, organizationId: call.organization_id, action: 'call.hangup', entityType: 'call', entityId: callId, detail: { state: call.state, by }, req });

    if (call.state === 'RESERVED') {
      // No media yet (operator INVITE not arrived): cancel outright.
      const done = await this.transition(callId, 'CANCELLED', { source: 'API', patch: { hangup_by: by, failure_reason: 'cancelled before dialing' } });
      if (done) await this.afterEnd(done);
      return this.view(callId);
    }
    const t = await this.transition(callId, 'TERMINATING', { source: by === 'OPERATOR' ? 'API' : 'SUPERVISOR', patch: { hangup_by: by } });
    const target = t ?? call;
    await this.driver.hangup(this.plumbing(target)).catch((e) => this.log.warn(`hangup ${callId}: ${e.message}`));
    // The LEG_ENDED signals move TERMINATING to COMPLETED/CANCELLED; the sweeper is the safety net.
    return this.view(callId);
  }

  // =============================================================== signals
  async onSignal(s: SipSignal) {
    switch (s.type) {
      case 'OPERATOR_LEG':
        return this.onOperatorLeg(s);
      case 'ATM_RINGING':
        await this.transition(s.callId, 'RINGING', { source: 'ARI', from: ['DIALING'] });
        return;
      case 'ATM_ANSWERED':
        return this.onAtmAnswered(s.callId, s.channelId);
      case 'LEG_ENDED':
        return this.onLegEnded(s);
      case 'ENDPOINT_STATE':
        await this.devices.applyRegistration({
          sipUsername: s.endpoint, state: s.state === 'online' ? 'REGISTERED' : 'UNREGISTERED',
          contactIp: s.contactIp, contactPort: s.contactPort, userAgent: s.userAgent, source: 'asterisk',
        });
        return;
      case 'DRIVER_STATE':
        this.log.log(`media driver ${this.driver.name}@${this.driver.node}: ${s.connected ? 'up' : 'down'} (${s.detail})`);
        await this.publishSystemAlert(s.connected ? 'info' : 'critical', 'media', `${this.driver.node}: ${s.detail}`);
        return;
    }
  }

  private async onOperatorLeg(s: Extract<SipSignal, { type: 'OPERATOR_LEG' }>) {
    const call = /^[0-9a-f-]{36}$/.test(s.callId) ? await this.db.one<CallRow>(`SELECT * FROM call_sessions WHERE id = $1`, [s.callId]) : null;
    const reject = async (why: string, reason: 'unauthorized' | 'unknown_call' | 'busy') => {
      await this.driver.rejectOperatorLeg(s.channelId, reason);
      await this.audit.record({
        organizationId: call?.organization_id ?? null, action: 'call.leg.rejected', outcome: 'DENIED', entityType: 'call', entityId: s.callId,
        detail: { why, endpoint: s.endpoint, node: s.node },
      });
    };
    if (!call) return reject('unknown call', 'unknown_call');
    if (call.state !== 'RESERVED') return reject(`call is ${call.state}`, 'busy');
    const expected = call.dial_token_hash;
    const got = sha256(s.token);
    if (!expected || expected.length !== got.length || !timingSafeEqual(expected, got)) return reject('bad dial token', 'unauthorized');
    // The token is bound to the operator: the INVITE must come from that operator's authenticated SIP endpoint.
    const ep = await this.operatorEndpoint(call.operator_id);
    if (!ep || ep !== s.endpoint) return reject(`endpoint ${s.endpoint} is not the reserving operator`, 'unauthorized');

    const atmChannelId = `wk-atm-${call.id}`;
    const bridgeId = `wk-br-${call.id}`;
    const dialing = await this.transition(call.id, 'DIALING', {
      source: 'ARI', from: ['RESERVED'],
      patch: { operator_channel_id: s.channelId, atm_channel_id: atmChannelId, bridge_id: bridgeId, media_node: s.node, dial_token_hash: null },
    });
    if (!dialing) return reject('state changed concurrently', 'busy');
    const meta = await this.db.one(
      `SELECT si.sip_username, u.display_name FROM call_sessions c JOIN sip_identities si ON si.atm_id = c.atm_id
         JOIN operators o ON o.id = c.operator_id JOIN users u ON u.id = o.user_id WHERE c.id = $1`,
      [call.id],
    );
    try {
      await this.driver.dialAtm({
        callId: call.id, operatorChannelId: s.channelId, atmChannelId, bridgeId,
        atmSipUsername: meta.sip_username, callerIdName: `Wintek ${meta.display_name}`, ringTimeoutSec: 30,
      });
    } catch (e: any) {
      this.log.error(`dial ATM for ${call.id} failed: ${e.message}`);
      const failed = await this.transition(call.id, 'FAILED', { source: 'ARI', patch: { failure_reason: `dial failed: ${e.message}`.slice(0, 300) } });
      await this.driver.hangup(this.plumbing(dialing)).catch(() => undefined);
      if (failed) await this.afterEnd(failed);
    }
  }

  private async onAtmAnswered(callId: string, channelId: string) {
    const call = await this.db.one<CallRow>(`SELECT * FROM call_sessions WHERE id = $1`, [callId]);
    if (!call || call.atm_channel_id !== channelId) return;
    if (call.state !== 'DIALING' && call.state !== 'RINGING') {
      // Answered after we gave up (timeout/cancel): make sure the late leg is torn down.
      await this.driver.hangup(this.plumbing(call)).catch(() => undefined);
      return;
    }
    try {
      await this.driver.connect(this.plumbing(call));
    } catch (e: any) {
      const failed = await this.transition(callId, 'FAILED', { source: 'ARI', patch: { failure_reason: `bridge failed: ${e.message}`.slice(0, 300) } });
      await this.driver.hangup(this.plumbing(call)).catch(() => undefined);
      if (failed) await this.afterEnd(failed);
      return;
    }
    // CONNECTED only now: the ATM answered AND both legs are bridged.
    await this.transition(callId, 'CONNECTED', { source: 'ARI', from: ['DIALING', 'RINGING'], patch: { sip_code: 200 } });
  }

  private async onLegEnded(s: Extract<SipSignal, { type: 'LEG_ENDED' }>) {
    const call = s.callId
      ? await this.db.one<CallRow>(`SELECT * FROM call_sessions WHERE id = $1`, [s.callId])
      : await this.db.one<CallRow>(`SELECT * FROM call_sessions WHERE operator_channel_id = $1 OR atm_channel_id = $1`, [s.channelId]);
    if (!call || TERMINAL_CALL_STATES.has(call.state)) return;
    // Only legs this call actually owns count. A rejected INVITE that merely
    // named this call id (bad token, wrong endpoint) must not end the call.
    if (s.channelId !== call.operator_channel_id && s.channelId !== call.atm_channel_id) return;
    const leg = call.atm_channel_id === s.channelId ? 'ATM' : 'OPERATOR';
    const answered = !!call.answered_at || call.state === 'CONNECTED';

    let final: CallState;
    let reason: string | null = null;
    let sipCode = s.sipCode;
    if (answered) {
      final = 'COMPLETED';
    } else if (call.state === 'TERMINATING' || leg === 'OPERATOR') {
      final = 'CANCELLED'; // operator hung up / browser went away before the ATM answered
      reason = leg === 'OPERATOR' && call.state !== 'TERMINATING' ? 'operator leg ended before answer' : 'cancelled';
    } else {
      final = terminalStateForSipCode(sipCode ?? 500);
      reason = `ATM leg ended: ${s.reason}`;
    }
    const hangupBy = call.hangup_by ?? (answered ? leg : null);

    if (call.state !== 'TERMINATING' && canTransition(call.state, 'TERMINATING') && (final === 'COMPLETED' || final === 'CANCELLED')) {
      await this.transition(call.id, 'TERMINATING', { source: 'ARI', patch: { hangup_by: hangupBy } });
    }
    const done = await this.transition(call.id, final, {
      source: 'ARI',
      sipCode,
      patch: { sip_code: answered ? (call.sip_code ?? 200) : sipCode, failure_reason: reason, hangup_by: hangupBy },
    });
    // Tear down whatever is left (other leg, bridge). Idempotent.
    await this.driver.hangup(this.plumbing(call)).catch(() => undefined);
    if (done) await this.afterEnd(done);
  }

  // =============================================================== transitions
  /**
   * Validated, logged state change. Returns the updated row, or null when the
   * change doesn't apply (already there, already terminal, or not from an
   * allowed state) - so duplicate or late ARI events are harmless.
   */
  async transition(
    callId: string,
    to: CallState,
    o: { source: Source; from?: CallState[]; patch?: Record<string, unknown>; sipCode?: number | null; detail?: Record<string, unknown>; tx?: PoolClient },
  ): Promise<CallRow | null> {
    const run = async (c: Queryable) => {
      const cur = (await c.query<CallRow>(`SELECT * FROM call_sessions WHERE id = $1 FOR UPDATE`, [callId])).rows[0];
      if (!cur || cur.state === to || TERMINAL_CALL_STATES.has(cur.state)) return null;
      if (o.from && !o.from.includes(cur.state)) return null;
      if (!canTransition(cur.state, to)) {
        this.log.warn(`ignored invalid transition ${cur.state} -> ${to} for call ${callId} (${o.source})`);
        return null;
      }
      const sets = ['state = $2', 'state_changed_at = now()'];
      const params: unknown[] = [callId, to];
      const ts = STATE_TIMESTAMP[to];
      if (ts) sets.push(`${ts} = coalesce(${ts}, now())`);
      if (TERMINAL_CALL_STATES.has(to)) sets.push('ended_at = now()', 'dial_token_hash = NULL');
      for (const [k, v] of Object.entries(o.patch ?? {})) {
        if (!/^[a-z_]+$/.test(k)) throw new Error(`bad column ${k}`);
        params.push(v);
        sets.push(`${k} = $${params.length}`);
      }
      const row = (await c.query<CallRow>(`UPDATE call_sessions SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params)).rows[0]!;
      await c.query(
        `INSERT INTO call_events (call_id, organization_id, from_state, to_state, source, sip_code, detail) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [callId, row.organization_id, cur.state, to, o.source, o.sipCode ?? null, o.detail ? JSON.stringify(o.detail) : null],
      );
      if (TERMINAL_CALL_STATES.has(to)) {
        await c.query(`UPDATE operators SET last_call_ended_at = now() WHERE id = $1`, [row.operator_id]);
        await this.audit.record(
          {
            organizationId: row.organization_id, action: 'call.ended', entityType: 'call', entityId: callId,
            detail: { state: to, from: cur.state, sipCode: row.sip_code, reason: row.failure_reason, hangupBy: row.hangup_by, source: o.source },
          },
          c,
        );
      }
      return row;
    };
    const row = o.tx ? await run(o.tx) : await this.db.tx(run);
    if (row && !o.tx) await this.publishCall(row);
    return row;
  }

  /** Release side effects once a call is final: operator presence and queued work. */
  async afterEnd(row: CallRow) {
    await this.presence.recompute(row.operator_id);
    this.queue.dispatchSoon();
  }

  // =============================================================== views & helpers
  plumbing(c: CallRow): CallPlumbing {
    return { callId: c.id, operatorChannelId: c.operator_channel_id, atmChannelId: c.atm_channel_id, bridgeId: c.bridge_id };
  }

  private async operatorEndpoint(operatorId: string) {
    return (await this.db.one<{ sip_username: string }>(`SELECT sip_username FROM sip_identities WHERE operator_id = $1 AND enabled`, [operatorId]))?.sip_username ?? null;
  }

  async publishCall(row: CallRow) {
    const v = await this.view(row.id);
    const data: CallEventData = {
      callId: row.id, atmId: row.atm_id, atmCode: v.atmCode, atmName: v.atmName, operatorId: row.operator_id, operatorName: v.operatorName,
      state: row.state, priority: row.priority, requestedAt: new Date(row.requested_at).toISOString(), correlationId: row.correlation_id,
      sipCode: row.sip_code, reason: row.failure_reason,
      answeredAt: row.answered_at ? new Date(row.answered_at).toISOString() : null,
      endedAt: row.ended_at ? new Date(row.ended_at).toISOString() : null,
    };
    await this.bus.publish({
      type: eventTypeForCallState(row.state), orgId: row.organization_id, entityType: 'call', entityId: row.id,
      entityVersion: row.version, correlationId: row.correlation_id, data,
    });
  }

  private async publishSystemAlert(severity: 'info' | 'warning' | 'critical', component: string, message: string) {
    const orgs = await this.db.query<{ id: string }>(`SELECT id FROM organizations WHERE deleted_at IS NULL`);
    for (const o of orgs) {
      await this.bus.publish({ type: 'system.alert', orgId: o.id, entityType: 'system', entityId: component, data: { severity, component, message } });
    }
  }

  async view(callId: string) {
    const v = await this.db.one(
      `SELECT c.id, c.organization_id AS "organizationId", c.atm_id AS "atmId", d.atm_code AS "atmCode", d.name AS "atmName",
              r.name AS "regionName", c.operator_id AS "operatorId", u.display_name AS "operatorName", c.state, c.priority,
              c.routing_decision AS "routingDecision", c.correlation_id AS "correlationId", c.request_id AS "requestId",
              c.sip_code AS "sipCode", c.failure_reason AS "failureReason", c.hangup_by AS "hangupBy",
              c.media_node AS "mediaNode", c.api_node AS "apiNode",
              c.requested_at AS "requestedAt", c.reserved_at AS "reservedAt", c.dialing_at AS "dialingAt", c.ringing_at AS "ringingAt",
              c.answered_at AS "answeredAt", c.ended_at AS "endedAt", c.duration_ms AS "durationMs", c.state_changed_at AS "stateChangedAt",
              c.queue_item_id AS "queueItemId", c.version
         FROM call_sessions c JOIN atm_devices d ON d.id = c.atm_id JOIN regions r ON r.id = d.region_id
         JOIN operators o ON o.id = c.operator_id JOIN users u ON u.id = o.user_id
        WHERE c.id = $1`,
      [callId],
    );
    if (!v) throw notFound('Call');
    return v;
  }

  async get(user: AuthUser, callId: string) {
    const v = await this.view(callId);
    if (user.organizationId && v.organizationId !== user.organizationId) throw notFound('Call');
    const events = await this.db.query(
      `SELECT from_state AS "from", to_state AS "to", source, sip_code AS "sipCode", detail, occurred_at AS "at"
         FROM call_events WHERE call_id = $1 ORDER BY id`,
      [callId],
    );
    return { ...v, events };
  }

  async active(user: AuthUser, orgId: string | null) {
    const p: unknown[] = [];
    const org = user.organizationId ?? orgId;
    return this.db.query(
      `SELECT c.id, c.atm_id AS "atmId", d.atm_code AS "atmCode", d.name AS "atmName", r.name AS "regionName",
              c.operator_id AS "operatorId", u.display_name AS "operatorName", c.state, c.priority, c.requested_at AS "requestedAt",
              c.answered_at AS "answeredAt", c.state_changed_at AS "stateChangedAt", c.media_node AS "mediaNode", c.version
         FROM call_sessions c JOIN atm_devices d ON d.id = c.atm_id JOIN regions r ON r.id = d.region_id
         JOIN operators o ON o.id = c.operator_id JOIN users u ON u.id = o.user_id
        WHERE c.state IN ${ACTIVE_SQL} ${org ? `AND c.organization_id = $${p.push(org)}` : ''}
        ORDER BY c.requested_at`,
      p,
    );
  }

  /** The operator's own active call, for console recovery after a browser refresh. */
  async mine(user: AuthUser) {
    if (!user.operatorId) return null;
    const c = await this.db.one<{ id: string }>(`SELECT id FROM call_sessions WHERE operator_id = $1 AND state IN ${ACTIVE_SQL}`, [user.operatorId]);
    return c ? this.view(c.id) : null;
  }

  get driverInfo() {
    return this.driver;
  }
}

