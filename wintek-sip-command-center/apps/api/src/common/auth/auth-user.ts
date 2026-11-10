import type { Permission, Role } from '@wintek/shared';

export interface AuthUser {
  userId: string;
  username: string;
  /** null for platform super administrators */
  organizationId: string | null;
  roles: Role[];
  permissions: Set<Permission>;
  operatorId: string | null;
}

export interface AccessTokenClaims {
  sub: string;
  usr: string;
  org: string | null;
  roles: Role[];
  op: string | null;
  typ: 'access';
}
