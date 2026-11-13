import { describe, expect, it } from 'vitest';
import { DEFAULT_QUEUE_POLICY, effectiveRank, sortQueue } from '../src/index.js';

describe('priority queue ordering', () => {
  const now = 1_000_000_000;
  it('orders by priority then FIFO', () => {
    const items = [
      { id: 'c', priority: 'P3' as const, enqueuedAt: now - 1000 },
      { id: 'a', priority: 'P1' as const, enqueuedAt: now - 10 },
      { id: 'b', priority: 'P3' as const, enqueuedAt: now - 2000 },
      { id: 'd', priority: 'P2' as const, enqueuedAt: now - 5 },
    ];
    expect(sortQueue(items, now).map((i) => i.id)).toEqual(['a', 'd', 'b', 'c']);
  });

  it('ages low priority requests but never to critical', () => {
    const step = DEFAULT_QUEUE_POLICY.agingStepMs;
    expect(effectiveRank({ id: 'x', priority: 'P4', enqueuedAt: now - step }, now)).toBe(3);
    expect(effectiveRank({ id: 'x', priority: 'P4', enqueuedAt: now - 50 * step }, now)).toBe(2);
    expect(effectiveRank({ id: 'x', priority: 'P1', enqueuedAt: now - 50 * step }, now)).toBe(1);
  });

  it('an aged P4 overtakes a fresh P3 but not a P1', () => {
    const step = DEFAULT_QUEUE_POLICY.agingStepMs;
    const out = sortQueue(
      [
        { id: 'fresh-p3', priority: 'P3', enqueuedAt: now },
        { id: 'old-p4', priority: 'P4', enqueuedAt: now - 3 * step },
        { id: 'p1', priority: 'P1', enqueuedAt: now },
      ],
      now,
    );
    expect(out.map((i) => i.id)).toEqual(['p1', 'old-p4', 'fresh-p3']);
  });

  it('is deterministic for identical keys', () => {
    const a = { id: 'a', priority: 'P3' as const, enqueuedAt: now };
    const b = { id: 'b', priority: 'P3' as const, enqueuedAt: now };
    expect(sortQueue([b, a], now)[0]!.id).toBe('a');
  });
});
