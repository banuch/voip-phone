import { BadRequestException, Injectable } from '@nestjs/common';
import { ACTIVE_CALL_STATES, Role } from '@wintek/shared';
import type { Request } from 'express';
import { DatabaseService } from '../../common/db/database.service';
import { SqlWhere } from '../../common/db/sql-where';
import type { AuthUser } from '../../common/auth/auth-user';
import { scopeOrg, scopeOrgOrAll } from '../../common/auth/tenant';
import { notFound } from '../../common/http/errors';
import { offset, orderBy, type Page } from '../../common/http/pagination';
import { AuditService } from '../audit/audit.service';
import { hashPassword, passwordPolicyError } from '../auth/password';
import { SipIdentityService, operatorSipUsername, turnCredentials } from '../atms/sip-identity.service';
import { config } from '../../config';
import type { CreateOperatorDto, OperatorListQuery, UpdateOperatorDto } from './operators.dto';

const ACTIVE_SQL = `(${[...ACTIVE_CALL_STATES].map((s) => `'${s}'`).join(',')})`;

/** On-shift test shared with routing: shift template active "now" in its own time zone. */
export const ON_SHIFT_SQL = (opRef: string) => `EXISTS (
  SELECT 1 FROM shift_members sm JOIN shifts s ON s.id = sm.shift_id AND s.deleted_at IS NULL
   WHERE sm.operator_id = ${opRef}
     AND sm.valid_from <= (now() AT TIME ZONE s.timezone)::date
     AND (sm.valid_to IS NULL OR sm.valid_to >= (now() AT TIME ZONE s.timezone)::date)
     AND (
       (s.start_time <= s.end_time
          AND extract(isodow FROM now() AT TIME ZONE s.timezone)::smallint = ANY (s.days_of_week)
          AND (now() AT TIME ZONE s.timezone)::time >= s.start_time AND (now() AT TIME ZONE s.timezone)::time < s.end_time)
       OR (s.start_time > s.end_time AND (
          (extract(isodow FROM now() AT TIME ZONE s.timezone)::smallint = ANY (s.days_of_week)
             AND (now() AT TIME ZONE s.timezone)::time >= s.start_time)
          OR ((extract(isodow FROM (now() AT TIME ZONE s.timezone) - interval '1 day'))::smallint = ANY (s.days_of_week)
             AND (now() AT TIME ZONE s.timezone)::time < s.end_time)))
     ))`;

export const OPERATOR_SELECT = `
  SELECT o.id, o.organization_id AS "organizationId", org.name AS "organizationName", o.user_id AS "userId",
         u.username, u.display_name AS "name", u.email, u.status AS "accountStatus", u.last_login_at AS "lastLoginAt",
         o.employee_code AS "employeeCode", o.routing_priority AS "routingPriority", o.status,
         coalesce(p.selected, 'OFFLINE') AS "selectedAvailability", coalesce(p.effective, 'OFFLINE') AS "availability",
         p.sip_registered AS "sipRegistered", p.last_heartbeat_at AS "lastHeartbeatAt",
         si.sip_username AS "sipUsername",
         (SELECT array_agg(ur.role_code) FROM user_roles ur WHERE ur.user_id = u.id) AS roles,
         (SELECT coalesce(json_agg(json_build_object('id', r.id, 'name', r.name)), '[]') FROM operator_regions orr JOIN regions r ON r.id = orr.region_id WHERE orr.operator_id = o.id) AS regions,
         (SELECT coalesce(json_agg(json_build_object('id', g.id, 'name', g.name)), '[]') FROM operator_groups og JOIN atm_groups g ON g.id = og.group_id WHERE og.operator_id = o.id) AS groups,
         (SELECT count(*)::int FROM atm_assignments a WHERE a.primary_operator_id = o.id) AS "primaryAssignments",
         (SELECT count(*)::int FROM atm_assignments a WHERE a.backup_operator_id = o.id) AS "backupAssignments",
         (SELECT json_build_object('id', c.id, 'atmId', c.atm_id, 'state', c.state, 'answeredAt', c.answered_at)
            FROM call_sessions c WHERE c.operator_id = o.id AND c.state IN ${ACTIVE_SQL} LIMIT 1) AS "currentCall",
         ${ON_SHIFT_SQL('o.id')} AS "onShift",
         o.version
    FROM operators o
    JOIN users u ON u.id = o.user_id
    JOIN organizations org ON org.id = o.organization_id
    LEFT JOIN operator_presence p ON p.operator_id = o.id
    LEFT JOIN sip_identities si ON si.operator_id = o.id`;

