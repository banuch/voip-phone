import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import type { Request } from 'express';
import {
  Permission,
  QUEUE_TIMEOUT_MS,
  resolveAssignment,
  sortQueue,
  type Priority,
  type QueueEventData,
} from '@wintek/shared';
import { DatabaseService, type Queryable } from '../../common/db/database.service';
import type { AuthUser } from '../../common/auth/auth-user';
import { scopeOrg, scopeOrgOrAll } from '../../common/auth/tenant';
import { conflict, notFound } from '../../common/http/errors';
import { AuditService } from '../audit/audit.service';
import { EventBusService } from '../realtime/event-bus.service';
import { AssignmentsService } from '../assignments/assignments.service';

const OFFER_TTL_SECONDS = 30;

export interface EnqueueInput {
  orgId: string;
  atmId: string;
  priority: Priority;
  source: 'OPERATOR' | 'SUPERVISOR' | 'INTEGRATION';
  requestedBy: string | null;
  preferredOperatorId?: string | null;
  reason?: string | null;
  externalRef?: string | null;
  timeoutSeconds?: number;
}

interface QueueRow {
  id: string;
  organization_id: string;
  atm_id: string;
  priority: Priority;
  state: QueueEventData['state'];
  preferred_operator_id: string | null;
  offered_operator_id: string | null;
  declined_by: string[];
  escalated_at: Date | null;
  reason: string | null;
  enqueued_at: Date;
  version: number;
}

/**
 * Priority queue of PENDING CALL REQUESTS. Calls are still always placed by
 * an operator: the queue decides who is offered the request, and the offered
 * operator places the call (which fulfils the request). Nothing here dials an
 * ATM, and nothing preempts an active call (V1.1 policy).
 *
 * Ordering: effective priority (with aging for starvation prevention), then
 * FIFO, then id - see sortQueue() in @wintek/shared.
 */
