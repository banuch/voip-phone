# Hybrid assignment, routing and the priority queue

Source: `packages/shared/src/assignment.ts` (pure resolver),
`apps/api/src/modules/assignments`, `apps/api/src/modules/queue`.

## Two different questions

| Question | Answered by | Used for |
|----------|-------------|----------|
| **May operator X call ATM Y?** (authorization) | `OPERATOR_AUTHORIZED_FOR_ATM_SQL` | `POST /calls/initiate`, "My ATMs" |
| **Who should be offered work for ATM Y now?** (routing) | `resolveAssignment()` | queue dispatch, routing trace in the UI |

Authorization is intentionally broader: an operator watching CCTV who sees an
incident must be able to call any ATM they are responsible for, even when
routing currently prefers a colleague. An operator is authorized when they
are the ATM's primary or backup, an active override targets them, or they
cover the ATM's region (and, if they have group restrictions, one of its
groups). Supervisors hold `call:initiate:any` for their organization.
Organization equality is always enforced, in SQL and by composite foreign keys.

## Routing precedence (deterministic)

1. **OVERRIDE** — an unexpired, unrevoked supervisor override. While in force it
   *replaces* the static primary (the supervisor's intent is "not the usual
   person"), so the primary is skipped.
2. **PRIMARY** — static primary.
3. **BACKUP** — static backup.
4. **DYNAMIC** — best eligible operator from the pool.
5. **ESCALATE** — nobody eligible: supervisors are alerted (`system.alert`) and
   the request keeps waiting.

A candidate at any step is used only if **eligible**: same organization,
account active, effective availability AVAILABLE (server-computed from
heartbeat, softphone registration and real call state), on an active shift
when the policy requires shifts, and below the workload cap (V1.1: 1, counting
active calls and outstanding offers). Dynamic candidates must also cover the
ATM's region when `sameRegionOnly` is set.

Dynamic ranking: ATM-group match → lower workload → lower routing priority →
longest idle (`last_call_ended_at`) → operator id. The final id tie-break makes
every node pick the same operator.

Every decision returns a **trace** (step, operator, SELECTED/SKIPPED/
NOT_CONFIGURED, reason), shown in the ATM drawer and available at
`GET /assignments/:atmId/resolve`.

## Routing policies

Per organization, region or ATM group (most specific wins: group → region →
organization → built-in default): `allowDynamic`, `requireActiveShift`,
`sameRegionOnly`, `preferGroupMatch`, `allowQueueWhenBusy`,
`queueTimeoutSeconds`. `allowPreemption` exists in the schema and is
constrained to `false` for V1.1.

## Overrides

`POST /assignment-overrides` requires `assignment:override`, a reason (≥5
characters), an expiry ≤7 days, and records the supervisor. Overlapping
overrides for the same ATM are rejected by an exclusion constraint
(`409 OVERRIDE_CONFLICT`). Creation and revocation are audited and published
as `assignment.updated`.

## Priority queue

The queue holds **call requests**, never calls: the offered operator places
the call, which fulfils the request. Nothing in the queue dials an ATM, and
nothing preempts an active call.

| Topic | Rule |
|-------|------|
| Classes | P1 Critical, P2 High, P3 Normal, P4 Low |
| Ordering | effective priority → FIFO by enqueue time → id |
| Starvation | every 2 minutes waiting promotes a request one class, but aging never promotes past P2 (only a human makes something critical) |
| One request per ATM | partial unique index; a new request for the same ATM merges: the more urgent priority and the later deadline win |
| Timeout | default 10 min (P1/P2) and 5 min (P3/P4), or the policy's `queueTimeoutSeconds` → EXPIRED |
| Eligibility | ATM must be ACTIVE, registered and not busy; operator chosen by the routing precedence (preferred requester first if eligible) |
| Offer | 30 s; unanswered or passed offers exclude that operator for this request and re-route |
| Escalation | no eligible operator → `escalated_at` set once, supervisors alerted (critical for P1) |
| Cancellation | requester or `queue:manage` |
| Audit | created / merged / offered / declined / timed-out / escalated / expired / cancelled |

The dispatcher runs every 2 s and immediately after any call ends, on one
API node at a time.