@Injectable()
export class OperatorsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly sip: SipIdentityService,
  ) {}

  async list(user: AuthUser, q: OperatorListQuery): Promise<Page<any>> {
    const org = scopeOrgOrAll(user, q.orgId);
    const w = new SqlWhere().add('o.deleted_at IS NULL');
    if (org) w.add('o.organization_id = ?', org);
    if (q.regionId) w.add('EXISTS (SELECT 1 FROM operator_regions x WHERE x.operator_id = o.id AND x.region_id = ?)', q.regionId);
    if (q.availability) w.add(`coalesce(p.effective, 'OFFLINE') = ?`, q.availability);
    if (q.q) w.add('(u.username ILIKE ? OR u.display_name ILIKE ?)', `%${q.q}%`, `%${q.q}%`);
    const order = orderBy(q.sort, { name: 'u.display_name', availability: 'p.effective', lastLogin: 'u.last_login_at' }, 'u.display_name ASC');
    const [items, total] = await Promise.all([
      this.db.query(`${OPERATOR_SELECT} ${w.sql} ORDER BY ${order} LIMIT ${q.pageSize} OFFSET ${offset(q)}`, w.params),
      this.db.one<{ n: number }>(
        `SELECT count(*)::int AS n FROM operators o JOIN users u ON u.id = o.user_id LEFT JOIN operator_presence p ON p.operator_id = o.id ${w.sql}`,
        w.params,
      ),
    ]);
    return { items, total: total?.n ?? 0, page: q.page, pageSize: q.pageSize };
  }

  async get(user: AuthUser, id: string) {
    const org = scopeOrgOrAll(user);
    const w = new SqlWhere().add('o.id = ?', id).add('o.deleted_at IS NULL');
    if (org) w.add('o.organization_id = ?', org);
    const op = await this.db.one(`${OPERATOR_SELECT} ${w.sql}`, w.params);
    if (!op) throw notFound('Operator');
    return op;
  }

  async create(user: AuthUser, dto: CreateOperatorDto, req: Request) {
    const org = scopeOrg(user, dto.orgId);
    const pwErr = passwordPolicyError(dto.password);
    if (pwErr) throw new BadRequestException({ code: 'WEAK_PASSWORD', message: pwErr });
    const role = dto.role ?? Role.OPERATOR;
    if (role !== Role.OPERATOR && role !== Role.SUPERVISOR) {
      throw new BadRequestException({ code: 'BAD_ROLE', message: 'Operators are created with role OPERATOR or SUPERVISOR' });
    }
    const hash = await hashPassword(dto.password);
    const id = await this.db.tx(async (c) => {
      const u = await c.query(
        `INSERT INTO users (organization_id, username, display_name, email, password_hash) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [org, dto.username, dto.name, dto.email ?? null, hash],
      );
      const userId = u.rows[0].id;
      await c.query(`INSERT INTO user_roles (user_id, role_code, granted_by) VALUES ($1,$2,$3)`, [userId, role, user.userId]);
      const o = await c.query(
        `INSERT INTO operators (organization_id, user_id, employee_code, routing_priority) VALUES ($1,$2,$3,$4) RETURNING id`,
        [org, userId, dto.employeeCode ?? null, dto.routingPriority ?? 100],
      );
      const opId = o.rows[0].id;
      await this.replaceLinks(c, org, opId, dto.regionIds ?? [], dto.groupIds ?? []);
      await c.query(`INSERT INTO operator_presence (operator_id, organization_id) VALUES ($1,$2)`, [opId, org]);
      // WebRTC identity; its password is issued per browser session, see webrtcCredentials().
      await this.sip.issue(c, { kind: 'OPERATOR', operatorId: opId }, org, operatorSipUsername(dto.username));
      await this.audit.record(
        { actor: user, organizationId: org, action: 'operator.created', entityType: 'operator', entityId: opId, detail: { username: dto.username, role }, req },
        c,
      );
      return opId as string;
    });
    return this.get(user, id);
  }

  async update(user: AuthUser, id: string, dto: UpdateOperatorDto, req: Request) {
    const current = await this.get(user, id);
    const org = current.organizationId as string;
    await this.db.tx(async (c) => {
      const sets: string[] = [];
      const p: unknown[] = [id];
      const set = (col: string, v: unknown) => {
        p.push(v);
        sets.push(`${col} = $${p.length}`);
      };
      if (dto.routingPriority !== undefined) set('routing_priority', dto.routingPriority);
      if (dto.employeeCode !== undefined) set('employee_code', dto.employeeCode);
      if (dto.status !== undefined) set('status', dto.status);
      if (sets.length) await c.query(`UPDATE operators SET ${sets.join(', ')} WHERE id = $1`, p);
      if (dto.name !== undefined) await c.query(`UPDATE users SET display_name = $2 WHERE id = $1`, [current.userId, dto.name]);
      if (dto.regionIds || dto.groupIds) {
        await this.replaceLinks(
          c,
          org,
          id,
          dto.regionIds ?? current.regions.map((r: any) => r.id),
          dto.groupIds ?? current.groups.map((g: any) => g.id),
        );
      }
      if (dto.status === 'DISABLED') await c.query(`UPDATE sip_identities SET enabled = false WHERE operator_id = $1`, [id]);
      if (dto.status === 'ACTIVE') await c.query(`UPDATE sip_identities SET enabled = true WHERE operator_id = $1`, [id]);
      await this.audit.record({ actor: user, organizationId: org, action: 'operator.updated', entityType: 'operator', entityId: id, detail: { ...dto }, req }, c);
    });
    return this.get(user, id);
  }

  private async replaceLinks(c: any, org: string, opId: string, regionIds: string[], groupIds: string[]) {
    await c.query(`DELETE FROM operator_regions WHERE operator_id = $1`, [opId]);
    await c.query(`DELETE FROM operator_groups WHERE operator_id = $1`, [opId]);
    if (regionIds.length) {
      await c.query(
        `INSERT INTO operator_regions (organization_id, operator_id, region_id) SELECT $1, $2, unnest($3::uuid[])`,
        [org, opId, regionIds],
      );
    }
    if (groupIds.length) {
      await c.query(`INSERT INTO operator_groups (organization_id, operator_id, group_id) SELECT $1, $2, unnest($3::uuid[])`, [org, opId, groupIds]);
    }
  }

  async assignments(user: AuthUser, id: string) {
    const op = await this.get(user, id);
    return this.db.query(
      `SELECT a.atm_id AS "atmId", d.atm_code AS "atmCode", d.name AS "atmName",
              CASE WHEN a.primary_operator_id = $1 THEN 'PRIMARY' ELSE 'BACKUP' END AS kind
         FROM atm_assignments a JOIN atm_devices d ON d.id = a.atm_id AND d.deleted_at IS NULL
        WHERE (a.primary_operator_id = $1 OR a.backup_operator_id = $1) AND a.organization_id = $2
       UNION ALL
       SELECT o.atm_id, d.atm_code, d.name, 'OVERRIDE'
         FROM assignment_overrides o JOIN atm_devices d ON d.id = o.atm_id
        WHERE o.operator_id = $1 AND o.organization_id = $2 AND o.revoked_at IS NULL AND now() >= o.starts_at AND now() < o.ends_at
        ORDER BY 2`,
      [id, op.organizationId],
    );
  }

  /**
   * Session-bound WebRTC credentials: every call rotates the operator's SIP
   * password, so the browser's credential is only valid until the next sign-in
   * and nothing long-lived sits in browser storage.
   */
  async webrtcCredentials(user: AuthUser, req: Request) {
    if (!user.operatorId || !user.organizationId) throw new BadRequestException({ code: 'NOT_AN_OPERATOR', message: 'User is not an operator' });
    const cred = await this.db.tx(async (c) => {
      const issued = await this.sip.issue(c, { kind: 'OPERATOR', operatorId: user.operatorId! }, user.organizationId!, operatorSipUsername(user.username));
      await this.audit.record(
        { actor: user, action: 'operator.webrtc_credentials.issued', entityType: 'operator', entityId: user.operatorId!, detail: { credentialVersion: issued.credentialVersion }, req },
        c,
      );
      return issued;
    });
    const turn = turnCredentials(user.operatorId);
    return {
      wssUrl: config().WEBRTC_WSS_URL,
      sipUri: `sip:${cred.sipUsername}@${cred.domain}`,
      authorizationUsername: cred.sipUsername,
      password: cred.sipPassword,
      realm: cred.realm,
      iceServers: [{ urls: config().STUN_URLS.split(',') }, ...(turn ? [turn] : [])],
      driver: config().SIP_DRIVER,
    };
  }
}
