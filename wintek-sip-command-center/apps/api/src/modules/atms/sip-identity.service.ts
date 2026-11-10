import { Injectable } from '@nestjs/common';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { Queryable } from '../../common/db/database.service';
import { config } from '../../config';

export interface IssuedSipCredential {
  sipUsername: string;
  /** Plaintext - returned exactly once to the caller, never stored or logged. */
  sipPassword: string;
  realm: string;
  domain: string;
  credentialVersion: number;
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

/** 24 chars from a 57-symbol alphabet ~ 140 bits; no ambiguous characters for manual entry. */
export function generateSipPassword(len = 24): string {
  const out: string[] = [];
  while (out.length < len) {
    for (const b of randomBytes(len * 2)) {
      if (b < 228 && out.length < len) out.push(ALPHABET[b % 57]!); // 228 = 4*57, avoids modulo bias
    }
  }
  return out.join('');
}

export const sipHa1 = (username: string, realm: string, password: string) =>
  createHash('md5').update(`${username}:${realm}:${password}`).digest('hex');

export const atmSipUsername = (atmCode: string) => `atm-${atmCode.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`;
export const operatorSipUsername = (username: string) => `op-${username.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`;

/**
 * SIP digest identities. Only HA1 is stored. Both registrars can verify digest
 * auth from HA1 alone (Kamailio auth_db with calculate_ha1=0, Asterisk PJSIP
 * auth_type=md5), so no reversible secret ever exists server-side.
 */
@Injectable()
export class SipIdentityService {
  async issue(
    q: Queryable,
    target: { kind: 'ATM'; atmId: string } | { kind: 'OPERATOR'; operatorId: string },
    organizationId: string,
    sipUsername: string,
  ): Promise<IssuedSipCredential> {
    const realm = config().SIP_REALM;
    const password = generateSipPassword();
    const ha1 = sipHa1(sipUsername, realm, password);
    const col = target.kind === 'ATM' ? 'atm_id' : 'operator_id';
    const id = target.kind === 'ATM' ? target.atmId : target.operatorId;
    const r = await q.query(
      `INSERT INTO sip_identities (organization_id, kind, ${col}, sip_username, realm, ha1)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (${col}) WHERE ${col} IS NOT NULL DO UPDATE
         SET ha1 = EXCLUDED.ha1, credential_version = sip_identities.credential_version + 1, rotated_at = now(), enabled = true
       RETURNING credential_version, sip_username`,
      [organizationId, target.kind, id, sipUsername, realm, ha1],
    );
    return {
      sipUsername: r.rows[0].sip_username,
      sipPassword: password,
      realm,
      domain: config().SIP_DOMAIN,
      credentialVersion: r.rows[0].credential_version,
    };
  }

  async disable(q: Queryable, atmId: string) {
    await q.query(`UPDATE sip_identities SET enabled = false WHERE atm_id = $1`, [atmId]);
  }
}

/** TURN REST API credentials (coturn use-auth-secret): short-lived, no TURN user database. */
export function turnCredentials(subject: string, ttlSeconds = 3600) {
  const { TURN_URL, TURN_SECRET } = config();
  if (!TURN_URL || !TURN_SECRET) return null;
  const username = `${Math.floor(Date.now() / 1000) + ttlSeconds}:${subject}`;
  const credential = createHmac('sha1', TURN_SECRET).update(username).digest('base64');
  return { urls: TURN_URL.split(','), username, credential };
}
