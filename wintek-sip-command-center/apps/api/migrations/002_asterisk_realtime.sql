-- Stage 1 (Asterisk is the registrar): read-only PJSIP realtime views over
-- sip_identities, so Asterisk authenticates ATMs and operator browsers from
-- the same single credential store the API manages. Asterisk's sorcery maps
-- ps_endpoints / ps_auths / ps_aors to these views via res_config_pgsql
-- (infra/asterisk/sorcery.conf, extconfig.conf). Contacts stay in Asterisk's
-- own astdb (not written here).
--
-- Stage 2 (Kamailio is the registrar) uses kamailio_subscriber instead and
-- ATM endpoints are NOT exposed to Asterisk, so the two never both act as
-- registrar for the same identity. The deployment chooses one by which views
-- the registrar is pointed at; ATM_DIAL_MODE in the API must match.

CREATE VIEW ast_ps_endpoints AS
  SELECT s.sip_username::text                         AS id,
         CASE WHEN s.kind = 'OPERATOR' THEN 'transport-wss' ELSE 'transport-udp' END AS transport,
         s.sip_username::text                         AS aors,
         s.sip_username::text                         AS auth,
         CASE WHEN s.kind = 'OPERATOR' THEN 'operators' ELSE 'atms' END AS context,
         'all'::text                                  AS disallow,
         CASE WHEN s.kind = 'OPERATOR' THEN 'opus,ulaw,alaw' ELSE 'ulaw,alaw' END AS allow,
         CASE WHEN s.kind = 'OPERATOR' THEN 'yes' ELSE 'no' END AS webrtc,
         'no'::text                                   AS direct_media,
         'yes'::text                                  AS rtp_symmetric,
         'yes'::text                                  AS force_rport,
         'yes'::text                                  AS rewrite_contact
         -- ATMs may never originate calls in V1.1: their context 'atms' only hangs up.
    FROM sip_identities s
    LEFT JOIN atm_devices a ON a.id = s.atm_id
   WHERE s.enabled AND (s.atm_id IS NULL OR (a.status = 'ACTIVE' AND a.deleted_at IS NULL));

CREATE VIEW ast_ps_auths AS
  SELECT s.sip_username::text AS id,
         'md5'::text          AS auth_type,
         s.sip_username::text AS username,
         s.realm::text        AS realm,
         s.ha1::text          AS md5_cred
    FROM sip_identities s
   WHERE s.enabled;

CREATE VIEW ast_ps_aors AS
  SELECT s.sip_username::text AS id,
         1                    AS max_contacts,
         'yes'::text          AS remove_existing,
         CASE WHEN s.kind = 'ATM' THEN 30 ELSE 0 END AS qualify_frequency,
         CASE WHEN s.kind = 'ATM' THEN 300 ELSE 600 END AS default_expiration
    FROM sip_identities s
   WHERE s.enabled;