@Injectable()
export class QueueService {
  private readonly log = new Logger(QueueService.name);
  private dispatchScheduled = false;

  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly bus: EventBusService,
    private readonly assignments: AssignmentsService,
  ) {}

  private toEvent(r: QueueRow): QueueEventData {
    return {
      queueItemId: r.id,
      atmId: r.atm_id,
      state: r.state,
      priority: r.priority,
      offeredOperatorId: r.offered_operator_id,
      escalated: !!r.escalated_at,
      reason: r.reason,
    };
  }

  async publish(r: QueueRow) {
    await this.bus.publish({ type: 'queue.updated', orgId: r.organization_id, entityType: 'queue', entityId: r.id, entityVersion: r.version, data: this.toEvent(r) });
  }

  /**
   * Insert, or merge into the ATM's open request: the more urgent priority
   * wins and the later deadline is kept. Returns the row; caller publishes.
   */
  async enqueue(q: Queryable, i: EnqueueInput): Promise<{ row: QueueRow; merged: boolean }> {
    const timeoutMs = (i.timeoutSeconds ?? QUEUE_TIMEOUT_MS[i.priority] / 1000) * 1000;
    const r = await q.query(
      `INSERT INTO call_queue (organization_id, atm_id, priority, source, requested_by, preferred_operator_id, reason, external_ref, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now() + make_interval(secs => $9))
       ON CONFLICT (atm_id) WHERE state IN ('WAITING','OFFERED') DO UPDATE
         SET priority = LEAST(call_queue.priority, EXCLUDED.priority),
             expires_at = GREATEST(call_queue.expires_at, EXCLUDED.expires_at),
             reason = coalesce(EXCLUDED.reason, call_queue.reason),
             external_ref = coalesce(EXCLUDED.external_ref, call_queue.external_ref)
       RETURNING *, (xmax <> 0) AS merged`,
      [i.orgId, i.atmId, i.priority, i.source, i.requestedBy, i.preferredOperatorId ?? null, i.reason ?? null, i.externalRef ?? null, timeoutMs / 1000],
    );
    const row = r.rows[0];
    await this.audit.record(
      {
        organizationId: i.orgId,
        actor: i.requestedBy ? { userId: i.requestedBy, username: '', organizationId: i.orgId } : null,
        action: row.merged ? 'queue.request.merged' : 'queue.request.created',
        entityType: 'queue',
        entityId: row.id,
        detail: { atmId: i.atmId, priority: row.priority, source: i.source, externalRef: i.externalRef ?? null },
      },
      q,
    );
    return { row, merged: row.merged };
  }

  /** Mark the ATM's open request fulfilled by a call (called inside the reservation transaction). */
  async fulfil(q: Queryable, atmId: string, callId: string): Promise<QueueRow | null> {
    const r = await q.query(
      `UPDATE call_queue SET state = 'FULFILLED', closed_at = now(), close_reason = 'call placed', fulfilled_call_id = $2
        WHERE atm_id = $1 AND state IN ('WAITING','OFFERED') RETURNING *`,
      [atmId, callId],
    );
    return r.rows[0] ?? null;
  }

  async list(user: AuthUser, f: { orgId?: string; includeClosed?: boolean }) {
    const org = scopeOrgOrAll(user, f.orgId);
    const rows = await this.db.query(
      `SELECT q.id, q.organization_id AS "organizationId", q.atm_id AS "atmId", d.atm_code AS "atmCode", d.name AS "atmName",
              r.name AS "regionName", q.priority, q.state, q.source, q.reason, q.external_ref AS "externalRef",
              q.preferred_operator_id AS "preferredOperatorId",
              q.offered_operator_id AS "offeredOperatorId", ou.display_name AS "offeredOperatorName", q.offer_expires_at AS "offerExpiresAt",
              ru.display_name AS "requestedByName", q.escalated_at AS "escalatedAt",
              q.enqueued_at AS "enqueuedAt", q.expires_at AS "expiresAt", q.closed_at AS "closedAt", q.close_reason AS "closeReason",
              EXISTS (SELECT 1 FROM call_sessions c WHERE c.atm_id = q.atm_id AND c.state IN ('RESERVED','DIALING','RINGING','CONNECTED','TERMINATING')) AS "atmBusy",
              q.version
         FROM call_queue q JOIN atm_devices d ON d.id = q.atm_id JOIN regions r ON r.id = d.region_id
         LEFT JOIN operators oo ON oo.id = q.offered_operator_id LEFT JOIN users ou ON ou.id = oo.user_id
         LEFT JOIN users ru ON ru.id = q.requested_by
        WHERE ${f.includeClosed ? `q.enqueued_at > now() - interval '24 hours'` : `q.state IN ('WAITING','OFFERED')`}
              ${org ? 'AND q.organization_id = $1' : ''}
        ORDER BY q.enqueued_at LIMIT 1000`,
      org ? [org] : [],
    );
    const now = Date.now();
    const open = rows.filter((r) => r.state === 'WAITING' || r.state === 'OFFERED');
    const ordered = sortQueue(open.map((r) => ({ ...r, enqueuedAt: new Date(r.enqueuedAt).getTime() })), now);
    const position = new Map(ordered.map((r, i) => [r.id, i + 1]));
    return rows
      .map((r) => ({ ...r, position: position.get(r.id) ?? null }))
      .sort((a, b) => (a.position ?? 1e9) - (b.position ?? 1e9) || +new Date(b.enqueuedAt) - +new Date(a.enqueuedAt));
  }

  async create(user: AuthUser, dto: { atmId: string; priority: Priority; reason?: string; externalRef?: string; preferredOperatorId?: string }, req: Request) {
    const atm = await this.db.one<{ organization_id: string }>(`SELECT organization_id FROM atm_devices WHERE id = $1 AND deleted_at IS NULL`, [dto.atmId]);
    if (!atm || (user.organizationId && atm.organization_id !== user.organizationId)) throw notFound('ATM');
    const org = scopeOrg(user, atm.organization_id);
    const { row } = await this.db.tx((c) =>
      this.enqueue(c, {
        orgId: org, atmId: dto.atmId, priority: dto.priority, source: 'SUPERVISOR', requestedBy: user.userId,
        preferredOperatorId: dto.preferredOperatorId, reason: dto.reason, externalRef: dto.externalRef,
      }),
    );
    await this.publish(row);
    this.dispatchSoon();
    return this.toEvent(row);
  }

  async cancel(user: AuthUser, id: string, req: Request) {
    const item = await this.db.one<QueueRow & { requested_by: string | null }>(`SELECT * FROM call_queue WHERE id = $1`, [id]);
    if (!item || (user.organizationId && item.organization_id !== user.organizationId)) throw notFound('Queue item');
    const own = item.requested_by === user.userId;
    if (!own && !user.permissions.has(Permission.QUEUE_MANAGE)) throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Only the requester or a supervisor can cancel' });
    const row = await this.db.tx(async (c) => {
      const r = await c.query(
        `UPDATE call_queue SET state = 'CANCELLED', closed_at = now(), close_reason = $2 WHERE id = $1 AND state IN ('WAITING','OFFERED') RETURNING *`,
        [id, `cancelled by ${user.username}`],
      );
      if (!r.rows[0]) throw conflict('QUEUE_CLOSED', 'Request is no longer open');
      await this.audit.record({ actor: user, organizationId: item.organization_id, action: 'queue.request.cancelled', entityType: 'queue', entityId: id, req }, c);
      return r.rows[0];
    });
    await this.publish(row);
  }

  /** Offered operator passes; the request goes back to WAITING and won't be offered to them again. */
  async decline(user: AuthUser, id: string, req: Request) {
    if (!user.operatorId) throw new BadRequestException({ code: 'NOT_AN_OPERATOR', message: 'User is not an operator' });
    const row = await this.db.tx(async (c) => {
      const r = await c.query(
        `UPDATE call_queue SET state = 'WAITING', offered_operator_id = NULL, offered_at = NULL, offer_expires_at = NULL,
                declined_by = array_append(declined_by, $2)
          WHERE id = $1 AND state = 'OFFERED' AND offered_operator_id = $2 RETURNING *`,
        [id, user.operatorId],
      );
      if (!r.rows[0]) throw conflict('NOT_OFFERED', 'This request is not offered to you');
      await this.audit.record({ actor: user, action: 'queue.offer.declined', entityType: 'queue', entityId: id, req }, c);
      return r.rows[0];
    });
    await this.publish(row);
    this.dispatchSoon();
  }

  /** Coalesces bursts of "something freed up" into one dispatch pass. */
  dispatchSoon() {
    if (this.dispatchScheduled) return;
    this.dispatchScheduled = true;
    setTimeout(() => {
      this.dispatchScheduled = false;
      void this.dispatchWithLeader().catch((e) => this.log.error(`dispatch failed: ${e.message}`));
    }, 200);
  }

  async dispatchWithLeader() {
    const release = await this.db.tryLeader(7300201);
    if (!release) return;
    try {
      await this.dispatch();
    } finally {
      await release();
    }
  }

  /** One dispatch pass (caller holds the queue leader lock). */
  async dispatch(): Promise<{ expired: number; offered: number; escalated: number }> {
    let expired = 0;
    let offered = 0;
    let escalated = 0;

    for (const r of await this.db.query<QueueRow>(
      `UPDATE call_queue SET state = 'EXPIRED', closed_at = now(), close_reason = 'queue timeout'
        WHERE state IN ('WAITING','OFFERED') AND expires_at < now() RETURNING *`,
    )) {
      expired++;
      await this.audit.record({ organizationId: r.organization_id, action: 'queue.request.expired', entityType: 'queue', entityId: r.id, detail: { atmId: r.atm_id, priority: r.priority } });
      await this.publish(r);
    }

    // Unanswered offers count as a decline for that operator.
    for (const r of await this.db.query<QueueRow>(
      `UPDATE call_queue SET state = 'WAITING', declined_by = array_append(declined_by, offered_operator_id),
              offered_operator_id = NULL, offered_at = NULL, offer_expires_at = NULL
        WHERE state = 'OFFERED' AND offer_expires_at < now() RETURNING *`,
    )) {
      await this.audit.record({ organizationId: r.organization_id, action: 'queue.offer.timed_out', entityType: 'queue', entityId: r.id });
      await this.publish(r);
    }

    const waiting = await this.db.query<QueueRow>(
      `SELECT q.* FROM call_queue q JOIN atm_devices d ON d.id = q.atm_id
        WHERE q.state = 'WAITING' AND d.status = 'ACTIVE' AND d.registration_status = 'REGISTERED'
          AND NOT EXISTS (SELECT 1 FROM call_sessions c WHERE c.atm_id = q.atm_id AND c.state IN ('RESERVED','DIALING','RINGING','CONNECTED','TERMINATING'))
        LIMIT 500`,
    );
    const ordered = sortQueue(waiting.map((w) => ({ ...w, enqueuedAt: new Date(w.enqueued_at).getTime() })), Date.now());

    for (const item of ordered) {
      const inputs = await this.assignments.routingInputs(item.atm_id, this.db.pool, item.declined_by ?? []);
      let operatorId: string | null = null;
      let kind = 'PREFERRED';
      const pref = item.preferred_operator_id ? inputs.candidates.find((c) => c.operatorId === item.preferred_operator_id) : undefined;
      if (pref && pref.availability === 'AVAILABLE' && pref.workload === 0 && pref.active && !(item.declined_by ?? []).includes(pref.operatorId)) {
        operatorId = pref.operatorId;
      } else {
        const d = resolveAssignment(inputs);
        operatorId = d.operatorId;
        kind = d.kind;
      }
      if (operatorId) {
        const r = await this.db.one<QueueRow>(
          `UPDATE call_queue SET state = 'OFFERED', offered_operator_id = $2, offered_at = now(),
                  offer_expires_at = now() + make_interval(secs => $3)
            WHERE id = $1 AND state = 'WAITING' RETURNING *`,
          [item.id, operatorId, OFFER_TTL_SECONDS],
        );
        if (r) {
          offered++;
          await this.audit.record({ organizationId: r.organization_id, action: 'queue.offered', entityType: 'queue', entityId: r.id, detail: { operatorId, routing: kind } });
          await this.publish(r);
        }
      } else if (!item.escalated_at) {
        const r = await this.db.one<QueueRow>(`UPDATE call_queue SET escalated_at = now() WHERE id = $1 AND escalated_at IS NULL RETURNING *`, [item.id]);
        if (r) {
          escalated++;
          await this.audit.record({ organizationId: r.organization_id, action: 'queue.escalated', entityType: 'queue', entityId: r.id, detail: { atmId: r.atm_id, priority: r.priority } });
          await this.publish(r);
          await this.bus.publish({
            type: 'system.alert', orgId: r.organization_id, entityType: 'queue', entityId: r.id,
            data: { severity: r.priority === 'P1' ? 'critical' : 'warning', component: 'queue', message: `No eligible operator for queued ${r.priority} request; supervisor action needed`, atmId: r.atm_id },
          });
        }
      }
    }
    return { expired, offered, escalated };
  }
}
