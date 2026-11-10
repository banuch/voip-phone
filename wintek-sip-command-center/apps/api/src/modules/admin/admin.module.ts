import { BadRequestException, Body, Controller, ForbiddenException, Get, Injectable, Module, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsEmail, IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';
import type { Request } from 'express';
import { Permission, Role, ROLE_LABEL, ROLE_PERMISSIONS } from '@wintek/shared';
import { CurrentUser, RequirePermissions } from '../../common/auth/decorators';
import type { AuthUser } from '../../common/auth/auth-user';
import { scopeOrg, scopeOrgOrAll } from '../../common/auth/tenant';
import { DatabaseService, isUniqueViolation } from '../../common/db/database.service';
import { conflict, notFound } from '../../common/http/errors';
import { AuditService } from '../audit/audit.service';
import { hashPassword, passwordPolicyError } from '../auth/password';
import { config } from '../../config';

const ROLES = Object.values(Role);

class OrgDto {
  @ApiProperty() @Matches(/^[A-Za-z0-9_-]{2,30}$/) code: string;
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(120) name: string;
  @ApiPropertyOptional({ example: 'Asia/Kolkata' }) @IsOptional() @IsString() timezone?: string;
}
class OrgPatchDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(2) @MaxLength(120) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() timezone?: string;
  @ApiPropertyOptional({ enum: ['ACTIVE', 'SUSPENDED'] }) @IsOptional() @IsIn(['ACTIVE', 'SUSPENDED']) status?: string;
}
class UserDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() orgId?: string;
  @ApiProperty() @Matches(/^[a-z0-9._-]{3,40}$/i) username: string;
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(120) displayName: string;
  @ApiPropertyOptional() @IsOptional() @IsEmail() email?: string;
  @ApiProperty() @IsString() password: string;
  @ApiProperty({ enum: ROLES, isArray: true }) @IsArray() @ArrayMinSize(1) @ArrayMaxSize(5) @IsIn(ROLES, { each: true }) roles: Role[];
}
class UserPatchDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(2) @MaxLength(120) displayName?: string;
  @ApiPropertyOptional({ enum: ['ACTIVE', 'LOCKED', 'DISABLED'] }) @IsOptional() @IsIn(['ACTIVE', 'LOCKED', 'DISABLED']) status?: string;
  @ApiPropertyOptional({ enum: ROLES, isArray: true }) @IsOptional() @IsArray() @ArrayMinSize(1) @IsIn(ROLES, { each: true }) roles?: Role[];
  @ApiPropertyOptional({ description: 'Set a new password (admin reset)' }) @IsOptional() @IsString() password?: string;
}
class CodeNameDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() orgId?: string;
  @ApiProperty() @Matches(/^[A-Za-z0-9_-]{1,30}$/) code: string;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(120) name: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) description?: string;
}
class SettingDto {
  @ApiPropertyOptional({ description: 'Omit for platform default (super admin only)' }) @IsOptional() @IsUUID() orgId?: string;
  @ApiProperty() value: unknown;
}
class OrgQuery {
  @ApiPropertyOptional() @IsOptional() @IsUUID() orgId?: string;
}

/** Settings an administrator may change, with validators. Unknown keys are refused. */
const SETTINGS: Record<string, (v: unknown) => boolean> = {
  'calls.maxDurationMinutes': (v) => Number.isInteger(v) && (v as number) >= 5 && (v as number) <= 240,
  'calls.confirmHangupWhenConnected': (v) => typeof v === 'boolean',
  'queue.offerTtlSeconds': (v) => Number.isInteger(v) && (v as number) >= 10 && (v as number) <= 120,
  'vms.defaultDeepLinkTemplate': (v) => typeof v === 'string' && v.length < 500 && /^https?:\/\//.test(v as string),
  'ui.staleAfterSeconds': (v) => Number.isInteger(v) && (v as number) >= 5 && (v as number) <= 120,
  'security.sessionIdleMinutes': (v) => Number.isInteger(v) && (v as number) >= 5 && (v as number) <= 720,
};

