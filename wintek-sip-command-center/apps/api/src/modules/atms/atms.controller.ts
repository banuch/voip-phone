import { Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req, UnauthorizedException } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { IsIn, IsInt, IsIP, IsOptional, IsString, MaxLength } from 'class-validator';
import type { Request } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { Permission } from '@wintek/shared';
import { CurrentUser, Public, RequirePermissions } from '../../common/auth/decorators';
import type { AuthUser } from '../../common/auth/auth-user';
import { PageQuery } from '../../common/http/pagination';
import { config } from '../../config';
import { AtmsService } from './atms.service';
import { DeviceStatusService } from './device-status.service';
import { AtmListQuery, BulkAtmDto, CreateAtmDto, ImportBody, ImportQuery, UpdateAtmDto } from './atms.dto';

@ApiTags('atms')
@ApiBearerAuth()
@Controller('atms')
export class AtmsController {
  constructor(private readonly atms: AtmsService) {}

  @Get()
  @RequirePermissions(Permission.ATM_READ)
  @ApiOperation({ summary: 'List ATMs with live registration, assignment, call and queue status' })
  list(@CurrentUser() u: AuthUser, @Query() q: AtmListQuery) {
    return this.atms.list(u, q);
  }

  @Get('regions')
  @RequirePermissions(Permission.ATM_READ)
  regions(@CurrentUser() u: AuthUser, @Query() q: PageQuery) {
    return this.atms.regions(u, q.orgId);
  }

  @Get('groups')
  @RequirePermissions(Permission.ATM_READ)
  groups(@CurrentUser() u: AuthUser, @Query() q: PageQuery) {
    return this.atms.groups(u, q.orgId);
  }

  @Get(':id')
  @RequirePermissions(Permission.ATM_READ)
  @ApiOperation({ summary: 'ATM detail: identity, SIP registration, assignments, call history metadata, faults, VMS link' })
  detail(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.atms.detail(u, id);
  }

  @Get(':id/status')
  @RequirePermissions(Permission.ATM_READ)
  @ApiOperation({ summary: 'Compact live status' })
  async status(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const a = await this.atms.get(u, id);
    return {
      atmId: a.id, registration: a.registrationStatus, health: a.health, status: a.status, lastSeenAt: a.lastSeenAt,
      activeCall: a.activeCallId ? { id: a.activeCallId, state: a.activeCallState, operatorName: a.activeCallOperatorName } : null,
      queued: a.queueItemId ? { id: a.queueItemId, priority: a.queuePriority } : null, version: a.version,
    };
  }

  @Post()
  @RequirePermissions(Permission.ATM_MANAGE, Permission.ATM_CREDENTIALS)
  @ApiOperation({ summary: 'Add an ATM; returns SIP credentials ONCE when provisionSip is true' })
  create(@CurrentUser() u: AuthUser, @Body() dto: CreateAtmDto, @Req() req: Request) {
    return this.atms.create(u, dto, req);
  }

  @Patch(':id')
  @RequirePermissions(Permission.ATM_MANAGE)
  update(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateAtmDto, @Req() req: Request) {
    return this.atms.update(u, id, dto, req);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermissions(Permission.ATM_MANAGE)
  @ApiOperation({ summary: 'Soft-delete an ATM and disable its SIP identity' })
  remove(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.atms.remove(u, id, req);
  }

  @Post(':id/credentials/rotate')
  @RequirePermissions(Permission.ATM_CREDENTIALS)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'Rotate the SIP password; the new password is returned once' })
  rotate(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.atms.rotateCredentials(u, id, req);
  }

  @Post('bulk')
  @RequirePermissions(Permission.ATM_MANAGE)
  @ApiOperation({ summary: 'Bulk region/group/status/assignment changes (all-or-nothing)' })
  bulk(@CurrentUser() u: AuthUser, @Body() dto: BulkAtmDto, @Req() req: Request) {
    return this.atms.bulk(u, dto, req);
  }

  @Post('import')
  @RequirePermissions(Permission.ATM_MANAGE, Permission.ATM_CREDENTIALS)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Import/update ATMs from CSV; dryRun=true validates only' })
  import(@CurrentUser() u: AuthUser, @Query() q: ImportQuery, @Body() body: ImportBody, @Req() req: Request) {
    return this.atms.importCsv(u, body.csv, { dryRun: q.dryRun, provisionSip: body.provisionSip, orgId: q.orgId }, req);
  }
}

class RegistrationWebhookDto {
  @ApiProperty() @IsString() @MaxLength(80) username: string;
  @ApiProperty({ enum: ['REGISTERED', 'UNREGISTERED', 'EXPIRED'] }) @IsIn(['REGISTERED', 'UNREGISTERED', 'EXPIRED']) state: 'REGISTERED' | 'UNREGISTERED' | 'EXPIRED';
  @ApiPropertyOptional() @IsOptional() @IsIP() contactIp?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() contactPort?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) userAgent?: string;
}

/**
 * Registrar -> API webhook (Kamailio usrloc events in stage 2). Authenticated
 * with a shared secret header, not a user token. Keep it on the internal
 * network only; the reverse proxy blocks /api/v1/internal from outside.
 */
@ApiTags('internal')
// One registrar node sends ~67 req/s at 20,000 devices from a single IP: the
// per-IP user rate limit must not apply. Protected by the shared secret and
// by network policy (reverse proxy blocks /api/v1/internal).
@SkipThrottle()
@Controller('internal/sip')
export class InternalSipController {
  constructor(private readonly status: DeviceStatusService) {}

  @Public()
  @Post('registrations')
  @HttpCode(204)
  @ApiExcludeEndpoint()
  async registration(@Headers('x-wintek-internal-secret') secret: string | undefined, @Body() dto: RegistrationWebhookDto) {
    const expected = Buffer.from(config().INTERNAL_WEBHOOK_SECRET);
    const got = Buffer.from(secret ?? '');
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) throw new UnauthorizedException();
    await this.status.applyRegistration({
      sipUsername: dto.username, state: dto.state, contactIp: dto.contactIp, contactPort: dto.contactPort, userAgent: dto.userAgent, source: 'kamailio',
    });
  }
}
