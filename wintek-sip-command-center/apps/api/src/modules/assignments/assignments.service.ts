import { BadRequestException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import {
  DEFAULT_ROUTING_POLICY,
  resolveAssignment,
  type AssignmentDecision,
  type AssignmentInputs,
  type RoutingPolicy,
} from '@wintek/shared';
import { DatabaseService, type Queryable } from '../../common/db/database.service';
import type { AuthUser } from '../../common/auth/auth-user';
import { scopeOrg, scopeOrgOrAll } from '../../common/auth/tenant';
import { conflict, notFound } from '../../common/http/errors';
import { AuditService } from '../audit/audit.service';
import { EventBusService } from '../realtime/event-bus.service';
import { ON_SHIFT_SQL } from '../operators/operators.service';

export interface EffectivePolicy extends RoutingPolicy {
  allowQueueWhenBusy: boolean;
  queueTimeoutSeconds: number;
  source: string;
}

@Injectable()
export class AssignmentsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly bus: EventBusService,
  ) {}

  /** Organization of an ATM the user may act on (404 for other tenants, so existence isn't leaked). */
  private async atmOrg(user: AuthUser, atmId: string): Promise<string> {
    const r = await this.db.one<{ organization_id: string }>(`SELECT organization_id FROM atm_devices WHERE id = $1 AND deleted_at IS NULL`, [atmId]);
    if (!r || (user.organizationId && r.organization_id !== user.organizationId)) throw notFound('ATM');
    return scopeOrg(user, r.organization_id);
  }

  // ------------------------------------------------------------ static assignments
  async list(user: AuthUser, f: { atmId?: string; operatorId?: string; orgId?: string }) {
    const org = scopeOrgOrAll(user, f.orgId);
    const p: unknown[] = [];
    const where = ['d.deleted_at IS NULL'];
    if (org) where.push(`a.organization_id = $${p.push(org)}`);
    if (f.atmId) where.push(`a.atm_id = $${p.push(f.atmId)}`);
    if (f.operatorId) where.push(`(a.primary_operator_id = $${p.push(f.operatorId)} OR a.backup_operator_id = $${p.length})`);
    return this.db.query(
      `SELECT a.atm_id AS "atmId", d.atm_code AS "atmCode", d.name AS "atmName", r.name AS "regionName",
              a.primary_operator_id AS "primaryOperatorId", pu.display_name AS "primaryOperatorName",
              a.backup_operator_id AS "backupOperatorId", bu.display_name AS "backupOperatorName",
              a.shift_id AS "shiftId", a.updated_at AS "updatedAt", a.version
         FROM atm_assignments a
         JOIN atm_devices d ON d.id = a.atm_id JOIN regions r ON r.id = d.region_id
         LEFT JOIN operators po ON po.id = a.primary_operator_id LEFT JOIN users pu ON pu.id = po.user_id
         LEFT JOIN operators bo ON bo.id = a.backup_operator_id LEFT JOIN users bu ON bu.id = bo.user_id
        WHERE ${where.join(' AND ')} ORDER BY d.atm_code LIMIT 1000`,
      p,
    );
  }

  /**
   * Update an ATM's static assignment with optimistic concurrency: the caller
   * sends the version it edited, so two administrators editing the same ATM
   * can't silently overwrite each other.
   */
  async setStatic(
    user: AuthUser,
    atmId: string,
    dto: { primaryOperatorId?: string | null; backupOperatorId?: string | null; shiftId?: string | null; expectedVersion?: number },
    req: Request,
  ) {
    const org = await this.atmOrg(user, atmId);
    if (dto.primaryOperatorId && dto.primaryOperatorId === dto.backupOperatorId) {
      throw new BadRequestException({ code: 'SAME_OPERATOR', message: 'Primary and backup operator must differ' });
    }
    const row = await this.db.tx(async (c) => {
      const cur = (await c.query(`SELECT * FROM atm_assignments WHERE atm_id = $1 AND organization_id = $2 FOR UPDATE`, [atmId, org])).rows[0];
      if (!cur) throw notFound('ATM assignment');
      if (dto.expectedVersion !== undefined && dto.expectedVersion !== cur.version) {
        throw conflict('STALE_VERSION', 'Assignment was changed by someone else; reload and retry', { currentVersion: cur.version });
      }
      const next = {
        primary: dto.primaryOperatorId !== undefined ? dto.primaryOperatorId : cur.primary_operator_id,
        backup: dto.backupOperatorId !== undefined ? dto.backupOperatorId : cur.backup_operator_id,
        shift: dto.shiftId !== undefined ? dto.shiftId : cur.shift_id,
      };
      if (next.primary && next.primary === next.backup) throw new BadRequestException({ code: 'SAME_OPERATOR', message: 'Primary and backup operator must differ' });
      // Composite FKs reject operators/shifts from another organization.
      const u = await c.query(
        `UPDATE atm_assignments SET primary_operator_id = $2, backup_operator_id = $3, shift_id = $4, updated_by = $5, updated_at = now()
          WHERE atm_id = $1 RETURNING version`,
        [atmId, next.primary, next.backup, next.shift, user.userId],
      );
      await this.audit.record(
        {
          actor: user, organizationId: org, action: 'assignment.updated', entityType: 'atm', entityId: atmId, req,
          detail: {
            from: { primary: cur.primary_operator_id, backup: cur.backup_operator_id, shift: cur.shift_id },
            to: next,
          },
        },
        c,
      );
      return { version: u.rows[0].version as number, ...next };
    });
    await this.bus.publish({
      type: 'assignment.updated', orgId: org, entityType: 'assignment', entityId: atmId, entityVersion: row.version,
      data: { atmId, kind: 'STATIC', primaryOperatorId: row.primary, backupOperatorId: row.backup },
    });
    return row;
  }

  // ------------------------------------------------------------ overrides
  async listOverrides(user: AuthUser, f: { atmId?: string; activeOnly?: boolean; orgId?: string }) {
    const org = scopeOrgOrAll(user, f.orgId);
    const p: unknown[] = [];
    const where: string[] = [];
    if (org) where.push(`o.organization_id = $${p.push(org)}`);
    if (f.atmId) where.push(`o.atm_id = $${p.push(f.atmId)}`);
    if (f.activeOnly !== false) where.push(`o.revoked_at IS NULL AND o.ends_at > now()`);
    return this.db.query(
      `SELECT o.id, o.atm_id AS "atmId", d.atm_code AS "atmCode", d.name AS "atmName", o.operator_id AS "operatorId",
              ou.display_name AS "operatorName", o.reason, cu.display_name AS "createdByName", o.created_by AS "createdBy",
              o.starts_at AS "startsAt", o.ends_at AS "endsAt", o.revoked_at AS "revokedAt",
              (o.revoked_at IS NULL AND now() >= o.starts_at AND now() < o.ends_at) AS active
         FROM assignment_overrides o
         JOIN atm_devices d ON d.id = o.atm_id
         JOIN operators op ON op.id = o.operator_id JOIN users ou ON ou.id = op.user_id
         JOIN users cu ON cu.id = o.created_by
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY o.starts_at DESC LIMIT 500`,
      p,
    );
  }

  async createOverride(user: AuthUser, dto: { atmId: string; operatorId: string; reason: string; startsAt?: string; endsAt: string }, req: Request) {
    const org = await this.atmOrg(user, dto.atmId);
    const startsAt = dto.startsAt ? new Date(dto.startsAt) : new Date();
    const endsAt = new Date(dto.endsAt);
    if (endsAt <= startsAt) throw new BadRequestException({ code: 'BAD_WINDOW', message: 'endsAt must be after startsAt' });
    if (endsAt.getTime() < Date.now()) throw new BadRequestException({ code: 'BAD_WINDOW', message: 'endsAt is in the past' });
    if (endsAt.getTime() - startsAt.getTime() > 7 * 86_400_000) throw new BadRequestException({ code: 'BAD_WINDOW', message: 'Overrides may last at most 7 days' });
    try {
      const id = await this.db.tx(async (c) => {
        const r = await c.query(
          `INSERT INTO assignment_overrides (organization_id, atm_id, operator_id, reason, created_by, starts_at, ends_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [org, dto.atmId, dto.operatorId, dto.reason.trim(), user.userId, startsAt, endsAt],
        );
        await this.audit.record(
          {
            actor: user, organizationId: org, action: 'assignment.override.created', entityType: 'atm', entityId: dto.atmId, req,
            detail: { overrideId: r.rows[0].id, operatorId: dto.operatorId, reason: dto.reason, startsAt, endsAt },
          },
          c,
        );
        return r.rows[0].id as string;
      });
      await this.bus.publish({
        type: 'assignment.updated', orgId: org, entityType: 'assignment', entityId: dto.atmId,
        data: { atmId: dto.atmId, kind: 'OVERRIDE', overrideId: id, operatorId: dto.operatorId, endsAt },
      });
      return { id, atmId: dto.atmId, operatorId: dto.operatorId, startsAt, endsAt };
    } catch (e: any) {
      if (e?.code === '23P01') throw conflict('OVERRIDE_CONFLICT', 'Another override for this ATM overlaps that time window; revoke it first');
      if (e?.code === '23503') throw new BadRequestException({ code: 'BAD_REFERENCE', message: 'ATM or operator not found in this organization' });
      throw e;
    }
  }

  async revokeOverride(user: AuthUser, id: string, req: Request) {
    const ov = await this.db.one<{ atm_id: string }>(`SELECT atm_id FROM assignment_overrides WHERE id = $1`, [id]);
    if (!ov) throw notFound('Active override');
    const org = await this.atmOrg(user, ov.atm_id);
    const r = await this.db.tx(async (c) => {
      const row = (
        await c.query(
          `UPDATE assignment_overrides SET revoked_at = now(), revoked_by = $3
            WHERE id = $1 AND organization_id = $2 AND revoked_at IS NULL RETURNING atm_id`,
          [id, org, user.userId],
        )
      ).rows[0];
      if (!row) throw notFound('Active override');
      await this.audit.record({ actor: user, organizationId: org, action: 'assignment.override.revoked', entityType: 'atm', entityId: row.atm_id, detail: { overrideId: id }, req }, c);
      return row;
    });
    await this.bus.publish({
      type: 'assignment.updated', orgId: org, entityType: 'assignment', entityId: r.atm_id,
      data: { atmId: r.atm_id, kind: 'OVERRIDE_REVOKED', overrideId: id },
    });
  }

  // ------------------------------------------------------------ routing
  async effectivePolicy(atmId: string, q: Queryable = this.db.pool): Promise<EffectivePolicy> {
    const r = await q.query(
      `SELECT p.*, CASE p.scope WHEN 'GROUP' THEN 1 WHEN 'REGION' THEN 2 ELSE 3 END AS rank, g.code AS group_code
         FROM atm_devices d
         JOIN routing_policies p ON p.organization_id = d.organization_id
         LEFT JOIN atm_groups g ON p.scope = 'GROUP' AND g.id = p.scope_id
        WHERE d.id = $1
          AND (p.scope = 'ORGANIZATION'
               OR (p.scope = 'REGION' AND p.scope_id = d.region_id)
               OR (p.scope = 'GROUP' AND EXISTS (SELECT 1 FROM atm_group_members m WHERE m.atm_id = d.id AND m.group_id = p.scope_id)))
        ORDER BY rank, g.code NULLS LAST
        LIMIT 1`,
      [atmId],
    );
    const p = r.rows[0];
    if (!p) return { ...DEFAULT_ROUTING_POLICY, allowQueueWhenBusy: true, queueTimeoutSeconds: 300, source: 'default' };
    return {
      allowDynamic: p.allow_dynamic,
      requireActiveShift: p.require_active_shift,
      sameRegionOnly: p.same_region_only,
      preferGroupMatch: p.prefer_group_match,
      maxWorkload: 1,
      allowQueueWhenBusy: p.allow_queue_when_busy,
      queueTimeoutSeconds: p.queue_timeout_seconds,
      source: `${p.scope}${p.scope_id ? `:${p.scope_id}` : ''}`,
    };
  }

  /** Load every input the pure resolver needs, using `q` (pass the transaction client). */
  async routingInputs(atmId: string, q: Queryable, exclude: string[] = []): Promise<AssignmentInputs & { policy: EffectivePolicy }> {
    const atm = (
      await q.query(
        `SELECT d.id, d.organization_id, d.region_id, a.primary_operator_id, a.backup_operator_id,
                coalesce((SELECT array_agg(group_id) FROM atm_group_members WHERE atm_id = d.id), '{}') AS group_ids
           FROM atm_devices d LEFT JOIN atm_assignments a ON a.atm_id = d.id WHERE d.id = $1`,
        [atmId],
      )
    ).rows[0];
    if (!atm) throw notFound('ATM');
    const [overrides, candidates, policy] = await Promise.all([
      q.query(
        `SELECT operator_id, starts_at, ends_at FROM assignment_overrides
          WHERE atm_id = $1 AND revoked_at IS NULL AND ends_at > now()`,
        [atmId],
      ),
      q.query(
        `SELECT o.id, o.organization_id, o.status, o.routing_priority, o.last_call_ended_at,
                coalesce(p.effective, 'OFFLINE') AS availability,
                coalesce((SELECT array_agg(region_id) FROM operator_regions WHERE operator_id = o.id), '{}') AS region_ids,
                coalesce((SELECT array_agg(group_id) FROM operator_groups WHERE operator_id = o.id), '{}') AS group_ids,
                ${ON_SHIFT_SQL('o.id')} AS on_shift,
                ((SELECT count(*) FROM call_sessions c WHERE c.operator_id = o.id
                    AND c.state IN ('RESERVED','DIALING','RINGING','CONNECTED','TERMINATING'))
                 + (SELECT count(*) FROM call_queue cq WHERE cq.offered_operator_id = o.id AND cq.state = 'OFFERED'))::int AS workload
           FROM operators o LEFT JOIN operator_presence p ON p.operator_id = o.id
          WHERE o.organization_id = $1 AND o.deleted_at IS NULL`,
        [atm.organization_id],
      ),
      this.effectivePolicy(atmId, q),
    ]);
    return {
      atm: { atmId, organizationId: atm.organization_id, regionId: atm.region_id, groupIds: atm.group_ids },
      primaryOperatorId: atm.primary_operator_id,
      backupOperatorId: atm.backup_operator_id,
      overrides: overrides.rows.map((o) => ({ operatorId: o.operator_id, startsAt: new Date(o.starts_at).getTime(), endsAt: new Date(o.ends_at).getTime() })),
      candidates: candidates.rows.map((c) => ({
        operatorId: c.id,
        organizationId: c.organization_id,
        active: c.status === 'ACTIVE',
        availability: c.availability,
        regionIds: c.region_ids,
        groupIds: c.group_ids,
        onShift: c.on_shift,
        workload: c.workload,
        routingPriority: c.routing_priority,
        lastCallEndedAt: c.last_call_ended_at ? new Date(c.last_call_ended_at).getTime() : null,
      })),
      policy,
      exclude,
      now: Date.now(),
    };
  }

  async resolve(atmId: string, q: Queryable = this.db.pool, exclude: string[] = []): Promise<AssignmentDecision & { policySource: string }> {
    const inputs = await this.routingInputs(atmId, q, exclude);
    return { ...resolveAssignment(inputs), policySource: inputs.policy.source };
  }

  async resolveForUser(user: AuthUser, atmId: string) {
    await this.atmOrg(user, atmId);
    return this.resolve(atmId);
  }

  // ------------------------------------------------------------ routing policies
  async listPolicies(user: AuthUser, orgId?: string) {
    const org = scopeOrg(user, orgId);
    return this.db.query(
      `SELECT id, scope, scope_id AS "scopeId", allow_dynamic AS "allowDynamic", require_active_shift AS "requireActiveShift",
              same_region_only AS "sameRegionOnly", prefer_group_match AS "preferGroupMatch", allow_queue_when_busy AS "allowQueueWhenBusy",
              queue_timeout_seconds AS "queueTimeoutSeconds", allow_preemption AS "allowPreemption", updated_at AS "updatedAt", version
         FROM routing_policies WHERE organization_id = $1 ORDER BY scope, scope_id`,
      [org],
    );
  }

  async upsertPolicy(user: AuthUser, dto: any, req: Request) {
    const org = scopeOrg(user, dto.orgId);
    if ((dto.scope === 'ORGANIZATION') !== !dto.scopeId) throw new BadRequestException({ code: 'BAD_SCOPE', message: 'scopeId is required for REGION/GROUP and forbidden for ORGANIZATION' });
    const row = await this.db.tx(async (c) => {
      const r = await c.query(
        `INSERT INTO routing_policies (organization_id, scope, scope_id, allow_dynamic, require_active_shift, same_region_only,
                                       prefer_group_match, allow_queue_when_busy, queue_timeout_seconds, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (organization_id, scope, coalesce(scope_id, '00000000-0000-0000-0000-000000000000'::uuid)) DO UPDATE
           SET allow_dynamic = EXCLUDED.allow_dynamic, require_active_shift = EXCLUDED.require_active_shift,
               same_region_only = EXCLUDED.same_region_only, prefer_group_match = EXCLUDED.prefer_group_match,
               allow_queue_when_busy = EXCLUDED.allow_queue_when_busy, queue_timeout_seconds = EXCLUDED.queue_timeout_seconds,
               updated_by = EXCLUDED.updated_by
         RETURNING id, version`,
        [org, dto.scope, dto.scopeId ?? null, dto.allowDynamic ?? true, dto.requireActiveShift ?? true, dto.sameRegionOnly ?? true,
         dto.preferGroupMatch ?? true, dto.allowQueueWhenBusy ?? true, dto.queueTimeoutSeconds ?? 300, user.userId],
      );
      await this.audit.record({ actor: user, organizationId: org, action: 'routing.policy.updated', entityType: 'routing_policy', entityId: r.rows[0].id, detail: dto, req }, c);
      return r.rows[0];
    });
    return row;
  }
}
