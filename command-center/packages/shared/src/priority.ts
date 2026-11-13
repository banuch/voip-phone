export const Priority = { P1: 'P1', P2: 'P2', P3: 'P3', P4: 'P4' } as const;
export type Priority = (typeof Priority)[keyof typeof Priority];

export const PRIORITY_LABEL: Record<Priority, string> = {
  P1: 'Critical',
  P2: 'High',
  P3: 'Normal',
  P4: 'Low',
};

/** Numeric rank: lower is more urgent. */
export const PRIORITY_RANK: Record<Priority, number> = { P1: 1, P2: 2, P3: 3, P4: 4 };

export interface QueueOrderingPolicy {
  /** Waiting this long promotes a request by one priority class (starvation prevention). */
  agingStepMs: number;
  /** Aging never promotes above this rank (P2 by default: aging alone never makes a request critical). */
  maxAgedRank: number;
}

export const DEFAULT_QUEUE_POLICY: QueueOrderingPolicy = {
  agingStepMs: 120_000,
  maxAgedRank: 2,
};

/** Default time a queued request may wait before it expires, per class. */
export const QUEUE_TIMEOUT_MS: Record<Priority, number> = {
  P1: 10 * 60_000,
  P2: 10 * 60_000,
  P3: 5 * 60_000,
  P4: 5 * 60_000,
};

export interface QueueItemLike {
  id: string;
  priority: Priority;
  /** epoch ms */
  enqueuedAt: number;
}

/** Rank after aging; never below `maxAgedRank` unless the base rank already is. */
export function effectiveRank(item: QueueItemLike, now: number, policy = DEFAULT_QUEUE_POLICY): number {
  const base = PRIORITY_RANK[item.priority];
  if (base <= policy.maxAgedRank) return base;
  const steps = Math.floor(Math.max(0, now - item.enqueuedAt) / policy.agingStepMs);
  return Math.max(policy.maxAgedRank, base - steps);
}

/**
 * Deterministic queue order: effective priority, then FIFO by enqueue time,
 * then id as a final tie-breaker so every node sorts identically.
 */
export function compareQueueItems(a: QueueItemLike, b: QueueItemLike, now: number, policy = DEFAULT_QUEUE_POLICY): number {
  const r = effectiveRank(a, now, policy) - effectiveRank(b, now, policy);
  if (r !== 0) return r;
  if (a.enqueuedAt !== b.enqueuedAt) return a.enqueuedAt - b.enqueuedAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function sortQueue<T extends QueueItemLike>(items: readonly T[], now: number, policy = DEFAULT_QUEUE_POLICY): T[] {
  return [...items].sort((a, b) => compareQueueItems(a, b, now, policy));
}
