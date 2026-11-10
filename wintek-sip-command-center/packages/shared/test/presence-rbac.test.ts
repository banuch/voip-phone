import { describe, expect, it } from 'vitest';
import { HEARTBEAT_STALE_MS, effectiveAvailability, hasPermission } from '../src/index.js';

describe('effectiveAvailability', () => {
  const base = { selected: 'AVAILABLE' as const, lastHeartbeatAt: 1000, sipRegistered: true, inActiveCall: false, mediaFault: false, now: 2000 };
  it('stale heartbeat is OFFLINE regardless of selection', () => {
    expect(effectiveAvailability({ ...base, now: 1000 + HEARTBEAT_STALE_MS + 1 })).toBe('OFFLINE');
    expect(effectiveAvailability({ ...base, lastHeartbeatAt: null })).toBe('OFFLINE');
  });
  it('active call is BUSY even if operator selected AVAILABLE', () => {
    expect(effectiveAvailability({ ...base, inActiveCall: true })).toBe('BUSY');
  });
  it('available without a SIP registration is a FAULT', () => {
    expect(effectiveAvailability({ ...base, sipRegistered: false })).toBe('FAULT');
  });
  it('break stays break', () => {
    expect(effectiveAvailability({ ...base, selected: 'BREAK' })).toBe('BREAK');
  });
});

describe('rbac', () => {
  it('auditor cannot initiate calls or manage devices', () => {
    expect(hasPermission(['AUDITOR'], 'call:initiate')).toBe(false);
    expect(hasPermission(['AUDITOR'], 'atm:manage')).toBe(false);
    expect(hasPermission(['AUDITOR'], 'audit:read')).toBe(true);
  });
  it('operators can call only assigned ATMs by default', () => {
    expect(hasPermission(['OPERATOR'], 'call:initiate')).toBe(true);
    expect(hasPermission(['OPERATOR'], 'call:initiate:any')).toBe(false);
  });
  it('only super admin crosses tenants', () => {
    expect(hasPermission(['ORG_ADMIN'], 'tenant:cross')).toBe(false);
    expect(hasPermission(['SUPER_ADMIN'], 'tenant:cross')).toBe(true);
  });
});
