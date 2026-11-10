# Asterisk media / call-control node

Asterisk owns media (bridging, transcoding Opus/G.711, DTLS-SRTP to browsers)
and executes call control on behalf of the API through **ARI** (Stasis app
`wintek`). The API is the only authority on call state.

Config files here use `${VAR}` placeholders; render them with `envsubst` at
container start (see `infra/docker-compose.yml`). Required: `EXTERNAL_IP`,
`ARI_PASSWORD`, `ASTERISK_DB_PASSWORD`, `STUN_HOST`, and a TLS key pair in
`/etc/asterisk/keys` for WSS.

Registrar authority:

| Stage | Registrar | ATM endpoints in Asterisk | API `ATM_DIAL_MODE` |
|-------|-----------|---------------------------|---------------------|
| 1 (pilot, single site, up to a few thousand ATMs) | Asterisk PJSIP (realtime views) | yes (`ast_ps_*`) | `asterisk-registrar` |
| 2 (20,000 ATMs, HA) | Kamailio (usrloc in DB) | no — dialled via the `kamailio` trunk | `kamailio` |

Never point both registrars at the same identities.

Verify after start: `asterisk -rx "pjsip show endpoints"`, `asterisk -rx "ari show apps"`.
