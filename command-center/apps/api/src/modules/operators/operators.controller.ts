import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { Permission } from '@wintek/shared';
import { CurrentUser, RequirePermissions } from '../../common/auth/decorators';
import type { AuthUser } from '../../common/auth/auth-user';
import { OperatorsService } from './operators.service';
import { PresenceService } from './presence.service';
import { CreateOperatorDto, HeartbeatDto, OperatorListQuery, SetPresenceDto, UpdateOperatorDto } from './operators.dto';

@ApiTags('operators')
@ApiBearerAuth()
@Controller('operators')
export class OperatorsController {
  constructor(
    private readonly operators: OperatorsService,
    private readonly presence: PresenceService,
  ) {}

  @Get()
  @RequirePermissions(Permission.OPERATOR_READ)
  @ApiOperation({ summary: 'List operators with live availability, current call and assignment counts' })
  list(@CurrentUser() u: AuthUser, @Query() q: OperatorListQuery) {
    return this.operators.list(u, q);
  }

  @Get('me')
  @RequirePermissions(Permission.PRESENCE_SELF)
  @ApiOperation({ summary: 'Own operator profile' })
  me(@CurrentUser() u: AuthUser) {
    return this.operators.get(u, u.operatorId ?? '00000000-0000-0000-0000-000000000000');
  }

  @Put('me/presence')
  @RequirePermissions(Permission.PRESENCE_SELF)
  @ApiOperation({ summary: 'Set own availability (AVAILABLE, BREAK, UNAVAILABLE). BUSY/OFFLINE/FAULT are derived by the server.' })
  setPresence(@CurrentUser() u: AuthUser, @Body() dto: SetPresenceDto, @Req() req: Request) {
    return this.presence.setSelected(u, dto.availability, req);
  }

  @Post('me/heartbeat')
  @HttpCode(204)
  @RequirePermissions(Permission.PRESENCE_SELF)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Presence heartbeat (REST fallback; the WebSocket heartbeat is preferred)' })
  async heartbeat(@CurrentUser() u: AuthUser, @Body() dto: HeartbeatDto) {
    await this.presence.heartbeat(u, { sipRegistered: dto.sipRegistered, mediaFault: dto.mediaFault ?? false });
  }

  @Post('me/webrtc-credentials')
  @RequirePermissions(Permission.CALL_INITIATE)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Issue session-bound SIP/WebRTC credentials and ICE servers for the operator console' })
  webrtc(@CurrentUser() u: AuthUser, @Req() req: Request) {
    return this.operators.webrtcCredentials(u, req);
  }

  @Get(':id')
  @RequirePermissions(Permission.OPERATOR_READ)
  get(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.operators.get(u, id);
  }

  @Get(':id/assignments')
  @RequirePermissions(Permission.ASSIGNMENT_READ)
  @ApiOperation({ summary: 'Primary, backup and override assignments of an operator' })
  assignments(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.operators.assignments(u, id);
  }

  @Post()
  @RequirePermissions(Permission.OPERATOR_MANAGE)
  @ApiOperation({ summary: 'Create an operator account (user + operator + WebRTC SIP identity)' })
  create(@CurrentUser() u: AuthUser, @Body() dto: CreateOperatorDto, @Req() req: Request) {
    return this.operators.create(u, dto, req);
  }

  @Patch(':id')
  @RequirePermissions(Permission.OPERATOR_MANAGE)
  update(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateOperatorDto, @Req() req: Request) {
    return this.operators.update(u, id, dto, req);
  }
}
