import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import {
  ACTIVE_CALL_STATES,
  SELECTABLE_AVAILABILITY,
  effectiveAvailability,
  type Availability,
  type OperatorPresenceData,
} from '@wintek/shared';
import { DatabaseService, type Queryable } from '../../common/db/database.service';
import type { AuthUser } from '../../common/auth/auth-user';
import { AuditService } from '../audit/audit.service';
import { EventBusService } from '../realtime/event-bus.service';
import { config } from '../../config';

const ACTIVE_SQL = `(${[...ACTIVE_CALL_STATES].map((s) => `'${s}'`).join(',')})`;

interface PresenceRow {
  operator_id: string;
  organization_id: string;
  selected: Availability;
  effective: Availability;
  sip_registered: boolean;
  media_fault: boolean;
  last_heartbeat_at: Date | null;
  version: number;
  current_call_id: string | null;
}

/**
 * Operator presence. PostgreSQL is the record (one small UPDATE per 10 s
 * heartbeat per operator - ~20 writes/s for 200 operators, which is noise);
 * the effective availability is recomputed server-side from the operator's
 * selection, heartbeat age, browser SIP registration and the operator's real
 * call state in call_sessions. The browser never decides it is "available".
 */
@Injectable()
export class PresenceService {
  private readonly log = new Logger(PresenceService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly bus: EventBusService,
    private readonly audit: AuditService,
  ) {}

  private async load(operatorId: string, q: Queryable = this.db.pool, lock = false): Promise<PresenceRow | null> {
    const r = await q.query(
      `SELECT p.*, (SELECT id FROM call_sessions c WHERE c.operator_id = p.operator_id AND c.state IN ${ACTIVE_SQL} LIMIT 1) AS current_call_id
         FROM operator_presence p WHERE p.operator_id = $1 ${lock ? 'FOR UPDATE OF p' : ''}`,
      [operatorId],
    );
    return r.rows[0] ?? null;
  }

  effectiveOf(row: PresenceRow, now = Date.now()): Availability {
    return effectiveAvailability({
      selected: row.selected,
      lastHeartbeatAt: row.last_heartbeat_at ? new Date(row.last_heartbeat_at).getTime() : null,
      sipRegistered: row.sip_registered,
      mediaFault: row.media_fault,
      inActiveCall: row.current_call_id !== null,
      now,
    });
  }

  /** Live effective availability, for use inside a call-reservation transaction. */
  async liveAvailability(operatorId: string, q: Queryable): Promise<Availability> {
    const row = await this.load(operatorId, q);
    return row ? this.effectiveOf(row) : 'OFFLINE';
  }

  async heartbeat(user: AuthUser, hb: { sipRegistered: boolean; mediaFault: boolean }) {
    if (!user.operatorId || !user.organizationId) return;
    await this.db.query(
      `INSERT INTO operator_presence (operator_id, organization_id, selected, sip_registered, media_fault, last_heartbeat_at, session_node)
       VALUES ($1, $2, 'UNAVAILABLE', $3, $4, now(), $5)
       ON CONFLICT (operator_id) DO UPDATE
         SET sip_registered = EXCLUDED.sip_registered, media_fault = EXCLUDED.media_fault,
             last_heartbeat_at = now(), session_node = EXCLUDED.session_node`,
      [user.operatorId, user.organizationId, hb.sipRegistered, hb.mediaFault, config().NODE_ID],
    );
    await this.recompute(user.operatorId);
  }

  async setSelected(user: AuthUser, selected: Availability, req?: any) {
    if (!user.operatorId || !user.organizationId) throw new BadRequestException({ code: 'NOT_AN_OPERATOR', message: 'User is not an operator' });
    if (!SELECTABLE_AVAILABILITY.includes(selected)) {
      throw new BadRequestException({ code: 'NOT_SELECTABLE', message: `${selected} is set by the system, not selectable` });
    }
    const prev = await this.db.one<{ selected: string }>(`SELECT selected FROM operator_presence WHERE operator_id = $1`, [user.operatorId]);
    await this.db.query(
      `INSERT INTO operator_presence (operator_id, organization_id, selected) VALUES ($1, $2, $3)
       ON CONFLICT (operator_id) DO UPDATE SET selected = EXCLUDED.selected`,
      [user.operatorId, user.organizationId, selected],
    );
    await this.audit.record({
      actor: user,
      action: 'presence.selected',
      entityType: 'operator',
      entityId: user.operatorId,
      detail: { from: prev?.selected ?? null, to: selected },
      req,
    });
    return this.recompute(user.operatorId, true);
  }

  /** Recompute, persist if changed, and publish. Returns the current presence. */
  async recompute(operatorId: string, forceEmit = false): Promise<OperatorPresenceData | null> {
    const res = await this.db.tx(async (c) => {
      const row = await this.load(operatorId, c, true);
      if (!row) return null;
      const effective = this.effectiveOf(row);
      let version = row.version;
      const changed = effective !== row.effective;
      if (changed) {
        const u = await c.query(`UPDATE operator_presence SET effective = $2 WHERE operator_id = $1 RETURNING version`, [operatorId, effective]);
        version = u.rows[0].version;
      }
      return { row, effective, changed, version };
    });
    if (!res) return null;
    const data: OperatorPresenceData = {
      operatorId,
      selected: res.row.selected,
      effective: res.effective,
      currentCallId: res.row.current_call_id,
    };
    if (res.changed || forceEmit) {
      await this.bus.publish({
        type: 'operator.presence.changed',
        orgId: res.row.organization_id,
        entityType: 'operator',
        entityId: operatorId,
        entityVersion: res.version,
        data,
      });
    }
    return data;
  }

  /** Leader job: operators whose heartbeats stopped become OFFLINE. */
  async sweepStale(): Promise<number> {
    const rows = await this.db.query<{ operator_id: string; organization_id: string }>(
      `SELECT operator_id, organization_id FROM operator_presence
        WHERE effective <> 'OFFLINE' AND (last_heartbeat_at IS NULL OR last_heartbeat_at < now() - interval '30 seconds')`,
    );
    for (const r of rows) {
      const p = await this.recompute(r.operator_id);
      if (p?.effective === 'OFFLINE') {
        await this.audit.record({
          organizationId: r.organization_id,
          actor: null,
          action: 'presence.heartbeat_lost',
          entityType: 'operator',
          entityId: r.operator_id,
        });
      }
    }
    if (rows.length) this.log.log(`marked ${rows.length} operator(s) offline after missed heartbeats`);
    return rows.length;
  }
}
