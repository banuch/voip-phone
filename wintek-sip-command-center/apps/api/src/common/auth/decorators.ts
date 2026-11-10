import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Permission } from '@wintek/shared';
import type { AuthUser } from './auth-user';

export const PERMISSIONS_KEY = 'wintek:permissions';
export const PUBLIC_KEY = 'wintek:public';

/** Every listed permission is required. Enforced by PermissionsGuard. */
export const RequirePermissions = (...p: Permission[]) => SetMetadata(PERMISSIONS_KEY, p);
/** Skip authentication (login, refresh, health, internal webhooks with their own auth). */
export const Public = () => SetMetadata(PUBLIC_KEY, true);

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => {
  return ctx.switchToHttp().getRequest().user;
});
