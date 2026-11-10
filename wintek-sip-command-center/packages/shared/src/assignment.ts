import { Availability, canTakeCall } from './presence.js';

/**
 * Hybrid operator assignment - deterministic precedence (V1.1).
 *
 *   1. OVERRIDE  An unexpired supervisor override for the ATM. While it is in
 *                force it REPLACES the static primary (the supervisor's intent
 *                is "not the usual person"), so the primary is skipped.
 *   2. PRIMARY   The static primary operator.
 *   3. BACKUP    The static backup operator.
 *   4. DYNAMIC   Best eligible operator from the pool (same org, region,
 *                active shift, available), ranked by group match, workload,
 *                routing priority, idle time, id.
 *   5. ESCALATE  Nobody eligible: raise to the region's supervisors.
 *
 * A candidate at any step is used only if it is ELIGIBLE: same organization,
 * account active, effective availability AVAILABLE, on an active shift when
 * the policy requires shifts, below the workload cap, and (for dynamic
 * selection) covering the ATM's region. The resolver is pure; the caller
 * loads inputs inside the same transaction that writes the reservation, so a
 * decision is never made on data another transaction is changing.
 */

export type AssignmentDecisionKind = 'OVERRIDE' | 'PRIMARY' | 'BACKUP' | 'DYNAMIC' | 'ESCALATE';

export interface AtmRoutingContext {
  atmId: string;
  organizationId: string;
  regionId: string;
  groupIds: readonly string[];
}

export interface OperatorCandidate {
  operatorId: string;
  organizationId: string;
  active: boolean;
  availability: Availability;
  regionIds: readonly string[];
  groupIds: readonly string[];
  onShift: boolean;
  /** Active calls (0 or 1 in V1.1) plus routed requests waiting on this operator. */
  workload: number;
  /** Lower routes first. */
  routingPriority: number;
  /** epoch ms of last call end; null = never. Longest-idle wins ties. */
  lastCallEndedAt: number | null;
}

export interface AssignmentOverride {
  operatorId: string;
  startsAt: number;
  endsAt: number;
}

export interface RoutingPolicy {
  allowDynamic: boolean;
  requireActiveShift: boolean;
  /** Dynamic pool may only use operators whose regions include the ATM's region. */
  sameRegionOnly: boolean;
  /** Prefer operators covering one of the ATM's groups. */
  preferGroupMatch: boolean;
  maxWorkload: number;
}

export const DEFAULT_ROUTING_POLICY: RoutingPolicy = {
  allowDynamic: true,
  requireActiveShift: true,
  sameRegionOnly: true,
  preferGroupMatch: true,
  maxWorkload: 1,
};

export interface AssignmentInputs {
  atm: AtmRoutingContext;
  primaryOperatorId: string | null;
  backupOperatorId: string | null;
  overrides: readonly AssignmentOverride[];
  candidates: readonly OperatorCandidate[];
  policy?: RoutingPolicy;
  /** Operators that must not be chosen (e.g. already declined this request). */
  exclude?: readonly string[];
  now: number;
}

export interface AssignmentTraceStep {
  step: AssignmentDecisionKind;
  operatorId: string | null;
  outcome: 'SELECTED' | 'SKIPPED' | 'NOT_CONFIGURED';
  reason: string;
}

export interface AssignmentDecision {
  kind: AssignmentDecisionKind;
  operatorId: string | null;
  trace: AssignmentTraceStep[];
}

export function activeOverride(overrides: readonly AssignmentOverride[], now: number): AssignmentOverride | null {
  // Latest-starting override in force wins, so a newer override supersedes an older one.
  let best: AssignmentOverride | null = null;
  for (const o of overrides) {
    if (o.startsAt <= now && now < o.endsAt && (!best || o.startsAt > best.startsAt)) best = o;
  }
  return best;
}

export function ineligibilityReason(
  c: OperatorCandidate | undefined,
  atm: AtmRoutingContext,
  policy: RoutingPolicy,
  exclude: ReadonlySet<string>,
): string | null {
  if (!c) return 'operator not found';
  if (exclude.has(c.operatorId)) return 'excluded for this request';
  if (c.organizationId !== atm.organizationId) return 'different organization';
  if (!c.active) return 'account disabled';
  if (!canTakeCall(c.availability)) return `availability ${c.availability}`;
  if (policy.requireActiveShift && !c.onShift) return 'not on an active shift';
  if (c.workload >= policy.maxWorkload) return `workload ${c.workload} at cap ${policy.maxWorkload}`;
  return null;
}