@Injectable()
export class AdminService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  orgs(user: AuthUser) {
    const org = scopeOrgOrAll(user);
    return this.db.query(
      `SELECT o.id, o.code, o.name, o.timezone, o.status, o.created_at AS "createdAt",
              (SELECT count(*) FROM atm_devices d WHERE d.organization_id = o.id AND d.deleted_at IS NULL)::int AS "atmCount",
              (SELECT count(*) FROM operators p WHERE p.organization_id = o.id AND p.deleted_at IS NULL)::int AS "operatorCount"
         FROM organizations o WHERE o.deleted_at IS NULL ${org ? 'AND o.id = $1' : ''} ORDER BY o.name`,
      org ? [org] : [],
    );
  }

  async createOrg(user: AuthUser, dto: OrgDto, req: Request) {
    try {
      return await this.db.tx(async (c) => {
        const r = await c.query(`INSERT INTO organizations (code, name, timezone) VALUES ($1,$2,coalesce($3,'UTC')) RETURNING id`, [dto.code, dto.name, dto.timezone ?? null]);
        await c.query(`INSERT INTO routing_policies (organization_id, scope) VALUES ($1, 'ORGANIZATION')`, [r.rows[0].id]);
        await this.audit.record({ actor: user, organizationId: r.rows[0].id, action: 'org.created', entityType: 'organization', entityId: r.rows[0].id, detail: { ...dto }, req }, c);
        return { id: r.rows[0].id };
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('ORG_EXISTS', 'Organization code already exists');
      throw e;
    }
  }

  async patchOrg(user: AuthUser, id: string, dto: OrgPatchDto, req: Request) {
    const r = await this.db.tx(async (c) => {
      const u = await c.query(
        `UPDATE organizations SET name = coalesce($2, name), timezone = coalesce($3, timezone), status = coalesce($4, status)
          WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
        [id, dto.name ?? null, dto.timezone ?? null, dto.status ?? null],
      );
      if (!u.rowCount) throw notFound('Organization');
      await this.audit.record({ actor: user, organizationId: id, action: 'org.updated', entityType: 'organization', entityId: id, detail: { ...dto }, req }, c);
      return { id };
    });
    return r;
  }

  users(user: AuthUser, orgId?: string) {
    const org = scopeOrgOrAll(user, orgId);
    return this.db.query(
      `SELECT u.id, u.username, u.display_name AS "displayName", u.email, u.status, u.organization_id AS "organizationId",
              u.last_login_at AS "lastLoginAt", u.failed_logins AS "failedLogins", u.locked_until AS "lockedUntil",
              coalesce(array_agg(ur.role_code) FILTER (WHERE ur.role_code IS NOT NULL), '{}') AS roles,
              (SELECT id FROM operators o WHERE o.user_id = u.id) AS "operatorId"
         FROM users u LEFT JOIN user_roles ur ON ur.user_id = u.id
        WHERE u.deleted_at IS NULL ${org ? 'AND u.organization_id = $1' : ''}
        GROUP BY u.id ORDER BY u.display_name LIMIT 2000`,
      org ? [org] : [],
    );
  }

  /** Nobody can grant a role with permissions they don't hold themselves (no privilege escalation). */
  private assertCanGrant(user: AuthUser, roles: Role[]) {
    for (const r of roles) {
      const missing = ROLE_PERMISSIONS[r].filter((p) => !user.permissions.has(p));
      if (missing.length) throw new ForbiddenException({ code: 'ROLE_ESCALATION', message: `You cannot grant ${r}`, missing });
    }
    if (roles.includes(Role.SUPER_ADMIN) && !user.permissions.has(Permission.CROSS_TENANT)) throw new ForbiddenException({ code: 'ROLE_ESCALATION', message: 'Only super admins can grant SUPER_ADMIN' });
  }

  async createUser(user: AuthUser, dto: UserDto, req: Request) {
    this.assertCanGrant(user, dto.roles);
    const err = passwordPolicyError(dto.password);
    if (err) throw new BadRequestException({ code: 'WEAK_PASSWORD', message: err });
    const org = dto.roles.includes(Role.SUPER_ADMIN) ? null : scopeOrg(user, dto.orgId);
    const hash = await hashPassword(dto.password);
    try {
      return await this.db.tx(async (c) => {
        const r = await c.query(`INSERT INTO users (organization_id, username, display_name, email, password_hash) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [
          org, dto.username, dto.displayName, dto.email ?? null, hash,
        ]);
        const id = r.rows[0].id;
        await c.query(`INSERT INTO user_roles (user_id, role_code, granted_by) SELECT $1, unnest($2::text[]), $3`, [id, dto.roles, user.userId]);
        await this.audit.record({ actor: user, organizationId: org, action: 'user.created', entityType: 'user', entityId: id, detail: { username: dto.username, roles: dto.roles }, req }, c);
        return { id };
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('USERNAME_EXISTS', 'Username already exists');
      throw e;
    }
  }

  async patchUser(user: AuthUser, id: string, dto: UserPatchDto, req: Request) {
    const target = await this.db.one(`SELECT id, organization_id FROM users WHERE id = $1 AND deleted_at IS NULL`, [id]);
    if (!target || (user.organizationId && target.organization_id !== user.organizationId)) throw notFound('User');
    if (id === user.userId && (dto.roles || dto.status)) throw new ForbiddenException({ code: 'SELF_CHANGE', message: 'You cannot change your own roles or status' });
    if (dto.roles) this.assertCanGrant(user, dto.roles);
    const hash = dto.password ? (passwordPolicyError(dto.password) ? null : await hashPassword(dto.password)) : undefined;
    if (dto.password && !hash) throw new BadRequestException({ code: 'WEAK_PASSWORD', message: passwordPolicyError(dto.password)! });
    await this.db.tx(async (c) => {
      await c.query(
        `UPDATE users SET display_name = coalesce($2, display_name), status = coalesce($3, status),
                password_hash = coalesce($4, password_hash), password_changed_at = CASE WHEN $4::text IS NULL THEN password_changed_at ELSE now() END,
                failed_logins = CASE WHEN $3 = 'ACTIVE' THEN 0 ELSE failed_logins END,
                locked_until = CASE WHEN $3 = 'ACTIVE' THEN NULL ELSE locked_until END
          WHERE id = $1`,
        [id, dto.displayName ?? null, dto.status ?? null, hash ?? null],
      );
      if (dto.roles) {
        const prev = await c.query(`SELECT array_agg(role_code) AS roles FROM user_roles WHERE user_id = $1`, [id]);
        await c.query(`DELETE FROM user_roles WHERE user_id = $1`, [id]);
        await c.query(`INSERT INTO user_roles (user_id, role_code, granted_by) SELECT $1, unnest($2::text[]), $3`, [id, dto.roles, user.userId]);
        await this.audit.record({ actor: user, organizationId: target.organization_id, action: 'user.roles.changed', entityType: 'user', entityId: id, detail: { from: prev.rows[0].roles, to: dto.roles }, req }, c);
      }
      // Any security-relevant change ends the user's sessions.
      if (dto.status && dto.status !== 'ACTIVE') await c.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [id]);
      if (hash || dto.roles) await c.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [id]);
      await this.audit.record(
        { actor: user, organizationId: target.organization_id, action: dto.password ? 'user.password.reset' : 'user.updated', entityType: 'user', entityId: id, detail: { displayName: dto.displayName, status: dto.status }, req },
        c,
      );
    });
    return { id };
  }

  async createCodeName(user: AuthUser, table: 'regions' | 'atm_groups', dto: CodeNameDto, req: Request) {
    const org = scopeOrg(user, dto.orgId);
    try {
      return await this.db.tx(async (c) => {
        const r =
          table === 'regions'
            ? await c.query(`INSERT INTO regions (organization_id, code, name) VALUES ($1,$2,$3) RETURNING id`, [org, dto.code, dto.name])
            : await c.query(`INSERT INTO atm_groups (organization_id, code, name, description) VALUES ($1,$2,$3,$4) RETURNING id`, [org, dto.code, dto.name, dto.description ?? null]);
        const kind = table === 'regions' ? 'region' : 'group';
        await this.audit.record({ actor: user, organizationId: org, action: `${kind}.created`, entityType: kind, entityId: r.rows[0].id, detail: { ...dto }, req }, c);
        return { id: r.rows[0].id };
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('CODE_EXISTS', `${dto.code} already exists`);
      throw e;
    }
  }

  async settings(user: AuthUser, orgId?: string) {
    const org = scopeOrgOrAll(user, orgId) ?? user.organizationId;
    const rows = await this.db.query(
      `SELECT DISTINCT ON (key) key, value, organization_id AS "organizationId", updated_at AS "updatedAt"
         FROM system_settings WHERE organization_id IS NULL OR organization_id = $1
        ORDER BY key, organization_id NULLS LAST`,
      [org],
    );
    return {
      keys: Object.keys(SETTINGS),
      values: rows,
      // Read-only deployment facts the UI may show; never secrets.
      deployment: { sipDriver: config().SIP_DRIVER, sipDomain: config().SIP_DOMAIN, atmDialMode: config().ATM_DIAL_MODE, webrtcWssUrl: config().WEBRTC_WSS_URL, nodeId: config().NODE_ID },
    };
  }

  async putSetting(user: AuthUser, key: string, dto: SettingDto, req: Request) {
    const check = SETTINGS[key];
    if (!check) throw new BadRequestException({ code: 'UNKNOWN_SETTING', message: `Unknown setting ${key}` });
    if (!check(dto.value)) throw new BadRequestException({ code: 'INVALID_SETTING', message: `Invalid value for ${key}` });
    const platform = !dto.orgId && user.permissions.has(Permission.CROSS_TENANT);
    const org = platform ? null : scopeOrg(user, dto.orgId);
    await this.db.tx(async (c) => {
      await c.query(
        `INSERT INTO system_settings (organization_id, key, value, updated_by) VALUES ($1,$2,$3,$4)
         ON CONFLICT (coalesce(organization_id, '00000000-0000-0000-0000-000000000000'::uuid), key)
         DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by`,
        [org, key, JSON.stringify(dto.value), user.userId],
      );
      await this.audit.record({ actor: user, organizationId: org, action: 'system.setting.changed', entityType: 'setting', entityId: key, detail: { value: dto.value }, req }, c);
    });
    return { key, value: dto.value, organizationId: org };
  }
}

@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin')
export class AdminController {
  constructor(private readonly svc: AdminService) {}

  @Get('roles')
  @RequirePermissions(Permission.USER_READ)
  @ApiOperation({ summary: 'Roles and their permissions' })
  roles() {
    return ROLES.map((r) => ({ code: r, name: ROLE_LABEL[r], permissions: ROLE_PERMISSIONS[r] }));
  }

  @Get('organizations')
  @RequirePermissions(Permission.ORG_READ)
  orgs(@CurrentUser() u: AuthUser) {
    return this.svc.orgs(u);
  }

  @Post('organizations')
  @RequirePermissions(Permission.ORG_MANAGE)
  createOrg(@CurrentUser() u: AuthUser, @Body() dto: OrgDto, @Req() req: Request) {
    return this.svc.createOrg(u, dto, req);
  }

  @Patch('organizations/:id')
  @RequirePermissions(Permission.ORG_MANAGE)
  patchOrg(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: OrgPatchDto, @Req() req: Request) {
    return this.svc.patchOrg(u, id, dto, req);
  }

  @Get('users')
  @RequirePermissions(Permission.USER_READ)
  users(@CurrentUser() u: AuthUser, @Query() q: OrgQuery) {
    return this.svc.users(u, q.orgId);
  }

  @Post('users')
  @RequirePermissions(Permission.USER_MANAGE)
  createUser(@CurrentUser() u: AuthUser, @Body() dto: UserDto, @Req() req: Request) {
    return this.svc.createUser(u, dto, req);
  }

  @Patch('users/:id')
  @RequirePermissions(Permission.USER_MANAGE)
  @ApiOperation({ summary: 'Update user; role/password/status changes revoke the user\'s sessions' })
  patchUser(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UserPatchDto, @Req() req: Request) {
    return this.svc.patchUser(u, id, dto, req);
  }

  @Post('regions')
  @RequirePermissions(Permission.ATM_MANAGE)
  createRegion(@CurrentUser() u: AuthUser, @Body() dto: CodeNameDto, @Req() req: Request) {
    return this.svc.createCodeName(u, 'regions', dto, req);
  }

  @Post('groups')
  @RequirePermissions(Permission.ATM_MANAGE)
  createGroup(@CurrentUser() u: AuthUser, @Body() dto: CodeNameDto, @Req() req: Request) {
    return this.svc.createCodeName(u, 'atm_groups', dto, req);
  }

  @Get('settings')
  @RequirePermissions(Permission.SYSTEM_READ)
  settings(@CurrentUser() u: AuthUser, @Query() q: OrgQuery) {
    return this.svc.settings(u, q.orgId);
  }

  @Put('settings/:key')
  @RequirePermissions(Permission.SYSTEM_MANAGE)
  putSetting(@CurrentUser() u: AuthUser, @Param('key') key: string, @Body() dto: SettingDto, @Req() req: Request) {
    return this.svc.putSetting(u, key, dto, req);
  }
}

@Module({ providers: [AdminService], controllers: [AdminController] })
export class AdminModule {}
