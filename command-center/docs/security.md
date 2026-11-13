# Security model

## Identity and sessions
* Passwords: scrypt (N=2¹⁴, r=8, p=1), 12+ characters with three character
  classes; constant-time comparison; a dummy hash for unknown users so timing
  doesn't reveal valid usernames; lockout after 5 failures for 15 minutes.
* Access tokens: 15-minute HS256 JWT with issuer check, held only in memory
  by the SPA. Refresh tokens: random 256-bit, stored as SHA-256, httpOnly +
  Secure + SameSite=Strict cookie scoped to `/api/v1/auth`, rotated on every
  use; presenting a rotated token revokes the whole family (theft detection).
  Role, password or status changes revoke all of a user's sessions.
* Production refuses to start with development secrets, without Redis, with
  insecure cookies or with the simulated SIP driver (`config.ts`).

## Authorization
* Permissions are checked by a global guard on every route and denials are
  audited. Hiding UI elements is a convenience only.
* Tenant isolation: every query is scoped by organization; child rows
  reference parents by `(organization_id, id)` composite foreign keys, so even
  a buggy query cannot link one tenant's operator to another tenant's ATM.
* No privilege escalation: an administrator can only grant roles whose
  permissions they already hold; nobody can change their own roles/status.
* Auditors are read-only: no call initiation, no device control, no presence.

## SIP credentials
* Device and operator SIP passwords are generated server-side (24 characters,
  ~140 bits, unambiguous alphabet), shown **once**, and never stored. Only
  HA1 = MD5(user:realm:password) is kept; both registrars authenticate from
  HA1 directly.
* HA1 is still credential-equivalent for its realm, so in production the API
  role has no SELECT on `sip_identities.ha1` (`infra/postgres/roles.sql`);
  only the registrar roles read it, through views.
* Operator WebRTC credentials are session-bound: each sign-in rotates them.
* Dial tokens: one-time, 192-bit, stored hashed, bound to the reserving
  operator's authenticated SIP endpoint, cleared on use, expire with RESERVED
  (15 s).
* The device firmware's own Bluetooth provisioning has no PIN (see
  `ESP32S3_SipPhone/README.md`); deployments should restrict physical access
  and rotate credentials after installation.

## Logging and audit
* Request logs redact authorization headers, cookies and any field named like
  password/token/secret/ha1/credential (`LOG_REDACT_PATHS`); audit `detail` is
  recursively redacted before insert.
* `audit_logs` is append-only (trigger); deletion is only possible for the
  retention job with an explicit session flag (and, in production, a separate
  role).
* No audio is recorded anywhere; Asterisk recording modules are not loaded.

## Network
* Public: HTTPS (dashboard, API, WSS events) and SIP WSS for operators.
  ATM SIP/RTP: restricted to ATM networks/VPN at the firewall.
* Never public: ARI, `/api/v1/internal/*` (registrar webhook, shared secret),
  `/metrics`, PostgreSQL, Redis. The reverse proxy returns 404 for internal
  paths.
* Headers: HSTS, CSP (`default-src 'self'`, microphone allowed for self only),
  X-Frame-Options DENY, nosniff, no referrer.
* Kamailio: pike flood detection with temporary IP bans; INVITEs from ATMs are
  rejected (operator-initiated model).
* CSV exports neutralise spreadsheet formula injection.
