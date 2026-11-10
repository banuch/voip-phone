# Deployment

## Development (no SIP hardware needed)

```bash
cd wintek-sip-command-center
pnpm install
docker compose -f infra/docker-compose.yml up -d postgres redis
cp apps/api/.env.example apps/api/.env      # SIP_DRIVER=simulated
pnpm --filter @wintek/shared build
pnpm db:migrate && pnpm db:seed             # SEED_ATMS=20000 for scale tests
pnpm dev:api                                # :3000, Swagger at /api/docs
pnpm --filter @wintek/api sim:devices        # keeps ATMs registered
pnpm dev:dashboard                          # :5173, proxies /api and /ws
```

Sign in as `operator1`, `supervisor`, `orgadmin`, `superadmin` or `auditor`
with the seed password printed by `db:seed`. UI-only work without a backend:
`pnpm --filter @wintek/dashboard dev:mock`.

`SIP_DRIVER=simulated` emits the same signals the ARI driver does (ringing,
answer, hang-up), so reservations, timers, queue and the dashboard behave as
in production; no audio flows.

## Single server / customer-owned deployment

`docker compose -f infra/docker-compose.yml --profile full up -d` runs
PostgreSQL, Redis, two API replicas, the dashboard behind nginx (TLS),
Asterisk (host networking for RTP) and coturn. Provide `infra/.env` (from
`.env.example`) and certificates in `infra/tls/`. Apply
`infra/postgres/roles.sql` to run with least-privilege database roles.

## Production HA topology (20,000 ATMs)

```
          ┌──────── LB / reverse proxy (TLS) ────────┐
          │                                          │
    API ×2..N (stateless) ── PostgreSQL primary ⇄ sync standby (Patroni/managed, PITR)
          │                └─ Redis (Sentinel/managed; optional for correctness)
          │ ARI (internal)
    Asterisk media ×N  ◀── SIP trunk ──▶  Kamailio ×2 (shared DB usrloc, floating IP / DNS SRV)
          ▲ WSS + DTLS-SRTP                            ▲ SIP/RTP over VPN/private APN
       operator browsers (+ coturn)                 ATM intercoms
```

* Stage 2 registrar (`--profile stage2`): point ATMs at Kamailio, remove ATM
  endpoints from Asterisk (`ATM_DIAL_MODE=kamailio`, enable the `kamailio`
  trunk in `pjsip.conf`). See architecture.md → Registrar authority.
* One API process per media node runs the ARI driver (`MEDIA_NODE_ID`); in a
  multi-media-node deployment run one ARI-connected API instance per Asterisk
  node, all sharing the database.
* Size Asterisk by load test: Opus↔G.711 transcoding is the CPU cost. The
  `MAX_CONCURRENT_CALLS` guard protects the platform until measured.

## Monitoring

`--profile monitoring` adds Prometheus (alert rules in
`infra/prometheus/alerts.yml`), Grafana, and Postgres/Redis exporters. The API
exposes `wintek_active_calls`, `wintek_online_atms`,
`wintek_available_operators`, `wintek_queue_depth`, job run/duration
counters and Node.js process metrics. Kamailio exposes `/metrics` via
`xhttp_prom`.

## Upgrades

Migrations are forward-only SQL files applied under an advisory lock by the
API container at start (safe with replicas). Deploy API replicas one at a time;
WebSocket clients reconnect and replay automatically.
