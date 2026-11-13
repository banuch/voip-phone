# Failure handling

New-call failover and active-call continuity are different things:

* **New calls** can always be routed around a failed component (another
  operator, another media node, another API replica).
* **An active call does not survive the loss of the media node carrying it.**
  Asterisk holds the bridge and both RTP legs; nothing in this design
  replicates live media state. The call is closed as FAILED with reason
  "media channels lost", the operator sees it immediately, and can call again.

| Failure | Detection | Timeout | Retry / failover | Escalation | Recovery | What users see | Audit / record |
|---------|-----------|---------|------------------|------------|----------|----------------|----------------|
| Primary operator offline | heartbeat stops | 30 s | routing skips to backup → dynamic pool | none if someone eligible | operator's next heartbeat | operator card OFFLINE | `presence.heartbeat_lost` |
| Primary operator busy | active call in `call_sessions` | immediate | backup → dynamic | — | call ends → AVAILABLE | BUSY badge | routing trace |
| Backup unavailable | eligibility check | immediate | dynamic pool | ESCALATE if pool empty: `system.alert`, request keeps waiting | someone becomes available → dispatcher offers | queue item "escalated" | `queue.escalated` |
| ATM registration lost | registrar unregister/expiry event; API sweeper if refreshes stop | 660 s without refresh | calls refused `ATM_OFFLINE`; queued requests wait | Prometheus: >5 % fleet drop in 10 min | next REGISTER | ATM badge Offline/Expired, offline counters | `device_events` |
| Asterisk node down (active calls) | ARI WebSocket closes; reconciler finds channels gone | ≤30 s (reconcile) or state timers | calls on that node → FAILED; **no** media continuity | `system.alert` critical; Prometheus | node restarts; ARI driver reconnects with backoff | call panel shows Failed + reason; health widget red | `call.ended` (FAILED) |
| Asterisk node down (new calls) | ARI not connected / health check | immediate | route to another media node (multi-node: operators register to a healthy node via DNS SRV/LB) | as above | — | health red | — |
| Kamailio node down (stage 2) | ATM REGISTER failures; health | registration expiry | second Kamailio (floating IP / DNS SRV); usrloc is DB-backed so the peer has contacts | Prometheus `up` | restart | ATMs stay Online if the peer serves them | device events if expiries occur |
| API node down | LB health check `/system/live` | 10 s | other replicas; jobs self-elect via advisory locks (lock dies with the connection) | Prometheus `ApiDown` | restart | WebSocket reconnects automatically; "Reconnecting" indicator | — |
| Database unreachable | pool errors, `/system/live` 503 | statement timeout 10 s | reconnect; HA standby promotion (Patroni/managed) | critical alert | promotion / restore | API errors with correlation id; no new calls (by design — reservations need the DB) | logs |
| Redis down | client error events | immediate | **degraded mode**: events delivered per node, unsequenced; nothing durable lost | health "redis down" | reconnect → clients told to resync | stale indicator if a node's clients miss events | — |
| Browser WebRTC disconnect | SIP.js transport disconnect; ARI sees operator leg destroyed | immediate | SIP.js reconnect with backoff; call ends server-side | — | re-register; heartbeat restores presence | "softphone: failed/registering"; presence FAULT | `call.ended` |
| Network interruption (operator) | WS close, heartbeat gap | 30 s | WS reconnect + replay from last seq or REST resync | — | automatic | "Reconnecting"/"Offline" banner, data flagged possibly stale | presence events |
| Operator refreshes the page mid-call | beforeunload prompt; operator leg drops | immediate | call ends; console recovers session and shows the ended call | — | place the call again | notice in call panel | `call.ended` |

## Detection details

* **Heartbeats**: the console sends one every 10 s (WebSocket, REST fallback).
  The server, not the browser, derives availability.
* **Registrations**: the registrar reports changes; the API additionally
  expires devices that stopped refreshing (`registration-stale` job).
* **Call timers**: every non-terminal call state has a deadline enforced by
  the sweeper (see call-flow.md).
* **Media reconciliation**: every 30 s, calls on a media node whose channels
  no longer exist are closed. If the node can't be queried the reconciler
  does nothing (it never guesses) and the state timers still apply.
