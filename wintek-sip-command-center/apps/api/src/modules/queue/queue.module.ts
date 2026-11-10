import { Body, Controller, Delete, Get, HttpCode, Module, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import type { Request } from 'express';
import { Permission, Priority } from '@wintek/shared';
import { CurrentUser, RequirePermissions } from '../../common/auth/decorators';
import type { AuthUser } from '../../common/auth/auth-user';
import { AssignmentsModule } from '../assignments/assignments.module';
import { QueueService } from './queue.service';

class QueueQuery {
  @ApiPropertyOptional() @IsOptional() @IsUUID() orgId?: string;
  @ApiPropertyOptional({ description: 'Include requests closed in the last 24 h' })
  @IsOptional() @Transform(({ value }) => value === 'true' || value === true) @IsBoolean() includeClosed?: boolean;
}

class CreateQueueDto {
  @ApiProperty() @IsUUID() atmId: string;
  @ApiProperty({ enum: Object.values(Priority) }) @IsIn(Object.values(Priority)) priority: Priority;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) reason?: string;
  @ApiPropertyOptional({ description: 'External incident id, e.g. from the VMS' }) @IsOptional() @IsString() @MaxLength(120) externalRef?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() preferredOperatorId?: string;
}

@ApiTags('queue')
@ApiBearerAuth()
@Controller('queue')
export class QueueController {
  constructor(private readonly queue: QueueService) {}

  @Get()
  @RequirePermissions(Permission.QUEUE_READ)
  @ApiOperation({ summary: 'Open call requests in dispatch order (with position), optionally recent closed ones' })
  list(@CurrentUser() u: AuthUser, @Query() q: QueueQuery) {
    return this.queue.list(u, q);
  }

  @Post()
  @RequirePermissions(Permission.QUEUE_MANAGE)
  @ApiOperation({ summary: 'Supervisor/integration call request for an ATM; routed to an eligible operator who places the call' })
  create(@CurrentUser() u: AuthUser, @Body() dto: CreateQueueDto, @Req() req: Request) {
    return this.queue.create(u, dto, req);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermissions(Permission.QUEUE_READ)
  @ApiOperation({ summary: 'Cancel a request (requester or supervisor)' })
  cancel(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.queue.cancel(u, id, req);
  }

  @Post(':id/decline')
  @HttpCode(204)
  @RequirePermissions(Permission.CALL_INITIATE)
  @ApiOperation({ summary: 'Decline a request offered to you; it is re-routed to someone else' })
  decline(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.queue.decline(u, id, req);
  }
}

@Module({ imports: [AssignmentsModule], providers: [QueueService], controllers: [QueueController], exports: [QueueService] })
export class QueueModule {}
