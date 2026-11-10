import { BadRequestException, Controller, Get, Injectable, Module, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsISO8601, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { Permission } from '@wintek/shared';
import { CurrentUser, RequirePermissions } from '../../common/auth/decorators';
import type { AuthUser } from '../../common/auth/auth-user';
import { scopeOrgOrAll } from '../../common/auth/tenant';
import { DatabaseService } from '../../common/db/database.service';
import { csvCell } from '../atms/csv';

const ACTIVE = `('RESERVED','DIALING','RINGING','CONNECTED','TERMINATING')`;

class OrgQuery {
  @ApiPropertyOptional() @IsOptional() @IsUUID() orgId?: string;
}

class ActivityQuery extends OrgQuery {
  @ApiPropertyOptional({ default: 50 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit = 50;
}

class ReportQuery extends OrgQuery {
  @ApiPropertyOptional({ description: 'Default: 24 h ago' }) @IsOptional() @IsISO8601() from?: string;
  @ApiPropertyOptional({ description: 'Default: now' }) @IsOptional() @IsISO8601() to?: string;
  @ApiPropertyOptional({ enum: ['hour', 'day'] }) @IsOptional() @IsIn(['hour', 'day']) bucket?: 'hour' | 'day';
  @ApiPropertyOptional({ enum: ['json', 'csv'] }) @IsOptional() @IsIn(['json', 'csv']) format?: 'json' | 'csv';
}

@Injectable()
export class DashboardService {
  constructor(private readonly db: DatabaseService) {}

  /**
   * All ten headline numbers in one round trip. Each count is index-backed
   * (partial indexes on deleted_at / state), so this stays in the low
   * milliseconds at 20,000 ATMs.
   */
  async summary(org: string | null) {
    const p = org ? [org] : [];
    const f = (alias: string) => (org ? `AND ${alias}.organization_id = $1` : '');
    const r = await this.db.one(
      `SELECT
         (SELECT count(*) FROM atm_devices d WHERE d.deleted_at IS NULL ${f('d')})::int AS "totalAtms",
         (SELECT count(*) FROM atm_devices d WHERE d.deleted_at IS NULL AND d.status = 'ACTIVE' AND d.registration_status = 'REGISTERED' ${f('d')})::int AS "onlineAtms",
         (SELECT count(*) FROM atm_devices d WHERE d.deleted_at IS NULL AND (d.status <> 'ACTIVE' OR d.registration_status <> 'REGISTERED') ${f('d')})::int AS "offlineAtms",
         (SELECT count(*) FROM sip_identities s WHERE s.kind = 'ATM' AND s.enabled ${f('s')})::int AS "provisionedSipDevices",
         (SELECT count(*) FROM atm_devices d WHERE d.deleted_at IS NULL AND d.registration_status = 'REGISTERED' ${f('d')})::int AS "registeredSipDevices",
         (SELECT count(*) FROM call_sessions c WHERE c.state IN ${ACTIVE} ${f('c')})::int AS "activeCalls",
         (SELECT count(*) FROM call_sessions c WHERE c.state = 'CONNECTED' ${f('c')})::int AS "connectedCalls",
         (SELECT count(*) FROM operator_presence p WHERE p.effective = 'AVAILABLE' ${f('p')})::int AS "availableOperators",
         (SELECT count(*) FROM operator_presence p WHERE p.effective = 'BUSY' ${f('p')})::int AS "busyOperators",
         (SELECT count(*) FROM operator_presence p WHERE p.effective IN ('BREAK','UNAVAILABLE','FAULT') ${f('p')})::int AS "unavailableOperators",
         (SELECT count(*) FROM operator_presence p WHERE p.effective = 'OFFLINE' ${f('p')})::int AS "offlineOperators",
         (SELECT count(*) FROM atm_devices d WHERE d.deleted_at IS NULL AND d.health IN ('FAULT','DEGRADED') ${f('d')})::int AS "faultyDevices",
         (SELECT count(*) FROM call_sessions c WHERE c.requested_at >= date_trunc('day', now()) ${f('c')})::int AS "callsToday",
         (SELECT count(*) FROM call_sessions c WHERE c.requested_at >= date_trunc('day', now()) AND c.state IN ('FAILED','TIMEOUT','BUSY') ${f('c')})::int AS "failedCallsToday",
         (SELECT count(*) FROM call_queue q WHERE q.state IN ('WAITING','OFFERED') ${f('q')})::int AS "queuedRequests",
         now() AS "asOf"`,
      p,
    );
    return r;
  }

  async activity(org: string | null, limit: number) {
    const p: unknown[] = [];
    const where = org ? `WHERE x.organization_id = $${p.push(org)}` : '';
    p.push(limit);
    return this.db.query(
      `SELECT * FROM (
         SELECT 'call' AS kind, ce.id::text AS id, ce.organization_id, ce.occurred_at AS at, ce.to_state AS type,
                CASE WHEN ce.to_state IN ('FAILED','TIMEOUT','BUSY') THEN 'warning' ELSE 'info' END AS severity,
                d.atm_code AS "atmCode", d.name AS "atmName", u.display_name AS "operatorName", ce.call_id::text AS "refId"
           FROM call_events ce JOIN call_sessions c ON c.id = ce.call_id JOIN atm_devices d ON d.id = c.atm_id
           JOIN operators o ON o.id = c.operator_id JOIN users u ON u.id = o.user_id
          WHERE ce.occurred_at > now() - interval '24 hours' AND ce.to_state NOT IN ('REQUESTED','VALIDATING')
         UNION ALL
         SELECT 'device', de.id::text, de.organization_id, de.occurred_at, de.type, de.severity, d.atm_code, d.name, NULL, de.atm_id::text
           FROM device_events de JOIN atm_devices d ON d.id = de.atm_id
          WHERE de.occurred_at > now() - interval '24 hours'
       ) x ${where} ORDER BY at DESC LIMIT $${p.length}`,
      p,
    );
  }

  async regional(org: string | null) {
    return this.db.query(
      `SELECT r.id, r.name, count(d.id)::int AS total,
              count(d.id) FILTER (WHERE d.registration_status = 'REGISTERED' AND d.status = 'ACTIVE')::int AS online,
              count(d.id) FILTER (WHERE d.health IN ('FAULT','DEGRADED'))::int AS faults,
              (SELECT count(*) FROM call_sessions c JOIN atm_devices d2 ON d2.id = c.atm_id WHERE d2.region_id = r.id AND c.state IN ${ACTIVE})::int AS "activeCalls",
              (SELECT count(DISTINCT orr.operator_id) FROM operator_regions orr JOIN operator_presence p ON p.operator_id = orr.operator_id
                WHERE orr.region_id = r.id AND p.effective = 'AVAILABLE')::int AS "availableOperators"
         FROM regions r LEFT JOIN atm_devices d ON d.region_id = r.id AND d.deleted_at IS NULL
        WHERE r.deleted_at IS NULL ${org ? 'AND r.organization_id = $1' : ''}
        GROUP BY r.id ORDER BY r.name`,
      org ? [org] : [],
    );
  }

  private window(q: ReportQuery) {
    const to = q.to ? new Date(q.to) : new Date();
    const from = q.from ? new Date(q.from) : new Date(to.getTime() - 86_400_000);
    if (to.getTime() - from.getTime() > 92 * 86_400_000) throw new BadRequestException({ code: 'WINDOW_TOO_LARGE', message: 'Report window is limited to 92 days' });
    if (to <= from) throw new BadRequestException({ code: 'BAD_WINDOW', message: 'to must be after from' });
    return { from, to, bucket: q.bucket ?? (to.getTime() - from.getTime() > 3 * 86_400_000 ? 'day' : 'hour') };
  }

  async callsReport(org: string | null, q: ReportQuery) {
    const { from, to, bucket } = this.window(q);
    const p: unknown[] = [from, to];
    const of = org ? `AND c.organization_id = $${p.push(org)}` : '';
    const [series, byRegion, byOperator, failures] = await Promise.all([
      this.db.query(
        `SELECT g.t AS bucket,
                count(c.id)::int AS total,
                count(c.id) FILTER (WHERE c.answered_at IS NOT NULL)::int AS connected,
                count(c.id) FILTER (WHERE c.state IN ('FAILED','TIMEOUT','BUSY'))::int AS failed,
                coalesce(round(avg(c.duration_ms) FILTER (WHERE c.duration_ms IS NOT NULL) / 1000), 0)::int AS "avgDurationSec"
           FROM generate_series(date_trunc('${bucket}', $1::timestamptz), $2::timestamptz, interval '1 ${bucket}') g(t)
           LEFT JOIN call_sessions c ON date_trunc('${bucket}', c.requested_at) = g.t ${of}
          GROUP BY g.t ORDER BY g.t`,
        p,
      ),
      this.db.query(
        `SELECT r.name AS region, count(*)::int AS total, count(*) FILTER (WHERE c.answered_at IS NOT NULL)::int AS connected,
                count(*) FILTER (WHERE c.state IN ('FAILED','TIMEOUT','BUSY'))::int AS failed
           FROM call_sessions c JOIN atm_devices d ON d.id = c.atm_id JOIN regions r ON r.id = d.region_id
          WHERE c.requested_at >= $1 AND c.requested_at < $2 ${of} GROUP BY r.name ORDER BY total DESC`,
        p,
      ),
      this.db.query(
        `SELECT u.display_name AS operator, count(*)::int AS calls, count(*) FILTER (WHERE c.answered_at IS NOT NULL)::int AS connected,
                coalesce(sum(c.duration_ms) / 1000, 0)::int AS "talkTimeSec"
           FROM call_sessions c JOIN operators o ON o.id = c.operator_id JOIN users u ON u.id = o.user_id
          WHERE c.requested_at >= $1 AND c.requested_at < $2 ${of} GROUP BY u.display_name ORDER BY calls DESC LIMIT 50`,
        p,
      ),
      this.db.query(
        `SELECT c.state, coalesce(c.failure_reason, '') AS reason, c.sip_code AS "sipCode", count(*)::int AS count
           FROM call_sessions c WHERE c.requested_at >= $1 AND c.requested_at < $2 AND c.state IN ('FAILED','TIMEOUT','BUSY','CANCELLED') ${of}
          GROUP BY 1, 2, 3 ORDER BY count DESC LIMIT 50`,
        p,
      ),
    ]);
    return { from, to, bucket, series, byRegion, byOperator, failures };
  }

  /** Device availability trend from registration events (UNREGISTERED/EXPIRED vs REGISTERED). */
  async availabilityReport(org: string | null, q: ReportQuery) {
    const { from, to, bucket } = this.window(q);
    const p: unknown[] = [from, to];
    const of = org ? `AND e.organization_id = $${p.push(org)}` : '';
    return this.db.query(
      `SELECT g.t AS bucket,
              count(e.id) FILTER (WHERE e.type = 'REGISTERED')::int AS registrations,
              count(e.id) FILTER (WHERE e.type IN ('UNREGISTERED','EXPIRED'))::int AS disconnects,
              count(e.id) FILTER (WHERE e.type = 'FAULT')::int AS faults
         FROM generate_series(date_trunc('${bucket}', $1::timestamptz), $2::timestamptz, interval '1 ${bucket}') g(t)
         LEFT JOIN device_events e ON date_trunc('${bucket}', e.occurred_at) = g.t ${of}
        GROUP BY g.t ORDER BY g.t`,
      p,
    );
  }

  toCsv(rows: Record<string, unknown>[]): string {
    if (!rows.length) return '';
    const cols = Object.keys(rows[0]!);
    return [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c] instanceof Date ? (r[c] as Date).toISOString() : r[c])).join(','))].join('\n');
  }
}

