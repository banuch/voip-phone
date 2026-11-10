# Wintek ATM SIP Command Center V1.1

Enterprise platform for monitoring, managing and talking to up to 20,000 ATM
SIP intercoms (the ESP32-S3 device in `../ESP32S3_SipPhone`). Security
operators watch their CCTV/VMS as usual; when they see something they click
**CALL**, the platform validates and reserves the call, the intercom answers
automatically, and the operator speaks to the person at the ATM.

* Calls are **operator-initiated only**; ATMs never call in (V1.1).
* One active call per ATM and per operator — enforced by the database.
* **No audio is recorded.** Only call metadata, device events and audit logs.
* CCTV video is out of scope; VMS products integrate through links and
  incident references.

## Repository layout

```
wintek-sip-command-center/
  packages/shared/      Domain rules shared by API and UI (pure, unit-tested):
                        call state machine + timeouts, hybrid assignment resolver,
                        priority queue ordering, presence derivation, RBAC, event envelope
  apps/api/             NestJS API: REST + OpenAPI, WebSocket /ws, call control via
                        Asterisk ARI (or a simulator), queue dispatcher, sweepers, audit
    migrations/         PostgreSQL schema (forward-only SQL)
    scripts/            smoke test, device simulator
  apps/dashboard/       React + Vite + Tailwind (shadcn-style Radix components),
                        TanStack Query, Zustand, Recharts, SIP.js softphone
  infra/                docker-compose, Asterisk, Kamailio, nginx, coturn,
                        Prometheus/Grafana, least-privilege DB roles
  docs/                 Architecture and specifications (start with architecture.md)
```

## Quick start (development, no SIP hardware)

```bash
pnpm install
docker compose -f infra/docker-compose.yml up -d postgres redis
cp apps/api/.env.example apps/api/.env          # SIP_DRIVER=simulated
pnpm --filter @wintek/shared build
pnpm db:migrate && pnpm db:seed                 # demo bank, 2,000 ATMs (SEED_ATMS=20000 for scale)
pnpm dev:api                                    # http://localhost:3000/api/docs
pnpm --filter @wintek/api sim:devices           # keeps the demo fleet registered
pnpm dev:dashboard                              # http://localhost:5173
```

Sign in as `operator1` (operator), `supervisor`, `orgadmin`, `superadmin` or
`auditor`; the seed prints the demo password. For UI work with no backend at
all: `pnpm --filter @wintek/dashboard dev:mock`.

## Tests

```bash
pnpm --filter @wintek/shared test                         # domain rules
TEST_DATABASE_URL=postgres://… pnpm --filter @wintek/api test   # unit + PostgreSQL integration
pnpm --filter @wintek/dashboard test                       # realtime sequencing, mock rules
apps/api/scripts/smoke.sh                                  # end-to-end against a running API
```

The API integration suite runs the real HTTP API against PostgreSQL with the
simulated SIP driver and covers: the full call flow (CONNECTED only after the
ATM answers), six concurrent initiations on one ATM (exactly one wins), one
operator dialling two ATMs at once, idempotent `requestId`, offline/unassigned/
cross-tenant refusals, reservation timeout and release, busy-ATM queueing and
offer/fulfilment, supervisor hang-up permissions, audit content, and
advisory-lock leadership.

## Documentation

| Document | Contents |
|----------|----------|
| [architecture.md](docs/architecture.md) | components, call path, registrar authority per stage, PostgreSQL/Redis consistency, capacity, HA |
| [call-flow.md](docs/call-flow.md) | states, transitions, timeouts, concurrency rules, busy handling, idempotency |
| [routing-and-queue.md](docs/routing-and-queue.md) | authorization vs routing, assignment precedence, overrides, priority queue |
| [failover.md](docs/failover.md) | detection / timeout / retry / escalation / recovery for each failure |
| [api.md](docs/api.md) + [openapi.json](docs/openapi.json) | every endpoint with permission, rate limit, audit behaviour |
| [realtime-events.md](docs/realtime-events.md) | WebSocket protocol, envelope, ordering and resync |
| [security.md](docs/security.md) | sessions, RBAC, tenancy, SIP credential handling, logging |
| [deployment.md](docs/deployment.md) | dev, single server, production HA, monitoring |
| [browser-support.md](docs/browser-support.md) | supported browsers, audio output selection |
| [vms-integration.md](docs/vms-integration.md) | optional CCTV/VMS context |

## Key decisions

* **SIP.js** for the browser: TypeScript-native, maintained, clean
  `UserAgent / Registerer / Inviter` API and access to the peer connection for
  device switching and quality stats.
* **ARI for call control**, not AMI: Stasis gives the API exclusive ownership
  of channels so the server, not the browser, decides every call.
* **One registrar at a time**: Asterisk in stage 1, Kamailio from stage 2
  (20,000 devices) — never both for the same identities.
* **PostgreSQL first, Redis second**: durable state and all concurrency
  guarantees live in PostgreSQL; Redis only distributes events.
* **HA1-only SIP credentials**, shown once; operator SIP passwords rotate per sign-in.

## Development phases

| Phase | Scope | Status |
|-------|-------|--------|
| 1 | Domain model, schema, API (auth, RBAC, inventory, provisioning, operators/presence, assignments/overrides, shifts, calls, queue, audit, dashboard/reports, realtime), dashboard (all screens), simulator, docs | **done in this branch** |
| 2 | Bring-up against a real Asterisk 20 + ESP32-S3 device: validate the ARI driver, realtime views, WSS/DTLS-SRTP and auto-answer end to end; Playwright E2E suite in CI | next |
| 3 | Kamailio stage-2 registrar, multi-media-node routing, load test (registrations at 20k, ~200 concurrent calls) to set `MAX_CONCURRENT_CALLS` | planned |
| 4 | Hardening: PostgreSQL RLS as defence in depth, Redis-backed rate limits, SSO (OIDC/SAML), Grafana dashboards, backup/restore drills | planned |

### Verification status (honest)

* Verified here: shared + API + dashboard type-check and build; 26 shared,
  22 API (incl. PostgreSQL integration) and 6 dashboard tests pass; the
  dashboard was driven in a real browser against the running API with the
  simulated SIP driver (login, presence, call to CONNECTED, hang-up,
  supervisor views); schema migrations apply on PostgreSQL 16;
  `docker compose config` validates.
* **Not yet verified** (no Asterisk/Kamailio or device in this environment):
  the ARI driver against a live Asterisk, the Asterisk realtime views loaded by
  `res_config_pgsql`, the Kamailio configuration, WebRTC media through
  coturn, and the container images. These are Phase 2 items.
