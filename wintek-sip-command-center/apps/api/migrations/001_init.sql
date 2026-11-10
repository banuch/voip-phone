-- Wintek ATM SIP Command Center V1.1 - initial schema
--
-- Conventions
--  * Every tenant-owned table carries organization_id. Child rows reference
--    parents by (organization_id, id), so a row can never point at another
--    tenant's ATM, operator or region even if application code is wrong.
--  * Soft delete (deleted_at) for inventory/configuration that audit and call
--    history must keep referring to. Call history, events and audit logs are
--    append-only and are never soft-deleted; retention jobs purge them.
--  * `version` is bumped on every update and is sent to clients as
--    entityVersion for last-writer-wins on real-time events.
--  * No audio is stored anywhere. Only metadata.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE OR REPLACE FUNCTION touch_row() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  NEW.version := OLD.version + 1;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------- tenancy
CREATE TABLE organizations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          citext NOT NULL,
  name          text NOT NULL,
  timezone      text NOT NULL DEFAULT 'UTC',
  status        text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  version       integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX ux_org_code ON organizations (code) WHERE deleted_at IS NULL;

CREATE TABLE regions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  code             citext NOT NULL,
  name             text NOT NULL,
  parent_region_id uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  version          integer NOT NULL DEFAULT 1,
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, parent_region_id) REFERENCES regions (organization_id, id)
);
CREATE UNIQUE INDEX ux_region_code ON regions (organization_id, code) WHERE deleted_at IS NULL;

CREATE TABLE atm_groups (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  code            citext NOT NULL,
  name            text NOT NULL,
  description     text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1,
  UNIQUE (organization_id, id)
);
CREATE UNIQUE INDEX ux_group_code ON atm_groups (organization_id, code) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------- identity
CREATE TABLE roles (
  code        text PRIMARY KEY,                -- SUPER_ADMIN, ORG_ADMIN, SUPERVISOR, OPERATOR, AUDITOR
  name        text NOT NULL,
  description text
);

CREATE TABLE permissions (
  code        text PRIMARY KEY,                -- e.g. call:initiate
  description text
);

CREATE TABLE role_permissions (
  role_code       text NOT NULL REFERENCES roles(code) ON DELETE CASCADE,
  permission_code text NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
  PRIMARY KEY (role_code, permission_code)
);

CREATE TABLE users (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL only for platform super administrators.
  organization_id    uuid REFERENCES organizations(id),
  username           citext NOT NULL,
  display_name       text NOT NULL,
  email              citext,
  password_hash      text NOT NULL,          -- scrypt$N$r$p$salt$hash, never returned by any API
  status             text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','LOCKED','DISABLED')),
  failed_logins      integer NOT NULL DEFAULT 0,
  locked_until       timestamptz,
  last_login_at      timestamptz,
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz,
  version            integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX ux_user_username ON users (username) WHERE deleted_at IS NULL;
CREATE INDEX ix_user_org ON users (organization_id) WHERE deleted_at IS NULL;

CREATE TABLE user_roles (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_code  text NOT NULL REFERENCES roles(code),
  granted_by uuid REFERENCES users(id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role_code)
);

-- Refresh tokens: stored as SHA-256 hashes, rotated on every use. Reuse of a
-- rotated token revokes the whole family (stolen-token detection).
CREATE TABLE refresh_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id    uuid NOT NULL,
  token_hash   bytea NOT NULL UNIQUE,
  issued_at    timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  rotated_at   timestamptz,
  revoked_at   timestamptz,
  user_agent   text,
  ip           inet
);
CREATE INDEX ix_refresh_family ON refresh_tokens (family_id);
CREATE INDEX ix_refresh_user ON refresh_tokens (user_id) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------- operators
CREATE TABLE operators (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  user_id          uuid NOT NULL UNIQUE REFERENCES users(id),
  employee_code    text,
  routing_priority integer NOT NULL DEFAULT 100,
  max_concurrent_calls integer NOT NULL DEFAULT 1 CHECK (max_concurrent_calls = 1), -- V1.1 rule
  status           text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED')),
  last_call_ended_at timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  version          integer NOT NULL DEFAULT 1,
  UNIQUE (organization_id, id)
);

