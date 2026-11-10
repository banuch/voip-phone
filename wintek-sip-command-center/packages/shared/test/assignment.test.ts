import { describe, expect, it } from 'vitest';
import { DEFAULT_ROUTING_POLICY, type OperatorCandidate, resolveAssignment } from '../src/index.js';

const atm = { atmId: 'atm1', organizationId: 'org1', regionId: 'north', groupIds: ['g1'] };
const op = (id: string, over: Partial<OperatorCandidate> = {}): OperatorCandidate => ({
  operatorId: id, organizationId: 'org1', active: true, availability: 'AVAILABLE', regionIds: ['north'],
  groupIds: [], onShift: true, workload: 0, routingPriority: 100, lastCallEndedAt: null, ...over,
});
const now = 10_000_000;

describe('resolveAssignment precedence', () => {
  it('uses an active override and skips the primary', () => {
    const d = resolveAssignment({
      atm, now, primaryOperatorId: 'p', backupOperatorId: 'b',
      overrides: [{ operatorId: 'o', startsAt: now - 1, endsAt: now + 1000 }],
      candidates: [op('p'), op('b'), op('o')],
    });
    expect(d).toMatchObject({ kind: 'OVERRIDE', operatorId: 'o' });
  });

  it('ignores expired overrides', () => {
    const d = resolveAssignment({
      atm, now, primaryOperatorId: 'p', backupOperatorId: null,
      overrides: [{ operatorId: 'o', startsAt: now - 1000, endsAt: now }],
      candidates: [op('p'), op('o')],
    });
    expect(d).toMatchObject({ kind: 'PRIMARY', operatorId: 'p' });
  });

  it('falls back from busy override to backup, not the replaced primary', () => {
    const d = resolveAssignment({
      atm, now, primaryOperatorId: 'p', backupOperatorId: 'b',
      overrides: [{ operatorId: 'o', startsAt: now - 1, endsAt: now + 1 }],
      candidates: [op('p'), op('b'), op('o', { availability: 'BUSY' })],
    });
    expect(d).toMatchObject({ kind: 'BACKUP', operatorId: 'b' });
  });

  it('falls back to backup when primary is busy or offline', () => {
    for (const availability of ['BUSY', 'OFFLINE', 'BREAK'] as const) {
      const d = resolveAssignment({
        atm, now, primaryOperatorId: 'p', backupOperatorId: 'b', overrides: [],
        candidates: [op('p', { availability }), op('b')],
      });
      expect(d.kind).toBe('BACKUP');
    }
  });

  it('dynamic pool prefers group match, then lower workload, then idle time', () => {
    const d = resolveAssignment({
      atm, now, primaryOperatorId: null, backupOperatorId: null, overrides: [],
      policy: { ...DEFAULT_ROUTING_POLICY, maxWorkload: 3 },
      candidates: [
        op('x', { workload: 0 }),
        op('y', { groupIds: ['g1'], workload: 1 }),
        op('z', { groupIds: ['g1'], workload: 1, lastCallEndedAt: now - 99 }),
        op('w', { groupIds: ['g1'], workload: 1, lastCallEndedAt: now - 5 }),
      ],
    });
    expect(d).toMatchObject({ kind: 'DYNAMIC', operatorId: 'y' }); // never called = longest idle
  });

  it('dynamic pool excludes other orgs, other regions, off-shift and disabled operators', () => {
    const d = resolveAssignment({
      atm, now, primaryOperatorId: null, backupOperatorId: null, overrides: [],
      candidates: [
        op('a', { organizationId: 'org2' }), op('b', { regionIds: ['south'] }),
        op('c', { onShift: false }), op('d', { active: false }), op('e', { workload: 1 }),
      ],
    });
    expect(d).toMatchObject({ kind: 'ESCALATE', operatorId: null });
    expect(d.trace.at(-1)!.step).toBe('ESCALATE');
  });

  it('never selects a static operator from another organization', () => {
    const d = resolveAssignment({
      atm, now, primaryOperatorId: 'p', backupOperatorId: null, overrides: [],
      policy: { ...DEFAULT_ROUTING_POLICY, allowDynamic: false },
      candidates: [op('p', { organizationId: 'org2' })],
    });
    expect(d.kind).toBe('ESCALATE');
  });

  it('honours exclusions', () => {
    const d = resolveAssignment({
      atm, now, primaryOperatorId: 'p', backupOperatorId: null, overrides: [], exclude: ['p'],
      candidates: [op('p'), op('q')],
    });
    expect(d).toMatchObject({ kind: 'DYNAMIC', operatorId: 'q' });
  });
});
