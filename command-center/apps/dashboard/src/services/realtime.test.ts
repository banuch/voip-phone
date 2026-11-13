import type { EventEnvelope } from '@wintek/shared';
import { EventSequencer } from './realtime';

const ev = (seq: number, id = `e${seq}`, orgId = 'o1'): EventEnvelope => ({
  id, seq, orgId, type: 'atm.status.changed', schemaVersion: 1, ts: '', entityType: 'atm', entityId: 'a', entityVersion: seq, correlationId: null, data: {},
});

describe('EventSequencer', () => {
  it('applies in order, drops duplicates and already-seen seqs', () => {
    const out: number[] = [];
    const s = new EventSequencer((e) => out.push(e.seq), vi.fn(), vi.fn());
    s.reset({ o1: 10 });
    [ev(11), ev(11), ev(12), ev(10), ev(12, 'other-id')].forEach((e) => s.push(e));
    expect(out).toEqual([11, 12]);
  });

  it('holds a gap, asks for replay, and drains once filled', () => {
    const out: number[] = [];
    const replay = vi.fn();
    const s = new EventSequencer((e) => out.push(e.seq), replay, vi.fn());
    s.reset({ o1: 1 });
    s.push(ev(4));
    s.push(ev(3));
    expect(out).toEqual([]);
    expect(replay).toHaveBeenCalledWith('o1', 1);
    expect(replay).toHaveBeenCalledTimes(1);
    s.push(ev(2));
    expect(out).toEqual([2, 3, 4]);
  });

  it('asks for a resync when the gap is never filled', () => {
    vi.useFakeTimers();
    const unfilled = vi.fn();
    const s = new EventSequencer(() => undefined, vi.fn(), unfilled, 100);
    s.reset({ o1: 1 });
    s.push(ev(5));
    vi.advanceTimersByTime(150);
    expect(unfilled).toHaveBeenCalledWith('o1');
    vi.useRealTimers();
  });

  it('applies unsequenced (degraded) events immediately', () => {
    const out: string[] = [];
    const s = new EventSequencer((e) => out.push(e.id), vi.fn(), vi.fn());
    s.reset({ o1: 3 });
    s.push(ev(0, 'x'));
    expect(out).toEqual(['x']);
  });
});
