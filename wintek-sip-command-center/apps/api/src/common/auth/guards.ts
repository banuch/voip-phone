import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { permissionsForRoles, type Permission } from '@wintek/shared';
import type { AccessTokenClaims, AuthUser } from './auth-user';
import { PERMISSIONS_KEY, PUBLIC_KEY } from './decorators';
import { AuditService } from '../../modules/audit/audit.service';

export function userFromClaims(c: AccessTokenClaims): AuthUser {
  return {
    userId: c.sub,
    username: c.usr,
    organizationId: c.org,
    roles: c.roles,
    permissions: permissionsForRoles(c.roles),
    operatorId: c.op,
  };
}

/** Global: every route needs a valid access token unless marked @Public(). */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [ctx.getHandler(), ctx.getClass()])) return true;
    const req = ctx.switchToHttp().getRequest();
    const h: string | undefined = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) throw new UnauthorizedException({ code: 'AUTH_REQUIRED', message: 'Missing bearer token' });
    try {
      const claims = await this.jwt.verifyAsync<AccessTokenClaims>(h.slice(7), { algorithms: ['HS256'] });
      if (claims.typ !== 'access') throw new Error('wrong token type');
      req.user = userFromClaims(claims);
      return true;
    } catch {
      throw new UnauthorizedException({ code: 'TOKEN_INVALID', message: 'Invalid or expired token' });
    }
  }
}

/** Global: enforces @RequirePermissions on the server side, and audits denials. */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const needed = this.reflector.getAllAndOverride<Permission[]>(PERMISSIONS_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (!needed?.length) return true;
    const req = ctx.switchToHttp().getRequest();
    const user: AuthUser | undefined = req.user;
    if (!user) throw new UnauthorizedException();
    const missing = needed.filter((p) => !user.permissions.has(p));
    if (missing.length) {
      await this.audit.record({
        actor: user,
        action: 'authz.denied',
        outcome: 'DENIED',
        entityType: 'route',
        entityId: `${req.method} ${req.route?.path ?? req.url}`,
        detail: { missing },
        req,
      });
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Insufficient permissions', missing });
    }
    return true;
  }
}
