-- Production database roles (run once as a superuser after migrations).
-- Least privilege: the API can write HA1 but never read it back; only the
-- registrars can read it, and only through their views.

CREATE ROLE wintek_api LOGIN PASSWORD :'api_password';
CREATE ROLE asterisk_ro LOGIN PASSWORD :'asterisk_password';
CREATE ROLE kamailio_ro LOGIN PASSWORD :'kamailio_password';
CREATE ROLE kamailio_rw_location LOGIN PASSWORD :'kamailio_location_password';

GRANT USAGE ON SCHEMA public TO wintek_api, asterisk_ro, kamailio_ro;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO wintek_api;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO wintek_api;

-- Column-level: no SELECT on sip_identities.ha1 for the API.
REVOKE SELECT ON sip_identities FROM wintek_api;
GRANT SELECT (id, organization_id, kind, atm_id, operator_id, sip_username, realm, credential_version, rotated_at, enabled, created_at, updated_at, version)
  ON sip_identities TO wintek_api;
-- INSERT ... ON CONFLICT DO UPDATE needs SELECT on conflict target columns only (atm_id/operator_id), granted above.

-- Audit log: append-only for the application. The retention job then needs
-- its own role with DELETE (it also sets wintek.retention_job='on', which the
-- immutability trigger requires).
REVOKE UPDATE, DELETE ON audit_logs FROM wintek_api;
CREATE ROLE wintek_retention LOGIN PASSWORD :'retention_password';
GRANT SELECT, DELETE ON audit_logs, device_events, call_events, call_sessions, call_queue, refresh_tokens TO wintek_retention;
GRANT UPDATE (fulfilled_call_id) ON call_queue TO wintek_retention;

GRANT SELECT ON ast_ps_endpoints, ast_ps_auths, ast_ps_aors TO asterisk_ro;
GRANT SELECT ON kamailio_subscriber TO kamailio_ro;
-- Kamailio usrloc table (create with kamailio's own schema script) is owned by kamailio_rw_location.
