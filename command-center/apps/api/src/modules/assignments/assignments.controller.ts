import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';
import type { Request } from 'express';
import { Permission } from '@wintek/shared';
import { CurrentUser, RequirePermissions } from '../../common/auth/decorators';
import type { AuthUser } from '../../common/auth/auth-user';
import { AssignmentsService } from './assignments.service';

class AssignmentQuery {
  @ApiPropertyOptional() @IsOptional() @IsUUID() atmId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() operatorId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() orgId?: string;
}

class SetAssignmentDto {
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID() primaryOperatorId?: string | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID() backupOperatorId?: string | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID() shiftId?: string | null;
  @ApiPropertyOptional({ description: 'Version you edited; a mismatch returns 409 STALE_VERSION' }) @IsOptional() @IsInt() expectedVersion?: number;
}

class OverrideQuery {
  @ApiPropertyOptional() @IsOptional() @IsUUID() atmId?: string;
  @ApiPropertyOptional({ default: true }) @IsOptional() @Transform(({ value }) => value !== 'false' && value !== false) @IsBoolean() activeOnly?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsUUID() orgId?: string;
}

class CreateOverrideDto {
  @ApiProperty() @IsUUID() atmId: string;
  @ApiProperty() @IsUUID() operatorId: string;
  @ApiProperty({ minLength: 5 }) @IsString() @MinLength(5) @MaxLength(500) reason: string;
  @ApiPropertyOptional({ description: 'Defaults to now' }) @IsOptional() @IsISO8601() startsAt?: string;
  @ApiProperty({ description: 'At most 7 days after startsAt' }) @IsISO8601() endsAt: string;
}

class RoutingPolicyDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() orgId?: string;
  @ApiProperty({ enum: ['ORGANIZATION', 'REGION', 'GROUP'] }) @IsIn(['ORGANIZATION', 'REGION', 'GROUP']) scope: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() scopeId?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() allowDynamic?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() requireActiveShift?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() sameRegionOnly?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() preferGroupMatch?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() allowQueueWhenBusy?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(10) @Max(3600) queueTimeoutSeconds?: number;
}

@ApiTags('assignments')
@ApiBearerAuth()
@Controller()
export class AssignmentsController {
  constructor(private readonly svc: AssignmentsService) {}

  @Get('assignments')
  @RequirePermissions(Permission.ASSIGNMENT_READ)
  @ApiOperation({ summary: 'Static ATM assignments (primary/backup/shift)' })
  list(@CurrentUser() u: AuthUser, @Query() q: AssignmentQuery) {
    return this.svc.list(u, q);
  }

  @Put('assignments/:atmId')
  @RequirePermissions(Permission.ASSIGNMENT_MANAGE)
  @ApiOperation({ summary: 'Set primary/backup operator and shift for an ATM (optimistic concurrency)' })
  set(@CurrentUser() u: AuthUser, @Param('atmId', ParseUUIDPipe) atmId: string, @Body() dto: SetAssignmentDto, @Req() req: Request) {
    return this.svc.setStatic(u, atmId, dto, req);
  }

  @Get('assignments/:atmId/resolve')
  @RequirePermissions(Permission.ASSIGNMENT_READ)
  @ApiOperation({ summary: 'Run the routing precedence now and return the decision with its full trace' })
  resolve(@CurrentUser() u: AuthUser, @Param('atmId', ParseUUIDPipe) atmId: string) {
    return this.svc.resolveForUser(u, atmId);
  }

  @Get('assignment-overrides')
  @RequirePermissions(Permission.ASSIGNMENT_READ)
  overrides(@CurrentUser() u: AuthUser, @Query() q: OverrideQuery) {
    return this.svc.listOverrides(u, q);
  }

  @Post('assignment-overrides')
  @RequirePermissions(Permission.ASSIGNMENT_OVERRIDE)
  @ApiOperation({ summary: 'Supervisor temporary override (reason + expiry required; audited; overlapping overrides are rejected)' })
  createOverride(@CurrentUser() u: AuthUser, @Body() dto: CreateOverrideDto, @Req() req: Request) {
    return this.svc.createOverride(u, dto, req);
  }

  @Delete('assignment-overrides/:id')
  @HttpCode(204)
  @RequirePermissions(Permission.ASSIGNMENT_OVERRIDE)
  revoke(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.svc.revokeOverride(u, id, req);
  }

  @Get('routing-policies')
  @RequirePermissions(Permission.ASSIGNMENT_READ)
  policies(@CurrentUser() u: AuthUser, @Query() q: AssignmentQuery) {
    return this.svc.listPolicies(u, q.orgId);
  }

  @Put('routing-policies')
  @RequirePermissions(Permission.ROUTING_MANAGE)
  @ApiOperation({ summary: 'Create or update the routing policy for an organization, region or group' })
  upsertPolicy(@CurrentUser() u: AuthUser, @Body() dto: RoutingPolicyDto, @Req() req: Request) {
    return this.svc.upsertPolicy(u, dto, req);
  }
}
