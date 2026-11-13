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

## Softphone directory (read-only ARI user)

Desktop softphones (Wintek Softphone) show online extensions by calling
`GET /ari/endpoints` with a **read-only** ARI user, `phone`. That user can list
endpoints but cannot control calls.

1. Set `ARI_PHONE_PASSWORD` in `infra/.env` (e.g. `openssl rand -base64 24`).
   If it is empty, the `[phone]` user is not created.
2. Recreate Asterisk:
   `docker compose -f infra/docker-compose.yml --profile full up -d --force-recreate asterisk`
3. Allow TCP 8088 **only from the office/VPN subnet**. ARI uses plain HTTP, so
   never expose it to the internet. For example:
   `sudo ufw allow from 192.168.1.0/24 to any port 8088 proto tcp`
4. Check: `asterisk -rx "ari show users"` lists `phone` (read-only), and from a
   softphone PC
   `curl -u phone:<password> http://<server>:8088/ari/endpoints` returns JSON.
5. In the softphone, open **Phone ▸ Directory server (ARI)…** and enter URL
   `http://<server>:8088`, user `phone`, and the password.

Stage 2 only: ATMs register with Kamailio, not Asterisk, so ARI does not list
them as online.
