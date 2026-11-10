import { BadRequestException, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { Request } from 'express';
import { ACTIVE_CALL_STATES, Permission } from '@wintek/shared';
import { DatabaseService, isUniqueViolation } from '../../common/db/database.service';
import { SqlWhere } from '../../common/db/sql-where';
import type { AuthUser } from '../../common/auth/auth-user';
import { scopeOrg, scopeOrgOrAll } from '../../common/auth/tenant';
import { conflict, notFound } from '../../common/http/errors';
import { offset, orderBy, type Page } from '../../common/http/pagination';
import { AuditService } from '../audit/audit.service';
import { EventBusService } from '../realtime/event-bus.service';
import { ATMS_AUTHORIZED_FOR_OPERATOR_SQL } from '../assignments/authorization.sql';
import { SipIdentityService, atmSipUsername, type IssuedSipCredential } from './sip-identity.service';
import { parseCsvObjects } from './csv';
import type { AtmListQuery, BulkAtmDto, CreateAtmDto, UpdateAtmDto } from './atms.dto';
import { config } from '../../config';

const ACTIVE_SQL = `(${[...ACTIVE_CALL_STATES].map((s) => `'${s}'`).join(',')})`;

/** List/detail projection. Never includes any SIP secret. */
const ATM_SELECT = `
  SELECT d.id, d.atm_code AS "atmCode", d.name, d.organization_id AS "organizationId", org.name AS "organizationName",
         d.region_id AS "regionId", r.name AS "regionName", d.state, d.city, d.site, d.address,
         d.latitude::float AS latitude, d.longitude::float AS longitude,
         si.sip_username AS "sipUsername", si.credential_version AS "credentialVersion", si.rotated_at AS "credentialsRotatedAt",
         d.device_model AS "deviceModel", d.firmware_version AS "firmwareVersion", d.serial_number AS "serialNumber",
         d.status, d.registration_status AS "registrationStatus", d.health,
         d.last_registered_at AS "lastRegisteredAt", d.last_seen_at AS "lastSeenAt",
         host(d.contact_ip) AS "contactIp", d.contact_port AS "contactPort", d.user_agent AS "userAgent",
         d.vms_camera_ref AS "vmsCameraRef", d.vms_deep_link AS "vmsDeepLink",
         a.primary_operator_id AS "primaryOperatorId", pu.display_name AS "primaryOperatorName",
         a.backup_operator_id AS "backupOperatorId", bu.display_name AS "backupOperatorName",
         ov.operator_id AS "overrideOperatorId", ovu.display_name AS "overrideOperatorName", ov.ends_at AS "overrideEndsAt",
         coalesce(ov.operator_id, a.primary_operator_id) AS "assignedOperatorId",
         coalesce(ovu.display_name, pu.display_name) AS "assignedOperatorName",
         ac.id AS "activeCallId", ac.state AS "activeCallState", acu.display_name AS "activeCallOperatorName",
         q.id AS "queueItemId", q.priority AS "queuePriority",
         (SELECT coalesce(json_agg(json_build_object('id', g.id, 'name', g.name) ORDER BY g.name), '[]')
            FROM atm_group_members gm JOIN atm_groups g ON g.id = gm.group_id WHERE gm.atm_id = d.id) AS groups,
         d.created_at AS "createdAt", d.updated_at AS "updatedAt", d.version
    FROM atm_devices d
    JOIN organizations org ON org.id = d.organization_id
    JOIN regions r ON r.id = d.region_id
    LEFT JOIN sip_identities si ON si.atm_id = d.id
    LEFT JOIN atm_assignments a ON a.atm_id = d.id
    LEFT JOIN operators po ON po.id = a.primary_operator_id LEFT JOIN users pu ON pu.id = po.user_id
    LEFT JOIN operators bo ON bo.id = a.backup_operator_id LEFT JOIN users bu ON bu.id = bo.user_id
    LEFT JOIN LATERAL (SELECT o.operator_id, o.ends_at FROM assignment_overrides o
                        WHERE o.atm_id = d.id AND o.revoked_at IS NULL AND now() >= o.starts_at AND now() < o.ends_at
                        ORDER BY o.starts_at DESC LIMIT 1) ov ON true
    LEFT JOIN operators ovo ON ovo.id = ov.operator_id LEFT JOIN users ovu ON ovu.id = ovo.user_id
    LEFT JOIN call_sessions ac ON ac.atm_id = d.id AND ac.state IN ${ACTIVE_SQL}
    LEFT JOIN operators aco ON aco.id = ac.operator_id LEFT JOIN users acu ON acu.id = aco.user_id
    LEFT JOIN call_queue q ON q.atm_id = d.id AND q.state IN ('WAITING','OFFERED')`;

const SORTS: Record<string, string> = {
  atmCode: 'd.atm_code',
  name: 'd.name',
  region: 'r.name',
  city: 'd.city',
  lastSeen: 'd.last_seen_at',
  registration: 'd.registration_status',
  health: 'd.health',
  firmware: 'd.firmware_version',
};

export interface ImportRowResult {
  line: number;
  atmCode: string;
  status: 'CREATED' | 'UPDATED' | 'ERROR';
  error?: string;
  credentials?: IssuedSipCredential;
}

@Injectable()
export class AtmsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly sip: SipIdentityService,
    private readonly bus: EventBusService,
  ) {}

  private scopedWhere(user: AuthUser, orgId?: string) {
    const org = scopeOrgOrAll(user, orgId);
    const w = new SqlWhere().add('d.deleted_at IS NULL');
    if (org) w.add('d.organization_id = ?', org);
    return w;
  }

  async list(user: AuthUser, q: AtmListQuery): Promise<Page<any>> {
    const w = this.scopedWhere(user, q.orgId);
    if (q.regionId) w.add('d.region_id = ?', q.regionId);
    if (q.groupId) w.add('EXISTS (SELECT 1 FROM atm_group_members x WHERE x.atm_id = d.id AND x.group_id = ?)', q.groupId);
    if (q.operatorId) w.add('(a.primary_operator_id = ? OR a.backup_operator_id = ? OR ov.operator_id = ?)', q.operatorId, q.operatorId, q.operatorId);
    if (q.registration) w.add('d.registration_status = ?', q.registration);
    if (q.health) w.add('d.health = ?', q.health);
    if (q.status) w.add('d.status = ?', q.status);
    if (q.inCall === true) w.add('ac.id IS NOT NULL');
    if (q.inCall === false) w.add('ac.id IS NULL');
    if (q.mine) {
      if (!user.operatorId) w.add('false');
      else {
        const frag = ATMS_AUTHORIZED_FOR_OPERATOR_SQL('?::uuid', 'd.id', 'd.region_id');
        w.add(frag, ...Array<string>(frag.split('?').length - 1).fill(user.operatorId));
      }
    }
    if (q.q) {
      const like = `%${q.q.replace(/[%_\\]/g, '')}%`;
      w.add('(d.atm_code ILIKE ? OR d.name ILIKE ? OR d.city ILIKE ? OR d.site ILIKE ? OR si.sip_username ILIKE ?)', like, like, like, like, like);
    }
    const order = orderBy(q.sort, SORTS, 'd.atm_code ASC');
    const [items, total] = await Promise.all([
      this.db.query(`${ATM_SELECT} ${w.sql} ORDER BY ${order} LIMIT ${q.pageSize} OFFSET ${offset(q)}`, w.params),
      this.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM (${ATM_SELECT} ${w.sql}) x`, w.params),
    ]);
    return { items, total: total?.n ?? 0, page: q.page, pageSize: q.pageSize };
  }

  async get(user: AuthUser, id: string) {
    const w = this.scopedWhere(user).add('d.id = ?', id);
    const atm = await this.db.one(`${ATM_SELECT} ${w.sql}`, w.params);
    if (!atm) throw notFound('ATM');
    return atm;
  }

  async detail(user: AuthUser, id: string) {
    const atm = await this.get(user, id);
    const [calls, faults, events] = await Promise.all([
      this.db.query(
        `SELECT c.id, c.state, c.priority, c.routing_decision AS "routingDecision", u.display_name AS "operatorName",
                c.requested_at AS "requestedAt", c.answered_at AS "answeredAt", c.ended_at AS "endedAt",
                c.duration_ms AS "durationMs", c.sip_code AS "sipCode", c.failure_reason AS "failureReason"
           FROM call_sessions c JOIN operators o ON o.id = c.operator_id JOIN users u ON u.id = o.user_id
          WHERE c.atm_id = $1 ORDER BY c.requested_at DESC LIMIT 25`,
        [id],
      ),
      this.db.query(
        `SELECT id::text, type, severity, detail, occurred_at AS "occurredAt" FROM device_events
          WHERE atm_id = $1 AND severity <> 'info' ORDER BY occurred_at DESC LIMIT 25`,
        [id],
      ),
      this.db.query(
        `SELECT id::text, type, severity, detail, occurred_at AS "occurredAt" FROM device_events
          WHERE atm_id = $1 ORDER BY occurred_at DESC LIMIT 50`,
        [id],
      ),
    ]);
    const canVms = user.permissions.has(Permission.VMS_LINK);
    return {
      ...atm,
      vmsLink: canVms ? this.vmsLink(atm) : null,
      sip: { username: atm.sipUsername, domain: config().SIP_DOMAIN, realm: config().SIP_REALM, credentialVersion: atm.credentialVersion },
      recentCalls: calls,
      faults,
      deviceEvents: events,
    };
  }

  private vmsLink(atm: any): string | null {
    if (!atm.vmsDeepLink) return null;
    return atm.vmsDeepLink
      .replace('{atmCode}', encodeURIComponent(atm.atmCode))
      .replace('{cameraRef}', encodeURIComponent(atm.vmsCameraRef ?? ''));
  }

  async create(user: AuthUser, dto: CreateAtmDto, req: Request) {
    const org = scopeOrg(user, dto.orgId);
    try {
      const out = await this.db.tx((c) => this.insertAtm(c, user, org, dto, req));
      return { atm: await this.get(user, out.id), credentials: out.credentials };
    } catch (e) {
      if (isUniqueViolation(e, 'ux_atm_code')) throw conflict('ATM_CODE_EXISTS', `ATM ${dto.atmCode} already exists`);
      if (isUniqueViolation(e, 'ux_sip_username')) throw conflict('SIP_USERNAME_EXISTS', 'SIP identity already exists');
      throw e;
    }
  }

  private async insertAtm(c: PoolClient, user: AuthUser, org: string, dto: CreateAtmDto, req?: Request) {
    const r = await c.query(
      `INSERT INTO atm_devices (organization_id, atm_code, name, region_id, state, city, site, address, latitude, longitude,
                                device_model, serial_number, vms_camera_ref, vms_deep_link)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,coalesce($11,'WINTEK-ESP32S3-INTERCOM'),$12,$13,$14) RETURNING id`,
      [org, dto.atmCode, dto.name, dto.regionId, dto.state ?? null, dto.city ?? null, dto.site ?? null, dto.address ?? null,
       dto.latitude ?? null, dto.longitude ?? null, dto.deviceModel ?? null, dto.serialNumber ?? null, dto.vmsCameraRef ?? null, dto.vmsDeepLink || null],
    );
    const id: string = r.rows[0].id;
    if (dto.groupIds?.length) {
      await c.query(`INSERT INTO atm_group_members (organization_id, atm_id, group_id) SELECT $1, $2, unnest($3::uuid[])`, [org, id, dto.groupIds]);
    }
    await c.query(
      `INSERT INTO atm_assignments (atm_id, organization_id, primary_operator_id, backup_operator_id, updated_by) VALUES ($1,$2,$3,$4,$5)`,
      [id, org, dto.primaryOperatorId ?? null, dto.backupOperatorId ?? null, user.userId],
    );
    let credentials: IssuedSipCredential | null = null;
    if (dto.provisionSip !== false) {
      credentials = await this.sip.issue(c, { kind: 'ATM', atmId: id }, org, atmSipUsername(dto.atmCode));
    }
    await this.audit.record(
      {
        actor: user, organizationId: org, action: 'atm.provisioned', entityType: 'atm', entityId: id, req,
        detail: { atmCode: dto.atmCode, sipUsername: credentials?.sipUsername ?? null, credentialVersion: credentials?.credentialVersion ?? null },
      },
      c,
    );
    return { id, credentials };
  }

  async update(user: AuthUser, id: string, dto: UpdateAtmDto, req: Request) {
    const current = await this.get(user, id);
    const org = current.organizationId as string;
    const map: Record<string, string> = {
      name: 'name', regionId: 'region_id', state: 'state', city: 'city', site: 'site', address: 'address',
      deviceModel: 'device_model', serialNumber: 'serial_number', status: 'status', vmsCameraRef: 'vms_camera_ref', vmsDeepLink: 'vms_deep_link',
    };
    await this.db.tx(async (c) => {
      const sets: string[] = [];
      const p: unknown[] = [id];
      for (const [k, col] of Object.entries(map)) {
        const v = (dto as any)[k];
        if (v === undefined) continue;
        p.push(v === '' ? null : v);
        sets.push(`${col} = $${p.length}`);
      }
      if (sets.length) await c.query(`UPDATE atm_devices SET ${sets.join(', ')} WHERE id = $1`, p);
      if (dto.groupIds) {
        await c.query(`DELETE FROM atm_group_members WHERE atm_id = $1`, [id]);
        if (dto.groupIds.length) {
          await c.query(`INSERT INTO atm_group_members (organization_id, atm_id, group_id) SELECT $1, $2, unnest($3::uuid[])`, [org, id, dto.groupIds]);
        }
      }
      if (dto.status === 'DISABLED') await this.sip.disable(c, id);
      if (dto.status === 'ACTIVE') await c.query(`UPDATE sip_identities SET enabled = true WHERE atm_id = $1`, [id]);
      await this.audit.record({ actor: user, organizationId: org, action: 'atm.updated', entityType: 'atm', entityId: id, detail: { changes: dto }, req }, c);
    });
    const atm = await this.get(user, id);
    await this.bus.publish({
      type: 'atm.status.changed', orgId: org, entityType: 'atm', entityId: id, entityVersion: atm.version,
      data: { atmId: id, registration: atm.registrationStatus, health: atm.health, inCall: !!atm.activeCallId, lastSeenAt: atm.lastSeenAt },
    });
    return atm;
  }

  /** Soft delete: history keeps pointing at the row; the SIP identity is disabled at once. */
  async remove(user: AuthUser, id: string, req: Request) {
    const atm = await this.get(user, id);
    if (atm.activeCallId) throw conflict('ATM_IN_CALL', 'ATM has an active call');
    await this.db.tx(async (c) => {
      await c.query(`UPDATE atm_devices SET deleted_at = now(), status = 'DISABLED' WHERE id = $1`, [id]);
      await this.sip.disable(c, id);
      await this.audit.record({ actor: user, organizationId: atm.organizationId, action: 'atm.deleted', entityType: 'atm', entityId: id, detail: { atmCode: atm.atmCode }, req }, c);
    });
  }

  /** New password, returned once. The device must be re-provisioned over BLE with it. */
  async rotateCredentials(user: AuthUser, id: string, req: Request) {
    const atm = await this.get(user, id);
    const cred = await this.db.tx(async (c) => {
      const issued = await this.sip.issue(c, { kind: 'ATM', atmId: id }, atm.organizationId, atm.sipUsername ?? atmSipUsername(atm.atmCode));
      await c.query(`INSERT INTO device_events (organization_id, atm_id, type, detail) VALUES ($1,$2,'CREDENTIAL_ROTATED',$3)`, [
        atm.organizationId, id, JSON.stringify({ credentialVersion: issued.credentialVersion, by: user.username }),
      ]);
      await this.audit.record(
        { actor: user, organizationId: atm.organizationId, action: 'atm.credentials.rotated', entityType: 'atm', entityId: id, detail: { credentialVersion: issued.credentialVersion }, req },
        c,
      );
      return issued;
    });
    return { credentials: cred, notice: 'The previous password stops working at the device\'s next registration refresh. Provision the device with this password now; it will not be shown again.' };
  }

  async bulk(user: AuthUser, dto: BulkAtmDto, req: Request) {
    const org = scopeOrg(user, undefined);
    const ids = dto.atmIds;
    const needTarget = ['SET_REGION', 'ADD_GROUP', 'REMOVE_GROUP'];
    if (needTarget.includes(dto.action) && !dto.targetId) throw new BadRequestException({ code: 'TARGET_REQUIRED', message: `${dto.action} needs targetId` });
    const affected = await this.db.tx(async (c) => {
      const owned = await c.query(`SELECT id FROM atm_devices WHERE organization_id = $1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL FOR UPDATE`, [org, ids]);
      const okIds = owned.rows.map((r) => r.id);
      if (okIds.length !== ids.length) throw new BadRequestException({ code: 'UNKNOWN_ATMS', message: `${ids.length - okIds.length} ATM(s) not found in this organization` });
      switch (dto.action) {
        case 'SET_REGION':
          await c.query(`UPDATE atm_devices SET region_id = $2 WHERE id = ANY($1::uuid[])`, [okIds, dto.targetId]);
          break;
        case 'ADD_GROUP':
          await c.query(`INSERT INTO atm_group_members (organization_id, atm_id, group_id) SELECT $1, unnest($2::uuid[]), $3 ON CONFLICT DO NOTHING`, [org, okIds, dto.targetId]);
          break;
        case 'REMOVE_GROUP':
          await c.query(`DELETE FROM atm_group_members WHERE atm_id = ANY($1::uuid[]) AND group_id = $2`, [okIds, dto.targetId]);
          break;
        case 'DISABLE':
        case 'ENABLE':
        case 'MAINTENANCE': {
          const status = dto.action === 'ENABLE' ? 'ACTIVE' : dto.action === 'DISABLE' ? 'DISABLED' : 'MAINTENANCE';
          await c.query(`UPDATE atm_devices SET status = $2 WHERE id = ANY($1::uuid[])`, [okIds, status]);
          await c.query(`UPDATE sip_identities SET enabled = $2 WHERE atm_id = ANY($1::uuid[])`, [okIds, status !== 'DISABLED']);
          break;
        }
        case 'SET_PRIMARY':
        case 'SET_BACKUP': {
          const col = dto.action === 'SET_PRIMARY' ? 'primary_operator_id' : 'backup_operator_id';
          await c.query(
            `INSERT INTO atm_assignments (atm_id, organization_id, ${col}, updated_by) SELECT unnest($1::uuid[]), $2, $3, $4
             ON CONFLICT (atm_id) DO UPDATE SET ${col} = EXCLUDED.${col}, updated_by = EXCLUDED.updated_by, updated_at = now()`,
            [okIds, org, dto.targetId ?? null, user.userId],
          );
          break;
        }
      }
      await this.audit.record(
        { actor: user, organizationId: org, action: `atm.bulk.${dto.action.toLowerCase()}`, entityType: 'atm', entityId: `${okIds.length} atms`, detail: { atmIds: okIds, targetId: dto.targetId ?? null }, req },
        c,
      );
      return okIds.length;
    });
    return { affected };
  }

  /**
   * CSV import (create or update by atm_code). Rows are validated first; with
   * dryRun nothing is written. Otherwise all valid rows are written in one
   * transaction and invalid rows are reported, so a re-run after fixing the
   * file is idempotent.
   */
  async importCsv(user: AuthUser, csv: string, opts: { dryRun?: boolean; provisionSip?: boolean; orgId?: string }, req: Request) {
    const org = scopeOrg(user, opts.orgId);
    const { header, records } = parseCsvObjects(csv);
    for (const h of ['atm_code', 'name', 'region_code']) {
      if (!header.includes(h)) throw new BadRequestException({ code: 'CSV_HEADER', message: `Missing column ${h}` });
    }
    if (records.length > 20_000) throw new BadRequestException({ code: 'CSV_TOO_LARGE', message: 'At most 20,000 rows per import' });

    const [regions, groups, ops, existing] = await Promise.all([
      this.db.query(`SELECT id, lower(code) AS code FROM regions WHERE organization_id = $1 AND deleted_at IS NULL`, [org]),
      this.db.query(`SELECT id, lower(code) AS code FROM atm_groups WHERE organization_id = $1 AND deleted_at IS NULL`, [org]),
      this.db.query(`SELECT o.id, lower(u.username) AS username FROM operators o JOIN users u ON u.id = o.user_id WHERE o.organization_id = $1 AND o.deleted_at IS NULL`, [org]),
      this.db.query(`SELECT id, lower(atm_code) AS code FROM atm_devices WHERE organization_id = $1 AND deleted_at IS NULL`, [org]),
    ]);
    const regionBy = new Map(regions.map((r) => [r.code, r.id]));
    const groupBy = new Map(groups.map((g) => [g.code, g.id]));
    const opBy = new Map(ops.map((o) => [o.username, o.id]));
    const existingBy = new Map(existing.map((e) => [e.code, e.id]));
    const seen = new Set<string>();

    const results: ImportRowResult[] = [];
    const valid: { line: number; dto: CreateAtmDto; existingId?: string }[] = [];
    records.forEach((rec, i) => {
      const line = i + 2;
      const code = rec.atm_code ?? '';
      const err = (m: string) => results.push({ line, atmCode: code, status: 'ERROR', error: m });
      if (!/^[A-Za-z0-9._-]{2,40}$/.test(code)) return err('invalid atm_code');
      if (seen.has(code.toLowerCase())) return err('duplicate atm_code in file');
      seen.add(code.toLowerCase());
      if (!rec.name || rec.name.length < 2) return err('name is required');
      const regionId = regionBy.get((rec.region_code ?? '').toLowerCase());
      if (!regionId) return err(`unknown region_code "${rec.region_code}"`);
      const groupCodes = (rec.group_codes ?? '').split(';').map((s) => s.trim().toLowerCase()).filter(Boolean);
      const groupIds: string[] = [];
      for (const gc of groupCodes) {
        const g = groupBy.get(gc);
        if (!g) return err(`unknown group_code "${gc}"`);
        groupIds.push(g);
      }
      const primary = rec.primary_username ? opBy.get(rec.primary_username.toLowerCase()) : undefined;
      if (rec.primary_username && !primary) return err(`unknown primary_username "${rec.primary_username}"`);
      const backup = rec.backup_username ? opBy.get(rec.backup_username.toLowerCase()) : undefined;
      if (rec.backup_username && !backup) return err(`unknown backup_username "${rec.backup_username}"`);
      if (primary && primary === backup) return err('primary and backup must differ');
      const lat = rec.latitude ? Number(rec.latitude) : undefined;
      const lng = rec.longitude ? Number(rec.longitude) : undefined;
      if (lat !== undefined && (!Number.isFinite(lat) || Math.abs(lat) > 90)) return err('invalid latitude');
      if (lng !== undefined && (!Number.isFinite(lng) || Math.abs(lng) > 180)) return err('invalid longitude');
      valid.push({
        line,
        existingId: existingBy.get(code.toLowerCase()),
        dto: {
          atmCode: code, name: rec.name, regionId, state: rec.state || undefined, city: rec.city || undefined, site: rec.site || undefined,
          address: rec.address || undefined, latitude: lat, longitude: lng, deviceModel: rec.device_model || undefined,
          serialNumber: rec.serial_number || undefined, groupIds, primaryOperatorId: primary, backupOperatorId: backup,
          vmsCameraRef: rec.vms_camera_ref || undefined, provisionSip: opts.provisionSip ?? true,
        },
      });
    });

    if (!opts.dryRun && valid.length) {
      await this.db.tx(async (c) => {
        for (const v of valid) {
          if (v.existingId) {
            await c.query(
              `UPDATE atm_devices SET name=$2, region_id=$3, state=$4, city=$5, site=$6, address=$7, latitude=$8, longitude=$9,
                      device_model=coalesce($10, device_model), serial_number=coalesce($11, serial_number), vms_camera_ref=coalesce($12, vms_camera_ref)
                WHERE id=$1`,
              [v.existingId, v.dto.name, v.dto.regionId, v.dto.state ?? null, v.dto.city ?? null, v.dto.site ?? null, v.dto.address ?? null,
               v.dto.latitude ?? null, v.dto.longitude ?? null, v.dto.deviceModel ?? null, v.dto.serialNumber ?? null, v.dto.vmsCameraRef ?? null],
            );
            await c.query(`DELETE FROM atm_group_members WHERE atm_id = $1`, [v.existingId]);
            if (v.dto.groupIds?.length) {
              await c.query(`INSERT INTO atm_group_members (organization_id, atm_id, group_id) SELECT $1,$2,unnest($3::uuid[])`, [org, v.existingId, v.dto.groupIds]);
            }
            await c.query(
              `UPDATE atm_assignments SET primary_operator_id = $2, backup_operator_id = $3, updated_by = $4, updated_at = now() WHERE atm_id = $1`,
              [v.existingId, v.dto.primaryOperatorId ?? null, v.dto.backupOperatorId ?? null, user.userId],
            );
            results.push({ line: v.line, atmCode: v.dto.atmCode, status: 'UPDATED' });
          } else {
            const out = await this.insertAtm(c, user, org, v.dto);
            results.push({ line: v.line, atmCode: v.dto.atmCode, status: 'CREATED', credentials: out.credentials ?? undefined });
          }
        }
        await this.audit.record(
          {
            actor: user, organizationId: org, action: 'atm.imported', entityType: 'atm', entityId: 'csv', req,
            detail: { rows: records.length, created: results.filter((r) => r.status === 'CREATED').length, updated: results.filter((r) => r.status === 'UPDATED').length, errors: results.filter((r) => r.status === 'ERROR').length },
          },
          c,
        );
      });
    } else if (opts.dryRun) {
      for (const v of valid) results.push({ line: v.line, atmCode: v.dto.atmCode, status: v.existingId ? 'UPDATED' : 'CREATED' });
    }
    results.sort((a, b) => a.line - b.line);
    return {
      dryRun: !!opts.dryRun,
      total: records.length,
      created: results.filter((r) => r.status === 'CREATED').length,
      updated: results.filter((r) => r.status === 'UPDATED').length,
      errors: results.filter((r) => r.status === 'ERROR').length,
      results,
    };
  }

  async regions(user: AuthUser, orgId?: string) {
    const org = scopeOrgOrAll(user, orgId);
    return this.db.query(
      `SELECT r.id, r.code, r.name, r.organization_id AS "organizationId",
              count(d.id)::int AS "atmCount",
              count(d.id) FILTER (WHERE d.registration_status = 'REGISTERED')::int AS "onlineCount"
         FROM regions r LEFT JOIN atm_devices d ON d.region_id = r.id AND d.deleted_at IS NULL
        WHERE r.deleted_at IS NULL ${org ? 'AND r.organization_id = $1' : ''}
        GROUP BY r.id ORDER BY r.name`,
      org ? [org] : [],
    );
  }

  async groups(user: AuthUser, orgId?: string) {
    const org = scopeOrgOrAll(user, orgId);
    return this.db.query(
      `SELECT g.id, g.code, g.name, g.description, g.organization_id AS "organizationId", count(m.atm_id)::int AS "atmCount"
         FROM atm_groups g LEFT JOIN atm_group_members m ON m.group_id = g.id
        WHERE g.deleted_at IS NULL ${org ? 'AND g.organization_id = $1' : ''}
        GROUP BY g.id ORDER BY g.name`,
      org ? [org] : [],
    );
  }
}
