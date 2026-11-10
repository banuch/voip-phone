import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Permission } from '@wintek/shared';
import type { AuthUser } from './auth-user';

/**
 * Resolve the organization a request acts on. Non-super-admins are always
 * pinned to their own organization; a requested other org is refused rather
 * than silently ignored, so misuse shows up in logs.
 */
export function scopeOrg(user: AuthUser, requested?: string | null): string {
  if (user.permissions.has(Permission.CROSS_TENANT)) {
    const org = requested ?? user.organizationId;
    if (!org) throw new BadRequestException({ code: 'ORG_REQUIRED', message: 'orgId query parameter is required' });
    return org;
  }
  if (!user.organizationId) throw new ForbiddenException({ code: 'NO_ORG', message: 'User has no organization' });
  if (requested && requested !== user.organizationId) {
    throw new ForbiddenException({ code: 'CROSS_TENANT', message: 'Access to another organization is not allowed' });
  }
  return user.organizationId;
}

/** For list endpoints: super admin without orgId sees all orgs (null). */
export function scopeOrgOrAll(user: AuthUser, requested?: string | null): string | null {
  if (user.permissions.has(Permission.CROSS_TENANT)) return requested ?? null;
  return scopeOrg(user, requested);
}