@ApiTags('dashboard')
@ApiBearerAuth()
@Controller()
export class DashboardController {
  constructor(private readonly svc: DashboardService) {}

  @Get('dashboard/summary')
  @RequirePermissions(Permission.ATM_READ)
  @ApiOperation({ summary: 'Headline counts: ATMs, SIP registrations, calls, operators, faults' })
  summary(@CurrentUser() u: AuthUser, @Query() q: OrgQuery) {
    return this.svc.summary(scopeOrgOrAll(u, q.orgId));
  }

  @Get('dashboard/activity')
  @RequirePermissions(Permission.ATM_READ)
  @ApiOperation({ summary: 'Recent call and device events (last 24 h)' })
  activity(@CurrentUser() u: AuthUser, @Query() q: ActivityQuery) {
    return this.svc.activity(scopeOrgOrAll(u, q.orgId), q.limit);
  }

  @Get('dashboard/regions')
  @RequirePermissions(Permission.ATM_READ)
  @ApiOperation({ summary: 'Per-region availability, faults, active calls and available operators' })
  regions(@CurrentUser() u: AuthUser, @Query() q: OrgQuery) {
    return this.svc.regional(scopeOrgOrAll(u, q.orgId));
  }

  @Get('reports/calls')
  @RequirePermissions(Permission.REPORT_READ)
  @ApiOperation({ summary: 'Calls per hour/day, per region, per operator, failure breakdown (json or csv)' })
  async calls(@CurrentUser() u: AuthUser, @Query() q: ReportQuery) {
    const r = await this.svc.callsReport(scopeOrgOrAll(u, q.orgId), q);
    return q.format === 'csv' ? this.svc.toCsv(r.series) : r;
  }

  @Get('reports/availability')
  @RequirePermissions(Permission.REPORT_READ)
  @ApiOperation({ summary: 'Device registration/disconnect/fault trend' })
  async availability(@CurrentUser() u: AuthUser, @Query() q: ReportQuery) {
    const r = await this.svc.availabilityReport(scopeOrgOrAll(u, q.orgId), q);
    return q.format === 'csv' ? this.svc.toCsv(r) : r;
  }
}

@Module({ providers: [DashboardService], controllers: [DashboardController] })
export class DashboardModule {}
