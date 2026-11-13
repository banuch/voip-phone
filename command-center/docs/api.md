# REST API (v1)

Base path `/api/v1`. The full machine-readable contract (request/response
schemas, validation rules) is [`openapi.json`](openapi.json), generated from
the code with `pnpm --filter @wintek/api openapi`; the API also serves
Swagger UI at `/api/docs` outside production.

## Conventions

* **Authentication**: `Authorization: Bearer <access token>` (15 min, HS256).
  Refresh token: httpOnly, `Secure`, `SameSite=Strict` cookie scoped to
  `/api/v1/auth`, rotated on every use; reuse of a rotated token revokes the
  whole session family.
* **Authorization**: permission guard on every route (see roles in
  `packages/shared/src/rbac.ts`), plus tenant scoping in every query. Users
  are pinned to their organization; asking for another org returns 403
  (lists) or 404 (single objects, so existence isn't leaked). Super admins
  pass `orgId`.
* **Validation**: DTOs with class-validator; unknown properties are rejected
  (`forbidNonWhitelisted`).
* **Errors**: `{ code, message, details?, correlationId }`. `X-Correlation-Id`
  is accepted and echoed on every response and recorded in audit rows.
* **Pagination**: `page` (1-based), `pageSize` (≤500), `sort` (`field` or
  `-field`, whitelisted) → `{ items, total, page, pageSize }`.
* **Rate limits**: per user when authenticated, per IP otherwise. Default
  600/min; tighter limits below. 429 → `RATE_LIMITED`.
* **Audit**: every state-changing call writes an audit row inside the same
  transaction, with secrets redacted.

## Endpoints

| Method & path | Permission | Rate limit | Audited | Notes |
|---|---|---|---|---|
| POST `/auth/login` | public | 10/min | login / failed login | lockout after 5 failures for 15 min; same error for unknown user and bad password |
| POST `/auth/refresh` | cookie | 30/min | reuse detection | rotates the cookie |
| POST `/auth/logout` | cookie | — | logout | revokes the token family |
| GET `/auth/me` | any | — | — | roles + effective permissions |
| GET `/dashboard/summary` | atm:read | — | — | 15 headline counts |
| GET `/dashboard/activity` | atm:read | — | — | last 24 h call + device events |
| GET `/dashboard/regions` | atm:read | — | — | per-region availability |
| GET `/reports/calls` | report:read | — | — | `from,to,bucket=hour|day,format=json|csv` (≤92 days) |
| GET `/reports/availability` | report:read | — | — | device event trend |
| GET `/atms` | atm:read | — | — | filters: `q, regionId, groupId, operatorId, registration, health, status, inCall, mine`; paginated |
| GET `/atms/:id` | atm:read | — | — | detail incl. call history metadata, faults, VMS link (if `vms:link`) |
| GET `/atms/:id/status` | atm:read | — | — | compact live status |
| POST `/atms` | atm:manage + atm:credentials | — | atm.provisioned | returns SIP credentials **once** |
| PATCH `/atms/:id` | atm:manage | — | atm.updated | disabling also disables the SIP identity |
| DELETE `/atms/:id` | atm:manage | — | atm.deleted | soft delete; refused during a call |
| POST `/atms/:id/credentials/rotate` | atm:credentials | 20/min | atm.credentials.rotated | new password once |
| POST `/atms/bulk` | atm:manage | — | atm.bulk.* | ≤5,000 ids, all-or-nothing |
| POST `/atms/import` | atm:manage + atm:credentials | 5/min | atm.imported | CSV, `dryRun=true` validates only |
| GET `/atms/regions`, `/atms/groups` | atm:read | — | — | with counts |
| GET `/operators` | operator:read | — | — | live availability, current call, counts |
| GET `/operators/:id`, `/operators/:id/assignments` | operator:read / assignment:read | — | — | |
| GET `/operators/me` | presence:self | — | — | |
| PUT `/operators/me/presence` | presence:self | — | presence.selected | AVAILABLE, BREAK, UNAVAILABLE only |
| POST `/operators/me/heartbeat` | presence:self | 30/min | — | REST fallback for the WS heartbeat |
| POST `/operators/me/webrtc-credentials` | call:initiate | 10/min | issued | session-bound SIP password + ICE/TURN |
| POST `/operators`, PATCH `/operators/:id` | operator:manage | — | operator.* | |
| GET `/assignments` | assignment:read | — | — | |
| PUT `/assignments/:atmId` | assignment:manage | — | assignment.updated | `expectedVersion` → 409 `STALE_VERSION` |
| GET `/assignments/:atmId/resolve` | assignment:read | — | — | routing decision + trace |
| GET/POST `/assignment-overrides`, DELETE `/assignment-overrides/:id` | assignment:read / assignment:override | — | override.created/revoked | reason + expiry required |
| GET/PUT `/routing-policies` | assignment:read / routing:manage | — | routing.policy.updated | |
| GET `/shifts`, `/shifts/on-duty` | shift:read | — | — | |
| POST/PUT/DELETE `/shifts…`, PUT `/shifts/:id/members` | shift:manage | — | shift.* | |
| POST `/calls/initiate` | call:initiate | 30/min | call.initiated / call.initiate.rejected | see [call-flow.md](call-flow.md) |
| POST `/calls/:id/hangup` | call:read + (own call or call:hangup:any) | — | call.hangup | idempotent |
| GET `/calls` | call:read | — | — | active calls |
| GET `/calls/mine` | call:read | — | — | console recovery |
| GET `/calls/:id/status` | call:read | — | — | metadata + state timeline |
| GET `/call-history` | call:read | — | — | filters + pagination |
| GET `/queue` | queue:read | — | — | dispatch order with position |
| POST `/queue` | queue:manage | — | queue.request.created | supervisor / integration request |
| DELETE `/queue/:id` | requester or queue:manage | — | cancelled | |
| POST `/queue/:id/decline` | call:initiate | — | queue.offer.declined | offered operator only |
| GET `/audit` | audit:read | — | — | filters: action prefix, actor, outcome, entity, time |
| GET/POST/PATCH `/admin/organizations…` | org:read / org:manage | — | org.* | |
| GET/POST/PATCH `/admin/users…` | user:read / user:manage | — | user.* | no granting roles beyond your own permissions; role/password/status changes revoke sessions |
| GET `/admin/roles` | user:read | — | — | |
| POST `/admin/regions`, `/admin/groups` | atm:manage | — | region/group.created | |
| GET/PUT `/admin/settings…` | system:read / system:manage | — | system.setting.changed | whitelisted keys with validators |
| GET `/system/live` | public | exempt | — | readiness (DB reachable) |
| GET `/system/health` | system:read | — | — | DB, Redis, media node, WS, job status |
| GET `/metrics` (no prefix) | network-restricted | exempt | — | Prometheus |
| POST `/internal/sip/registrations` | shared secret header | exempt | device_events | registrar webhook; blocked at the proxy |