CREATE TABLE operator_regions (
  organization_id uuid NOT NULL,
  operator_id     uuid NOT NULL,
  region_id       uuid NOT NULL,
  PRIMARY KEY (operator_id, region_id),
  FOREIGN KEY (organization_id, operator_id) REFERENCES operators (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, region_id) REFERENCES regions (organization_id, id)
);

CREATE TABLE operator_groups (
  organization_id uuid NOT NULL,
  operator_id     uuid NOT NULL,
  group_id        uuid NOT NULL,
  PRIMARY KEY (operator_id, group_id),
  FOREIGN KEY (organization_id, operator_id) REFERENCES operators (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, group_id) REFERENCES atm_groups (organization_id, id)
);

-- Durable presence. Redis holds the hot copy (heartbeats every 10 s, TTL 30 s);
-- this row is written only when the selected or effective value changes, and
-- is the source of truth after a Redis loss.
CREATE TABLE operator_presence (
  operator_id       uuid PRIMARY KEY REFERENCES operators(id) ON DELETE CASCADE,
  organization_id   uuid NOT NULL REFERENCES organizations(id),
  selected          text NOT NULL DEFAULT 'OFFLINE' CHECK (selected IN ('AVAILABLE','BUSY','BREAK','OFFLINE','UNAVAILABLE','FAULT')),
  effective         text NOT NULL DEFAULT 'OFFLINE' CHECK (effective IN ('AVAILABLE','BUSY','BREAK','OFFLINE','UNAVAILABLE','FAULT')),
  sip_registered    boolean NOT NULL DEFAULT false,
  media_fault       boolean NOT NULL DEFAULT false,
  last_heartbeat_at timestamptz,
  session_node      text,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  version           integer NOT NULL DEFAULT 1
);
CREATE INDEX ix_presence_org_effective ON operator_presence (organization_id, effective);

-- Shift templates: days_of_week uses ISO numbering (1 = Monday). An end_time
-- earlier than start_time means the shift crosses midnight.
CREATE TABLE shifts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  region_id       uuid,
  name            text NOT NULL,
  days_of_week    smallint[] NOT NULL CHECK (days_of_week <@ ARRAY[1,2,3,4,5,6,7]::smallint[]),
  start_time      time NOT NULL,
  end_time        time NOT NULL,
  timezone        text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1,
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, region_id) REFERENCES regions (organization_id, id)
);