export function rankDynamicCandidates(
  candidates: readonly OperatorCandidate[],
  atm: AtmRoutingContext,
  policy: RoutingPolicy,
): OperatorCandidate[] {
  const groups = new Set(atm.groupIds);
  const groupMatch = (c: OperatorCandidate) => (c.groupIds.some((g) => groups.has(g)) ? 1 : 0);
  return [...candidates].sort((a, b) => {
    if (policy.preferGroupMatch) {
      const g = groupMatch(b) - groupMatch(a);
      if (g !== 0) return g;
    }
    if (a.workload !== b.workload) return a.workload - b.workload;
    if (a.routingPriority !== b.routingPriority) return a.routingPriority - b.routingPriority;
    const ai = a.lastCallEndedAt ?? -Infinity;
    const bi = b.lastCallEndedAt ?? -Infinity;
    if (ai !== bi) return ai - bi;
    return a.operatorId < b.operatorId ? -1 : a.operatorId > b.operatorId ? 1 : 0;
  });
}

export function resolveAssignment(input: AssignmentInputs): AssignmentDecision {
  const policy = input.policy ?? DEFAULT_ROUTING_POLICY;
  const exclude = new Set(input.exclude ?? []);
  const byId = new Map(input.candidates.map((c) => [c.operatorId, c]));
  const trace: AssignmentTraceStep[] = [];
  const tried = new Set<string>();

  const tryStatic = (step: AssignmentDecisionKind, id: string | null): AssignmentDecision | null => {
    if (!id) {
      trace.push({ step, operatorId: null, outcome: 'NOT_CONFIGURED', reason: 'none configured' });
      return null;
    }
    tried.add(id);
    const why = ineligibilityReason(byId.get(id), input.atm, policy, exclude);
    if (why) {
      trace.push({ step, operatorId: id, outcome: 'SKIPPED', reason: why });
      return null;
    }
    trace.push({ step, operatorId: id, outcome: 'SELECTED', reason: 'eligible' });
    return { kind: step, operatorId: id, trace };
  };

  const override = activeOverride(input.overrides, input.now);
  if (override) {
    const hit = tryStatic('OVERRIDE', override.operatorId);
    if (hit) return hit;
    trace.push({
      step: 'PRIMARY',
      operatorId: input.primaryOperatorId,
      outcome: 'SKIPPED',
      reason: 'replaced by active override',
    });
    if (input.primaryOperatorId) tried.add(input.primaryOperatorId);
  } else {
    trace.push({ step: 'OVERRIDE', operatorId: null, outcome: 'NOT_CONFIGURED', reason: 'no override in force' });
    const hit = tryStatic('PRIMARY', input.primaryOperatorId);
    if (hit) return hit;
  }

  const backup = tryStatic('BACKUP', input.backupOperatorId);
  if (backup) return backup;

  if (policy.allowDynamic) {
    const pool = input.candidates.filter(
      (c) =>
        !tried.has(c.operatorId) &&
        ineligibilityReason(c, input.atm, policy, exclude) === null &&
        (!policy.sameRegionOnly || c.regionIds.includes(input.atm.regionId)),
    );
    const best = rankDynamicCandidates(pool, input.atm, policy)[0];
    if (best) {
      trace.push({ step: 'DYNAMIC', operatorId: best.operatorId, outcome: 'SELECTED', reason: `best of ${pool.length} eligible` });
      return { kind: 'DYNAMIC', operatorId: best.operatorId, trace };
    }
    trace.push({ step: 'DYNAMIC', operatorId: null, outcome: 'SKIPPED', reason: 'no eligible operator in pool' });
  } else {
    trace.push({ step: 'DYNAMIC', operatorId: null, outcome: 'NOT_CONFIGURED', reason: 'dynamic routing disabled by policy' });
  }

  trace.push({ step: 'ESCALATE', operatorId: null, outcome: 'SELECTED', reason: 'no eligible operator' });
  return { kind: 'ESCALATE', operatorId: null, trace };
}
