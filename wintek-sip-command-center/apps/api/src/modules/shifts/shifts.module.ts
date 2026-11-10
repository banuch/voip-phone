import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Injectable, Module, Param, ParseUUIDPipe, Post, Put, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';
import type { Request } from 'express';
import { Permission } from '@wintek/shared';
import { CurrentUser, RequirePermissions } from '../../common/auth/decorators';
import type { AuthUser } from '../../common/auth/auth-user';
import { scopeOrg } from '../../common/auth/tenant';
import { DatabaseService } from '../../common/db/database.service';
import { notFound } from '../../common/http/errors';
import { AuditService } from '../audit/audit.service';
import { ON_SHIFT_SQL } from '../operators/operators.service';

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

class ShiftDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() orgId?: string;
  @ApiProperty() @IsString() @MaxLength(80) name: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() regionId?: string;
  @ApiProperty({ type: [Number], description: 'ISO weekdays, 1 = Monday' })
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(7) @IsInt({ each: true }) @Min(1, { each: true }) @Max(7, { each: true }) daysOfWeek: number[];
  @ApiProperty({ example: '22:00' }) @Matches(TIME) startTime: string;
  @ApiProperty({ example: '06:00', description: 'Earlier than startTime = crosses midnight' }) @Matches(TIME) endTime: string;
  @ApiProperty({ example: 'Asia/Kolkata' }) @IsString() @MaxLength(60) timezone: string;
}

class ShiftMembersDto {
  @ApiProperty({ type: [String] }) @IsArray() @ArrayMaxSize(500) @IsUUID('all', { each: true }) operatorIds: string[];
  @ApiPropertyOptional() @IsOptional() @IsISO8601() validFrom?: string;
  @ApiPropertyOptional() @IsOptional() @IsISO8601() validTo?: string;
}

