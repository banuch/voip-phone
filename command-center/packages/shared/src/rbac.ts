export const Role = {
  SUPER_ADMIN: 'SUPER_ADMIN',
  ORG_ADMIN: 'ORG_ADMIN',
  SUPERVISOR: 'SUPERVISOR',
  OPERATOR: 'OPERATOR',
  AUDITOR: 'AUDITOR',
} as const;
export type Role = (typeof Role)[keyof typeof Role];

export const ROLE_LABEL: Record<Role, string> = {
  SUPER_ADMIN: 'Super Administrator',
  ORG_ADMIN: 'Organization Administrator',
  SUPERVISOR: 'Supervisor',
  OPERATOR: 'Operator',
  AUDITOR: 'Read-Only Auditor',
};

export const Permission = {
  ORG_MANAGE: 'org:manage',
  ORG_READ: 'org:read',
  USER_MANAGE: 'user:manage',
  USER_READ: 'user:read',
  ROLE_MANAGE: 'role:manage',
  ATM_READ: 'atm:read',
  ATM_MANAGE: 'atm:manage',
  ATM_CREDENTIALS: 'atm:credentials',
  OPERATOR_READ: 'operator:read',
  OPERATOR_MANAGE: 'operator:manage',
  PRESENCE_SELF: 'presence:self',
  ASSIGNMENT_READ: 'assignment:read',
  ASSIGNMENT_MANAGE: 'assignment:manage',
  ASSIGNMENT_OVERRIDE: 'assignment:override',
  SHIFT_READ: 'shift:read',
  SHIFT_MANAGE: 'shift:manage',
  CALL_INITIATE: 'call:initiate',
  /** Call any ATM in the organization, not only assigned ones. */
  CALL_INITIATE_ANY: 'call:initiate:any',
  CALL_HANGUP_ANY: 'call:hangup:any',
  CALL_READ: 'call:read',
  QUEUE_READ: 'queue:read',
  QUEUE_MANAGE: 'queue:manage',
  ROUTING_MANAGE: 'routing:manage',
  SIP_INFRA_MANAGE: 'sip:manage',
  REPORT_READ: 'report:read',
  AUDIT_READ: 'audit:read',
  SYSTEM_READ: 'system:read',
  SYSTEM_MANAGE: 'system:manage',
  VMS_LINK: 'vms:link',
  /** Act across organizations (super admin only). */
  CROSS_TENANT: 'tenant:cross',
} as const;
export type Permission = (typeof Permission)[keyof typeof Permission];

const P = Permission;
const ALL = Object.values(P) as Permission[];

/** Default role grants. Stored in `role_permissions` and seeded from here. */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  SUPER_ADMIN: ALL,
  ORG_ADMIN: [
    P.ORG_READ, P.USER_MANAGE, P.USER_READ, P.ATM_READ, P.ATM_MANAGE, P.ATM_CREDENTIALS,
    P.OPERATOR_READ, P.OPERATOR_MANAGE, P.ASSIGNMENT_READ, P.ASSIGNMENT_MANAGE, P.ASSIGNMENT_OVERRIDE,
    P.SHIFT_READ, P.SHIFT_MANAGE, P.CALL_READ, P.QUEUE_READ, P.QUEUE_MANAGE, P.ROUTING_MANAGE,
    P.REPORT_READ, P.AUDIT_READ, P.SYSTEM_READ, P.VMS_LINK,
  ],
  SUPERVISOR: [
    P.ORG_READ, P.USER_READ, P.ATM_READ, P.OPERATOR_READ, P.PRESENCE_SELF, P.ASSIGNMENT_READ,
    P.ASSIGNMENT_OVERRIDE, P.SHIFT_READ, P.SHIFT_MANAGE, P.CALL_INITIATE, P.CALL_INITIATE_ANY,
    P.CALL_HANGUP_ANY, P.CALL_READ, P.QUEUE_READ, P.QUEUE_MANAGE, P.REPORT_READ, P.SYSTEM_READ, P.VMS_LINK,
  ],
  OPERATOR: [
    P.ATM_READ, P.OPERATOR_READ, P.PRESENCE_SELF, P.ASSIGNMENT_READ, P.SHIFT_READ,
    P.CALL_INITIATE, P.CALL_READ, P.QUEUE_READ, P.VMS_LINK,
  ],
  // Read-only: no device control, no call initiation, no presence.
  AUDITOR: [P.ORG_READ, P.ATM_READ, P.OPERATOR_READ, P.ASSIGNMENT_READ, P.SHIFT_READ, P.CALL_READ, P.REPORT_READ, P.AUDIT_READ],
};

export function permissionsForRoles(roles: readonly Role[]): Set<Permission> {
  const s = new Set<Permission>();
  for (const r of roles) for (const p of ROLE_PERMISSIONS[r] ?? []) s.add(p);
  return s;
}

export function hasPermission(roles: readonly Role[], perm: Permission): boolean {
  return permissionsForRoles(roles).has(perm);
}
