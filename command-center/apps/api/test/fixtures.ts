import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { Role } from '@wintek/shared';

export const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
export const describeDb = DB_URL ? describe : describe.skip;

export interface OrgFixture {
  orgId: string;
  regionId: string;
  otherRegionId: string;
  atms: string[];
  offlineAtm: string;
  otherRegionAtm: string;
  operators: { userId: string; operatorId: string; username: string; roles: Role[] }[];
}

/** Self-contained tenant with its own region, ATMs and operators (unique codes per run). */
export async function createOrgFixture(pool: Pool, nOperators = 3, nAtms = 4): Promise<OrgFixture> {
  const tag = randomUUID().slice(0, 8);
  const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows;
  const [org] = await q(`INSERT INTO organizations (code, name) VALUES ($1, $2) RETURNING id`, [`T${tag}`, `Test ${tag}`]);
  const orgId = org.id;
  const [region] = await q(`INSERT INTO regions (organization_id, code, name) VALUES ($1,'R1','Region 1') RETURNING id`, [orgId]);
  const [other] = await q(`INSERT INTO regions (organization_id, code, name) VALUES ($1,'R2','Region 2') RETURNING id`, [orgId]);
  const [shift] = await q(
    `INSERT INTO shifts (organization_id, name, days_of_week, start_time, end_time, timezone) VALUES ($1,'All day','{1,2,3,4,5,6,7}','00:00','23:59','UTC') RETURNING id`,
    [orgId],
  );
  const mkAtm = async (i: number, regionId: string, reg = 'REGISTERED') => {
    const code = `ATM-${tag}-${i}`;
    const [a] = await q(
      `INSERT INTO atm_devices (organization_id, atm_code, name, region_id, registration_status, health, last_seen_at) VALUES ($1,$2,$3,$4,$5,'OK',now()) RETURNING id`,
      [orgId, code, `ATM ${i}`, regionId, reg],
    );
    await q(`INSERT INTO sip_identities (organization_id, kind, atm_id, sip_username, realm, ha1) VALUES ($1,'ATM',$2,$3,'test',$4)`, [orgId, a.id, `atm-${code.toLowerCase()}`, '0'.repeat(32)]);
    await q(`INSERT INTO atm_assignments (atm_id, organization_id) VALUES ($1,$2)`, [a.id, orgId]);
    return a.id as string;
  };
  const atms: string[] = [];
  for (let i = 0; i < nAtms; i++) atms.push(await mkAtm(i, region.id));
  const offlineAtm = await mkAtm(100, region.id, 'UNREGISTERED');
  const otherRegionAtm = await mkAtm(200, other.id);

  const operators: OrgFixture['operators'] = [];
  for (let i = 0; i < nOperators; i++) {
    const username = `op${i}-${tag}`;
    const roles: Role[] = i === 0 ? ['SUPERVISOR'] : ['OPERATOR'];
    const [u] = await q(`INSERT INTO users (organization_id, username, display_name, password_hash) VALUES ($1,$2,$3,'x') RETURNING id`, [orgId, username, `Operator ${i}`]);
    for (const r of roles) await q(`INSERT INTO user_roles (user_id, role_code) VALUES ($1,$2)`, [u.id, r]);
    const [o] = await q(`INSERT INTO operators (organization_id, user_id) VALUES ($1,$2) RETURNING id`, [orgId, u.id]);
    await q(`INSERT INTO operator_regions (organization_id, operator_id, region_id) VALUES ($1,$2,$3)`, [orgId, o.id, region.id]);
    await q(`INSERT INTO shift_members (organization_id, shift_id, operator_id, valid_from) VALUES ($1,$2,$3,current_date - 1)`, [orgId, shift.id, o.id]);
    await q(`INSERT INTO sip_identities (organization_id, kind, operator_id, sip_username, realm, ha1) VALUES ($1,'OPERATOR',$2,$3,'test',$4)`, [orgId, o.id, `op-${username}`, '0'.repeat(32)]);
    await q(
      `INSERT INTO operator_presence (operator_id, organization_id, selected, effective, sip_registered, last_heartbeat_at) VALUES ($1,$2,'AVAILABLE','AVAILABLE',true,now())`,
      [o.id, orgId],
    );
    operators.push({ userId: u.id, operatorId: o.id, username, roles });
  }
  return { orgId, regionId: region.id, otherRegionId: other.id, atms, offlineAtm, otherRegionAtm, operators };
}

export async function tokenFor(app: INestApplication, f: OrgFixture, idx: number) {
  const o = f.operators[idx]!;
  return app.get(JwtService).signAsync({ sub: o.userId, usr: o.username, org: f.orgId, roles: o.roles, op: o.operatorId, typ: 'access' });
}

export async function freshHeartbeats(pool: Pool, f: OrgFixture) {
  await pool.query(`UPDATE operator_presence SET last_heartbeat_at = now(), selected = 'AVAILABLE', sip_registered = true WHERE organization_id = $1`, [f.orgId]);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 6000): Promise<T> {
  const t = Date.now();
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() - t > timeoutMs) throw new Error(`waitFor timed out; last value ${JSON.stringify(v)}`);
    await sleep(100);
  }
}