@Injectable()
export class ShiftsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  private validTz(tz: string) {
    try {
      new Intl.DateTimeFormat('en', { timeZone: tz });
    } catch {
      throw new BadRequestException({ code: 'BAD_TIMEZONE', message: `Unknown time zone ${tz}` });
    }
    if (tz === '') throw new BadRequestException({ code: 'BAD_TIMEZONE', message: 'timezone is required' });
  }

  list(user: AuthUser, orgId?: string) {
    const org = scopeOrg(user, orgId);
    return this.db.query(
      `SELECT s.id, s.name, s.region_id AS "regionId", r.name AS "regionName", s.days_of_week AS "daysOfWeek",
              to_char(s.start_time, 'HH24:MI') AS "startTime", to_char(s.end_time, 'HH24:MI') AS "endTime", s.timezone,
              (SELECT coalesce(json_agg(json_build_object('operatorId', o.id, 'name', u.display_name, 'validFrom', m.valid_from, 'validTo', m.valid_to,
                                                          'onShift', ${ON_SHIFT_SQL('o.id')}) ORDER BY u.display_name), '[]')
                 FROM shift_members m JOIN operators o ON o.id = m.operator_id JOIN users u ON u.id = o.user_id
                WHERE m.shift_id = s.id AND (m.valid_to IS NULL OR m.valid_to >= current_date)) AS members,
              s.version
         FROM shifts s LEFT JOIN regions r ON r.id = s.region_id
        WHERE s.organization_id = $1 AND s.deleted_at IS NULL ORDER BY s.start_time, s.name`,
      [org],
    );
  }

  async create(user: AuthUser, dto: ShiftDto, req: Request) {
    const org = scopeOrg(user, dto.orgId);
    this.validTz(dto.timezone);
    if (dto.startTime === dto.endTime) throw new BadRequestException({ code: 'BAD_SHIFT', message: 'startTime and endTime must differ' });
    return this.db.tx(async (c) => {
      const r = await c.query(
        `INSERT INTO shifts (organization_id, region_id, name, days_of_week, start_time, end_time, timezone)
         VALUES ($1,$2,$3,$4::smallint[],$5,$6,$7) RETURNING id`,
        [org, dto.regionId ?? null, dto.name, dto.daysOfWeek, dto.startTime, dto.endTime, dto.timezone],
      );
      await this.audit.record({ actor: user, organizationId: org, action: 'shift.created', entityType: 'shift', entityId: r.rows[0].id, detail: { ...dto }, req }, c);
      return { id: r.rows[0].id };
    });
  }

  async update(user: AuthUser, id: string, dto: ShiftDto, req: Request) {
    const org = scopeOrg(user, dto.orgId);
    this.validTz(dto.timezone);
    return this.db.tx(async (c) => {
      const r = await c.query(
        `UPDATE shifts SET region_id=$3, name=$4, days_of_week=$5::smallint[], start_time=$6, end_time=$7, timezone=$8
          WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL RETURNING id`,
        [id, org, dto.regionId ?? null, dto.name, dto.daysOfWeek, dto.startTime, dto.endTime, dto.timezone],
      );
      if (!r.rowCount) throw notFound('Shift');
      await this.audit.record({ actor: user, organizationId: org, action: 'shift.updated', entityType: 'shift', entityId: id, detail: { ...dto }, req }, c);
      return { id };
    });
  }

  async remove(user: AuthUser, id: string, req: Request) {
    const org = scopeOrg(user, undefined);
    await this.db.tx(async (c) => {
      const r = await c.query(`UPDATE shifts SET deleted_at = now() WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL`, [id, org]);
      if (!r.rowCount) throw notFound('Shift');
      await this.audit.record({ actor: user, organizationId: org, action: 'shift.deleted', entityType: 'shift', entityId: id, req }, c);
    });
  }

  async setMembers(user: AuthUser, id: string, dto: ShiftMembersDto, req: Request) {
    const org = scopeOrg(user, undefined);
    await this.db.tx(async (c) => {
      const s = await c.query(`SELECT id FROM shifts WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL FOR UPDATE`, [id, org]);
      if (!s.rowCount) throw notFound('Shift');
      await c.query(`DELETE FROM shift_members WHERE shift_id = $1`, [id]);
      if (dto.operatorIds.length) {
        await c.query(
          `INSERT INTO shift_members (organization_id, shift_id, operator_id, valid_from, valid_to)
           SELECT $1, $2, unnest($3::uuid[]), coalesce($4::date, current_date), $5::date`,
          [org, id, dto.operatorIds, dto.validFrom ?? null, dto.validTo ?? null],
        );
      }
      await this.audit.record({ actor: user, organizationId: org, action: 'shift.members.updated', entityType: 'shift', entityId: id, detail: { ...dto }, req }, c);
    });
    return { id, members: dto.operatorIds.length };
  }

  onDuty(user: AuthUser, orgId?: string) {
    const org = scopeOrg(user, orgId);
    return this.db.query(
      `SELECT o.id AS "operatorId", u.display_name AS name, coalesce(p.effective, 'OFFLINE') AS availability
         FROM operators o JOIN users u ON u.id = o.user_id LEFT JOIN operator_presence p ON p.operator_id = o.id
        WHERE o.organization_id = $1 AND o.deleted_at IS NULL AND ${ON_SHIFT_SQL('o.id')} ORDER BY u.display_name`,
      [org],
    );
  }
}

class OrgQuery {
  @ApiPropertyOptional() @IsOptional() @IsUUID() orgId?: string;
}

@ApiTags('shifts')
@ApiBearerAuth()
@Controller('shifts')
export class ShiftsController {
  constructor(private readonly svc: ShiftsService) {}

  @Get()
  @RequirePermissions(Permission.SHIFT_READ)
  list(@CurrentUser() u: AuthUser, @Query() q: OrgQuery) {
    return this.svc.list(u, q.orgId);
  }

  @Get('on-duty')
  @RequirePermissions(Permission.SHIFT_READ)
  @ApiOperation({ summary: 'Operators on an active shift right now' })
  onDuty(@CurrentUser() u: AuthUser, @Query() q: OrgQuery) {
    return this.svc.onDuty(u, q.orgId);
  }

  @Post()
  @RequirePermissions(Permission.SHIFT_MANAGE)
  create(@CurrentUser() u: AuthUser, @Body() dto: ShiftDto, @Req() req: Request) {
    return this.svc.create(u, dto, req);
  }

  @Put(':id')
  @RequirePermissions(Permission.SHIFT_MANAGE)
  update(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ShiftDto, @Req() req: Request) {
    return this.svc.update(u, id, dto, req);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermissions(Permission.SHIFT_MANAGE)
  remove(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.svc.remove(u, id, req);
  }

  @Put(':id/members')
  @RequirePermissions(Permission.SHIFT_MANAGE)
  @ApiOperation({ summary: 'Replace the operators assigned to a shift' })
  members(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ShiftMembersDto, @Req() req: Request) {
    return this.svc.setMembers(u, id, dto, req);
  }
}

@Module({ providers: [ShiftsService], controllers: [ShiftsController] })
export class ShiftsModule {}
