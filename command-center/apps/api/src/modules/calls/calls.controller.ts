import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsBoolean, IsIn, IsISO8601, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';
import type { Request } from 'express';
import { ALL_CALL_STATES, Permission, Priority } from '@wintek/shared';
import { CurrentUser, RequirePermissions } from '../../common/auth/decorators';
import type { AuthUser } from '../../common/auth/auth-user';
import { scopeOrgOrAll } from '../../common/auth/tenant';
import { DatabaseService } from '../../common/db/database.service';
import { SqlWhere } from '../../common/db/sql-where';
import { PageQuery, offset, orderBy } from '../../common/http/pagination';
import { CallsService } from './calls.service';

class InitiateCallDto {
  @ApiProperty() @IsUUID() atmId: string;
  @ApiProperty({ description: 'Client-generated idempotency key (UUID recommended). Retries with the same key return the same call.' })
  @IsString() @Matches(/^[A-Za-z0-9_-]{8,64}$/) requestId: string;
  @ApiPropertyOptional({ enum: Object.values(Priority), default: 'P3' }) @IsOptional() @IsIn(Object.values(Priority)) priority?: Priority;
  @ApiPropertyOptional({ description: 'If the ATM is busy, queue the request (when policy permits) instead of failing' })
  @IsOptional() @IsBoolean() queueIfBusy?: boolean;
  @ApiPropertyOptional({ description: 'Queue item this call fulfils (accepting an offer)' }) @IsOptional() @IsUUID() queueItemId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) reason?: string;
}

class HistoryQuery extends PageQuery {
  @ApiPropertyOptional() @IsOptional() @IsUUID() atmId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() operatorId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() regionId?: string;
  @ApiPropertyOptional({ enum: ALL_CALL_STATES }) @IsOptional() @IsIn(ALL_CALL_STATES) state?: string;
  @ApiPropertyOptional({ enum: Object.values(Priority) }) @IsOptional() @IsIn(Object.values(Priority)) priority?: string;
  @ApiPropertyOptional() @IsOptional() @IsISO8601() from?: string;
  @ApiPropertyOptional() @IsOptional() @IsISO8601() to?: string;
}

@ApiTags('calls')
@ApiBearerAuth()
@Controller()
export class CallsController {
  constructor(
    private readonly calls: CallsService,
    private readonly db: DatabaseService,
  ) {}

  @Post('calls/initiate')
  @HttpCode(200)
  @RequirePermissions(Permission.CALL_INITIATE)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Reserve a call to an ATM (authorization, availability and busy checks, atomic reservation)',
    description:
      'Returns state RESERVED and a dial target + one-time token. The console then sends its INVITE; the call moves to DIALING/RINGING/CONNECTED only on SIP events. Errors: ATM_BUSY, ATM_OFFLINE, ATM_DISABLED, OPERATOR_BUSY, OPERATOR_UNAVAILABLE, NOT_AUTHORIZED, CAPACITY.',
  })
  initiate(@CurrentUser() u: AuthUser, @Body() dto: InitiateCallDto, @Req() req: Request) {
    return this.calls.initiate(u, dto, req);
  }

  @Post('calls/:id/hangup')
  @HttpCode(200)
  @RequirePermissions(Permission.CALL_READ)
  @ApiOperation({ summary: 'Hang up (own call, or any call with call:hangup:any). Idempotent.' })
  hangup(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.calls.hangup(u, id, req);
  }

  @Get('calls')
  @RequirePermissions(Permission.CALL_READ)
  @ApiOperation({ summary: 'Active calls' })
  active(@CurrentUser() u: AuthUser, @Query() q: PageQuery) {
    return this.calls.active(u, scopeOrgOrAll(u, q.orgId));
  }

  @Get('calls/mine')
  @RequirePermissions(Permission.CALL_READ)
  @ApiOperation({ summary: "The caller's own active call (console recovery after refresh)" })
  mine(@CurrentUser() u: AuthUser) {
    return this.calls.mine(u);
  }

  @Get('calls/:id/status')
  @RequirePermissions(Permission.CALL_READ)
  @ApiOperation({ summary: 'Call metadata and its full state timeline' })
  status(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.calls.get(u, id);
  }

  @Get('call-history')
  @RequirePermissions(Permission.CALL_READ)
  @ApiOperation({ summary: 'Call metadata history (no audio is ever recorded)' })
  async history(@CurrentUser() u: AuthUser, @Query() q: HistoryQuery) {
    const org = scopeOrgOrAll(u, q.orgId);
    const w = new SqlWhere();
    if (org) w.add('c.organization_id = ?', org);
    if (q.atmId) w.add('c.atm_id = ?', q.atmId);
    if (q.operatorId) w.add('c.operator_id = ?', q.operatorId);
    if (q.regionId) w.add('d.region_id = ?', q.regionId);
    if (q.state) w.add('c.state = ?', q.state);
    if (q.priority) w.add('c.priority = ?', q.priority);
    if (q.from) w.add('c.requested_at >= ?', q.from);
    if (q.to) w.add('c.requested_at < ?', q.to);
    const order = orderBy(q.sort, { requestedAt: 'c.requested_at', duration: 'c.duration_ms', state: 'c.state' }, 'c.requested_at DESC');
    const base = `FROM call_sessions c JOIN atm_devices d ON d.id = c.atm_id JOIN regions r ON r.id = d.region_id
                  JOIN operators o ON o.id = c.operator_id JOIN users u ON u.id = o.user_id ${w.sql}`;
    const [items, total] = await Promise.all([
      this.db.query(
        `SELECT c.id, c.atm_id AS "atmId", d.atm_code AS "atmCode", d.name AS "atmName", r.name AS "regionName",
                c.operator_id AS "operatorId", u.display_name AS "operatorName", c.organization_id AS "organizationId",
                c.state, c.priority, c.routing_decision AS "routingDecision", c.sip_code AS "sipCode", c.failure_reason AS "failureReason",
                c.hangup_by AS "hangupBy", c.media_node AS "mediaNode", c.correlation_id AS "correlationId",
                c.requested_at AS "requestedAt", c.answered_at AS "answeredAt", c.ended_at AS "endedAt", c.duration_ms AS "durationMs"
           ${base} ORDER BY ${order} LIMIT ${q.pageSize} OFFSET ${offset(q)}`,
        w.params,
      ),
      this.db.one<{ n: number }>(`SELECT count(*)::int AS n ${base}`, w.params),
    ]);
    return { items, total: total?.n ?? 0, page: q.page, pageSize: q.pageSize };
  }
}
