import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsIn, IsISO8601, IsOptional, IsString } from 'class-validator';
import { Permission } from '@wintek/shared';
import { CurrentUser, RequirePermissions } from '../../common/auth/decorators';
import type { AuthUser } from '../../common/auth/auth-user';
import { scopeOrgOrAll } from '../../common/auth/tenant';
import { DatabaseService } from '../../common/db/database.service';
import { PageQuery, offset, type Page } from '../../common/http/pagination';
import { SqlWhere } from '../../common/db/sql-where';

class AuditQuery extends PageQuery {
  @ApiPropertyOptional({ description: 'Action prefix, e.g. "call." or "auth.login"' }) @IsOptional() @IsString() action?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() entityType?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() entityId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() actor?: string;
  @ApiPropertyOptional({ enum: ['SUCCESS', 'FAILURE', 'DENIED'] }) @IsOptional() @IsIn(['SUCCESS', 'FAILURE', 'DENIED']) outcome?: string;
  @ApiPropertyOptional() @IsOptional() @IsISO8601() from?: string;
  @ApiPropertyOptional() @IsOptional() @IsISO8601() to?: string;
}

@ApiTags('audit')
@ApiBearerAuth()
@Controller('audit')
export class AuditController {
  constructor(private readonly db: DatabaseService) {}

  @Get()
  @RequirePermissions(Permission.AUDIT_READ)
  @ApiOperation({ summary: 'Search audit logs (organization-scoped, newest first)' })
  async list(@CurrentUser() user: AuthUser, @Query() q: AuditQuery): Promise<Page<unknown>> {
    const org = scopeOrgOrAll(user, q.orgId);
    const w = new SqlWhere();
    if (org) w.add('organization_id = ?', org);
    if (q.action) w.add('action LIKE ?', `${q.action.replace(/[%_\\]/g, '')}%`);
    if (q.entityType) w.add('entity_type = ?', q.entityType);
    if (q.entityId) w.add('entity_id = ?', q.entityId);
    if (q.actor) w.add('actor_username = ?', q.actor);
    if (q.outcome) w.add('outcome = ?', q.outcome);
    if (q.from) w.add('occurred_at >= ?', q.from);
    if (q.to) w.add('occurred_at < ?', q.to);
    const [items, total] = await Promise.all([
      this.db.query(
        `SELECT id::text, organization_id AS "organizationId", actor_user_id AS "actorUserId", actor_username AS "actorUsername",
                action, entity_type AS "entityType", entity_id AS "entityId", outcome, host(ip) AS ip,
                correlation_id AS "correlationId", detail, occurred_at AS "occurredAt"
           FROM audit_logs ${w.sql} ORDER BY occurred_at DESC, id DESC LIMIT ${q.pageSize} OFFSET ${offset(q)}`,
        w.params,
      ),
      this.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM audit_logs ${w.sql}`, w.params),
    ]);
    return { items, total: total?.n ?? 0, page: q.page, pageSize: q.pageSize };
  }
}