CREATE TABLE shift_members (
  organization_id uuid NOT NULL,
  shift_id        uuid NOT NULL,
  operator_id     uuid NOT NULL,
  valid_from      date NOT NULL DEFAULT current_date,
  valid_to        date,
  PRIMARY KEY (shift_id, operator_id, valid_from),
  FOREIGN KEY (organization_id, shift_id) REFERENCES shifts (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, operator_id) REFERENCES operators (organization_id, id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------- devices
CREATE TABLE atm_devices (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organizations(id),
  atm_code            citext NOT NULL,                 -- customer's ATM ID
  name                text NOT NULL,
  region_id           uuid NOT NULL,
  state               text,
  city                text,
  site                text,
  address             text,
  latitude            numeric(9,6),
  longitude           numeric(9,6),
  device_model        text NOT NULL DEFAULT 'WINTEK-ESP32S3-INTERCOM',
  firmware_version    text,
  serial_number       text,
  status              text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED','MAINTENANCE')),
  -- Durable snapshot of live state; Redis/registrar events keep it current.
  registration_status text NOT NULL DEFAULT 'UNKNOWN' CHECK (registration_status IN ('REGISTERED','UNREGISTERED','EXPIRED','UNKNOWN')),
  health              text NOT NULL DEFAULT 'UNKNOWN' CHECK (health IN ('OK','DEGRADED','FAULT','UNKNOWN')),
  last_registered_at  timestamptz,
  last_seen_at        timestamptz,
  contact_ip          inet,
  contact_port        integer,
  user_agent          text,
  -- Optional external CCTV/VMS context (no video is handled by this system).
  vms_camera_ref      text,
  vms_deep_link       text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz,
  version             integer NOT NULL DEFAULT 1,
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, region_id) REFERENCES regions (organization_id, id)
);
CREATE UNIQUE INDEX ux_atm_code ON atm_devices (organization_id, atm_code) WHERE deleted_at IS NULL;
CREATE INDEX ix_atm_org_region ON atm_devices (organization_id, region_id) WHERE deleted_at IS NULL;
CREATE INDEX ix_atm_org_reg_status ON atm_devices (organization_id, registration_status) WHERE deleted_at IS NULL;
CREATE INDEX ix_atm_search ON atm_devices USING gin (to_tsvector('simple', atm_code || ' ' || name || ' ' || coalesce(city,'') || ' ' || coalesce(site,'')));

CREATE TABLE atm_group_members (
  organization_id uuid NOT NULL,
  atm_id          uuid NOT NULL,
  group_id        uuid NOT NULL,
  PRIMARY KEY (atm_id, group_id),
  FOREIGN KEY (organization_id, atm_id) REFERENCES atm_devices (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, group_id) REFERENCES atm_groups (organization_id, id)
);
CREATE INDEX ix_group_members_group ON atm_group_members (group_id);

-- SIP digest identities for ATMs and operator WebRTC endpoints.
-- Only HA1 = MD5(username:realm:password) is stored; the password itself is
-- shown once at provisioning and never persisted. HA1 is still credential-
-- equivalent for its realm, so in production the API DB role has no SELECT on
-- the ha1 column (see infra/postgres/roles.sql); only the registrar role can
-- read it, through the kamailio_subscriber view.
CREATE TABLE sip_identities (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  kind            text NOT NULL CHECK (kind IN ('ATM','OPERATOR')),
  atm_id          uuid,
  operator_id     uuid,
  sip_username    text NOT NULL,
  realm           text NOT NULL,
  ha1             char(32) NOT NULL,
  credential_version integer NOT NULL DEFAULT 1,
  rotated_at      timestamptz NOT NULL DEFAULT now(),
  enabled         boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  version         integer NOT NULL DEFAULT 1,
  CHECK ((kind = 'ATM' AND atm_id IS NOT NULL AND operator_id IS NULL) OR (kind = 'OPERATOR' AND operator_id IS NOT NULL AND atm_id IS NULL)),
  FOREIGN KEY (organization_id, atm_id) REFERENCES atm_devices (organization_id, id),
  FOREIGN KEY (organization_id, operator_id) REFERENCES operators (organization_id, id)
);
CREATE UNIQUE INDEX ux_sip_username ON sip_identities (realm, sip_username);
CREATE UNIQUE INDEX ux_sip_atm ON sip_identities (atm_id) WHERE atm_id IS NOT NULL;
CREATE UNIQUE INDEX ux_sip_operator ON sip_identities (operator_id) WHERE operator_id IS NOT NULL;

CREATE VIEW kamailio_subscriber AS
  SELECT s.sip_username AS username, s.realm AS domain, s.ha1, s.kind, s.organization_id
    FROM sip_identities s
    LEFT JOIN atm_devices a ON a.id = s.atm_id
   WHERE s.enabled AND (s.atm_id IS NULL OR (a.status = 'ACTIVE' AND a.deleted_at IS NULL));

-- ---------------------------------------------------------------- assignments
CREATE TABLE atm_assignments (
  atm_id              uuid PRIMARY KEY,
  organization_id     uuid NOT NULL,
  primary_operator_id uuid,
  backup_operator_id  uuid,
  shift_id            uuid,
  updated_by          uuid REFERENCES users(id),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  version             integer NOT NULL DEFAULT 1,
  CHECK (primary_operator_id IS DISTINCT FROM backup_operator_id OR primary_operator_id IS NULL),
  FOREIGN KEY (organization_id, atm_id) REFERENCES atm_devices (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, primary_operator_id) REFERENCES operators (organization_id, id),
  FOREIGN KEY (organization_id, backup_operator_id) REFERENCES operators (organization_id, id),
  FOREIGN KEY (organization_id, shift_id) REFERENCES shifts (organization_id, id)
);
CREATE INDEX ix_assign_primary ON atm_assignments (primary_operator_id);
CREATE INDEX ix_assign_backup ON atm_assignments (backup_operator_id);

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE assignment_overrides (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  atm_id          uuid NOT NULL,
  operator_id     uuid NOT NULL,
  reason          text NOT NULL CHECK (length(trim(reason)) >= 5),
  created_by      uuid NOT NULL REFERENCES users(id),
  starts_at       timestamptz NOT NULL,
  ends_at         timestamptz NOT NULL,
  revoked_at      timestamptz,
  revoked_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  CHECK (ends_at - starts_at <= interval '7 days'),
  FOREIGN KEY (organization_id, atm_id) REFERENCES atm_devices (organization_id, id),
  FOREIGN KEY (organization_id, operator_id) REFERENCES operators (organization_id, id),
  -- Prevent conflicting overrides: at most one live override per ATM at any instant.
  EXCLUDE USING gist (atm_id WITH =, tstzrange(starts_at, ends_at) WITH &&) WHERE (revoked_at IS NULL)
);
CREATE INDEX ix_override_atm_time ON assignment_overrides (atm_id, ends_at) WHERE revoked_at IS NULL;

CREATE TABLE routing_policies (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organizations(id),
  scope               text NOT NULL CHECK (scope IN ('ORGANIZATION','REGION','GROUP')),
  scope_id            uuid,                       -- region or group id; NULL for ORGANIZATION
  allow_dynamic       boolean NOT NULL DEFAULT true,
  require_active_shift boolean NOT NULL DEFAULT true,
  same_region_only    boolean NOT NULL DEFAULT true,
  prefer_group_match  boolean NOT NULL DEFAULT true,
  allow_queue_when_busy boolean NOT NULL DEFAULT true,
  queue_timeout_seconds integer NOT NULL DEFAULT 300 CHECK (queue_timeout_seconds BETWEEN 10 AND 3600),
  allow_preemption    boolean NOT NULL DEFAULT false CHECK (allow_preemption = false), -- V1.1: no preemption
  updated_by          uuid REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  version             integer NOT NULL DEFAULT 1,
  CHECK ((scope = 'ORGANIZATION') = (scope_id IS NULL))
);
CREATE UNIQUE INDEX ux_routing_scope ON routing_policies (organization_id, scope, coalesce(scope_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- ---------------------------------------------------------------- calls
CREATE TABLE call_sessions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL,
  atm_id            uuid NOT NULL,
  operator_id       uuid NOT NULL,
  initiated_by      uuid NOT NULL REFERENCES users(id),
  request_id        text NOT NULL,              -- client idempotency key
  correlation_id    uuid NOT NULL DEFAULT gen_random_uuid(),
  state             text NOT NULL CHECK (state IN ('IDLE','REQUESTED','VALIDATING','RESERVED','DIALING','RINGING','CONNECTED','TERMINATING','COMPLETED','BUSY','FAILED','TIMEOUT','CANCELLED')),
  priority          text NOT NULL DEFAULT 'P3' CHECK (priority IN ('P1','P2','P3','P4')),
  routing_decision  text NOT NULL CHECK (routing_decision IN ('OVERRIDE','PRIMARY','BACKUP','DYNAMIC','SUPERVISOR','ANY')),
  routing_trace     jsonb,
  queue_item_id     uuid,
  dial_token_hash   bytea,                      -- one-time token the browser presents in its INVITE
  operator_channel_id text,                     -- ARI channel ids
  atm_channel_id    text,
  bridge_id         text,
  media_node        text,                       -- Asterisk node that owns the call
  api_node          text,
  sip_code          integer,
  failure_reason    text,
  hangup_by         text CHECK (hangup_by IN ('OPERATOR','ATM','SUPERVISOR','SYSTEM')),
  requested_at      timestamptz NOT NULL DEFAULT now(),
  reserved_at       timestamptz,
  dialing_at        timestamptz,
  ringing_at        timestamptz,
  answered_at       timestamptz,
  ended_at          timestamptz,
  state_changed_at  timestamptz NOT NULL DEFAULT now(),
  duration_ms       integer GENERATED ALWAYS AS (
                      CASE WHEN answered_at IS NOT NULL AND ended_at IS NOT NULL
                           THEN (extract(epoch FROM (ended_at - answered_at)) * 1000)::integer END) STORED,
  version           integer NOT NULL DEFAULT 1,
  FOREIGN KEY (organization_id, atm_id) REFERENCES atm_devices (organization_id, id),
  FOREIGN KEY (organization_id, operator_id) REFERENCES operators (organization_id, id),
  UNIQUE (operator_id, request_id)
);
-- THE concurrency guarantees. Must match ACTIVE_CALL_STATES in @wintek/shared.
CREATE UNIQUE INDEX ux_call_active_atm ON call_sessions (atm_id)
  WHERE state IN ('RESERVED','DIALING','RINGING','CONNECTED','TERMINATING');
CREATE UNIQUE INDEX ux_call_active_operator ON call_sessions (operator_id)
  WHERE state IN ('RESERVED','DIALING','RINGING','CONNECTED','TERMINATING');
CREATE INDEX ix_call_org_time ON call_sessions (organization_id, requested_at DESC);
CREATE INDEX ix_call_atm_time ON call_sessions (atm_id, requested_at DESC);
CREATE INDEX ix_call_operator_time ON call_sessions (operator_id, requested_at DESC);
CREATE INDEX ix_call_open_state ON call_sessions (state, state_changed_at)
  WHERE state NOT IN ('COMPLETED','BUSY','FAILED','TIMEOUT','CANCELLED');
CREATE UNIQUE INDEX ux_call_atm_channel ON call_sessions (atm_channel_id) WHERE atm_channel_id IS NOT NULL;
CREATE UNIQUE INDEX ux_call_operator_channel ON call_sessions (operator_channel_id) WHERE operator_channel_id IS NOT NULL;

CREATE TABLE call_events (
  id              bigserial PRIMARY KEY,
  call_id         uuid NOT NULL REFERENCES call_sessions(id),
  organization_id uuid NOT NULL,
  from_state      text,
  to_state        text NOT NULL,
  source          text NOT NULL CHECK (source IN ('API','ARI','SWEEPER','QUEUE','SUPERVISOR')),
  sip_code        integer,
  detail          jsonb,
  occurred_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_call_events_call ON call_events (call_id, id);

CREATE TABLE call_queue (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL,
  atm_id             uuid NOT NULL,
  priority           text NOT NULL CHECK (priority IN ('P1','P2','P3','P4')),
  state              text NOT NULL DEFAULT 'WAITING' CHECK (state IN ('WAITING','OFFERED','FULFILLED','CANCELLED','EXPIRED')),
  source             text NOT NULL CHECK (source IN ('OPERATOR','SUPERVISOR','INTEGRATION')),
  requested_by       uuid REFERENCES users(id),
  -- Requester asked to be the one who calls when the ATM frees up.
  preferred_operator_id uuid,
  offered_operator_id uuid,
  offered_at         timestamptz,
  offer_expires_at   timestamptz,
  declined_by        uuid[] NOT NULL DEFAULT '{}',
  -- Set when routing found nobody eligible and supervisors were alerted; the
  -- request stays WAITING so it is still dispatched when someone frees up.
  escalated_at       timestamptz,
  reason             text,
  external_ref       text,                    -- VMS incident id etc.
  enqueued_at        timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,
  closed_at          timestamptz,
  close_reason       text,
  fulfilled_call_id  uuid REFERENCES call_sessions(id),
  version            integer NOT NULL DEFAULT 1,
  FOREIGN KEY (organization_id, atm_id) REFERENCES atm_devices (organization_id, id),
  FOREIGN KEY (organization_id, preferred_operator_id) REFERENCES operators (organization_id, id),
  FOREIGN KEY (organization_id, offered_operator_id) REFERENCES operators (organization_id, id)
);
-- One open request per ATM; a more urgent request upgrades the existing one.
CREATE UNIQUE INDEX ux_queue_open_atm ON call_queue (atm_id) WHERE state IN ('WAITING','OFFERED');
CREATE INDEX ix_queue_open ON call_queue (organization_id, priority, enqueued_at) WHERE state IN ('WAITING','OFFERED');

-- ---------------------------------------------------------------- events & audit
CREATE TABLE device_events (
  id              bigserial PRIMARY KEY,
  organization_id uuid NOT NULL,
  atm_id          uuid NOT NULL,
  type            text NOT NULL,              -- REGISTERED, UNREGISTERED, EXPIRED, FAULT, FAULT_CLEARED, FIRMWARE_CHANGED, CREDENTIAL_ROTATED
  severity        text NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warning','critical')),
  detail          jsonb,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, atm_id) REFERENCES atm_devices (organization_id, id)
);
CREATE INDEX ix_device_events_atm ON device_events (atm_id, occurred_at DESC);
CREATE INDEX ix_device_events_org ON device_events (organization_id, occurred_at DESC);

CREATE TABLE audit_logs (
  id              bigserial PRIMARY KEY,
  organization_id uuid,                       -- NULL for platform-level events
  actor_user_id   uuid REFERENCES users(id),
  actor_username  text,                       -- denormalised; survives user deletion
  action          text NOT NULL,              -- e.g. auth.login, atm.credentials.rotated
  entity_type     text,
  entity_id       text,
  outcome         text NOT NULL DEFAULT 'SUCCESS' CHECK (outcome IN ('SUCCESS','FAILURE','DENIED')),
  ip              inet,
  user_agent      text,
  correlation_id  text,
  detail          jsonb,                      -- redacted before insert; no secrets
  occurred_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_audit_org_time ON audit_logs (organization_id, occurred_at DESC);
CREATE INDEX ix_audit_action ON audit_logs (action, occurred_at DESC);
CREATE INDEX ix_audit_entity ON audit_logs (entity_type, entity_id);
CREATE INDEX ix_audit_actor ON audit_logs (actor_user_id, occurred_at DESC);

-- Audit rows are immutable.
CREATE OR REPLACE FUNCTION audit_immutable() RETURNS trigger AS $$
BEGIN
  IF current_setting('wintek.retention_job', true) = 'on' AND TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_logs is append-only';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_audit_immutable BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_immutable();

CREATE TABLE system_settings (
  organization_id uuid REFERENCES organizations(id),   -- NULL = platform default
  key             text NOT NULL,
  value           jsonb NOT NULL,
  updated_by      uuid REFERENCES users(id),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  version         integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX ux_settings ON system_settings (coalesce(organization_id, '00000000-0000-0000-0000-000000000000'::uuid), key);

-- ---------------------------------------------------------------- triggers
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['organizations','regions','atm_groups','users','operators','operator_presence','shifts',
                           'atm_devices','sip_identities','atm_assignments','routing_policies','system_settings']
  LOOP
    EXECUTE format('CREATE TRIGGER trg_touch_%1$s BEFORE UPDATE ON %1$I FOR EACH ROW EXECUTE FUNCTION touch_row()', t);
  END LOOP;
END $$;

-- call_sessions and call_queue have no updated_at; they only bump version.
CREATE OR REPLACE FUNCTION bump_version() RETURNS trigger AS $$
BEGIN NEW.version := OLD.version + 1; RETURN NEW; END $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_version_call_sessions BEFORE UPDATE ON call_sessions FOR EACH ROW EXECUTE FUNCTION bump_version();
CREATE TRIGGER trg_version_call_queue BEFORE UPDATE ON call_queue FOR EACH ROW EXECUTE FUNCTION bump_version();
