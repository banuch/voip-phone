# Real-time events (WebSocket `/ws`)

## Handshake

Browsers can't send headers on a WebSocket upgrade and tokens in URLs leak
into proxy logs, so authentication is the first message:

```jsonc
// client → server, within 5 s of connecting
{ "type": "auth", "token": "<access token>", "since": { "<orgId>": 1234 } }
// server → client
{ "type": "ready", "seq": { "<orgId>": 1240 }, "nodeTime": "2026-11-10T06:00:00Z" }
// …then replayed events 1235..1240, or system.resync_required
```

Other client messages: `{type:"heartbeat", sipRegistered, mediaFault}` (operators,
every 10 s), `{type:"replay", orgId, since}`, `{type:"ping"}`.
Close codes: `4401` auth missing/invalid, `4400` oversized message.

## Envelope

```ts
interface EventEnvelope<T> {
  id: string;            // UUID, for de-duplication
  type: EventType;
  schemaVersion: 1;
  ts: string;            // server time, ISO-8601
  orgId: string;         // tenant scope; clients only receive their org (super admins: all)
  entityType: 'atm' | 'operator' | 'call' | 'queue' | 'assignment' | 'system';
  entityId: string;
  seq: number;           // per-org monotonic sequence; 0 = unsequenced (degraded)
  entityVersion: number; // row version, for last-writer-wins
  correlationId: string | null;
  data: T;
}
```

## Types

| Type | Data |
|------|------|
| `atm.status.changed` | `{atmId, registration, health, inCall, lastSeenAt}` |
| `atm.registration.changed` | same |
| `operator.presence.changed` | `{operatorId, selected, effective, currentCallId}` |
| `call.requested` / `call.dialing` / `call.ringing` / `call.connected` / `call.terminating` | `CallEventData` |
| `call.ended` (COMPLETED, CANCELLED) / `call.failed` (BUSY, FAILED, TIMEOUT) | `CallEventData` incl. `sipCode`, `reason`, `answeredAt`, `endedAt` |
| `queue.updated` | `{queueItemId, atmId, state, priority, offeredOperatorId, escalated, reason}` |
| `assignment.updated` | `{atmId, kind: STATIC|OVERRIDE|OVERRIDE_REVOKED, …}` |
| `system.alert` | `{severity, component, message}` |
| `system.resync_required` | `{reason}` — refetch REST snapshots |

## Delivery semantics and the client contract

Delivery is **at least once** and may be reordered across reconnects. Never
assume exactly-once. The dashboard (`EventSequencer` in
`apps/dashboard/src/services/realtime.ts`, unit-tested):

1. drops events whose `id` it has seen, and any `seq` ≤ the last applied,
2. applies `seq = last + 1` immediately and drains any buffered successors,
3. on a gap, buffers, requests one replay from `last`, and if the gap is not
   filled within 1.5 s treats it as `resync_required`,
4. applies `seq = 0` events immediately (Redis degraded mode),
5. on (re)connect sends its last seq per org; if the server's 5,000-event
   buffer no longer covers it, the server answers `system.resync_required`.

Events are notifications; REST is the record. The dashboard reacts by
invalidating the affected queries, coalesced to at most one refetch per
second per key, so a burst of thousands of registration changes costs one
refetch. The persistent stale indicator shows Live / Reconnecting / Offline
and flags data as possibly out of date whenever the stream is down.
