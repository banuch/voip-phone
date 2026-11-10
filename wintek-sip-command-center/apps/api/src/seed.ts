/**
 * Development seed: one demo bank organization with regions, groups, shifts,
 * operators and N ATMs (SEED_ATMS, default 2000; try 20000 for scale tests),
 * plus 7 days of synthetic call metadata for the charts.
 * Refuses to run in production. Re-running wipes and recreates the demo org.
 */
import { Client } from 'pg';
import { config } from './config';
import { hashPassword } from './modules/auth/password';
import { syncRbac } from './modules/auth/rbac-sync.service';
import { atmSipUsername, generateSipPassword, operatorSipUsername, sipHa1 } from './modules/atms/sip-identity.service';

const DEMO_PASSWORD = process.env.SEED_PASSWORD ?? 'Wintek#Demo2026';
const N_ATMS = Number(process.env.SEED_ATMS ?? 2000);

const REGIONS = [
  ['NORTH', 'North Zone', ['Delhi', 'Chandigarh', 'Lucknow', 'Jaipur']],
  ['WEST', 'West Zone', ['Mumbai', 'Pune', 'Ahmedabad', 'Surat']],
  ['SOUTH', 'South Zone', ['Chennai', 'Bengaluru', 'Hyderabad', 'Kochi']],
  ['EAST', 'East Zone', ['Kolkata', 'Bhubaneswar', 'Patna', 'Guwahati']],
] as const;
const STATES: Record<string, string> = {
  Delhi: 'Delhi', Chandigarh: 'Punjab', Lucknow: 'Uttar Pradesh', Jaipur: 'Rajasthan', Mumbai: 'Maharashtra', Pune: 'Maharashtra',
  Ahmedabad: 'Gujarat', Surat: 'Gujarat', Chennai: 'Tamil Nadu', Bengaluru: 'Karnataka', Hyderabad: 'Telangana', Kochi: 'Kerala',
  Kolkata: 'West Bengal', Bhubaneswar: 'Odisha', Patna: 'Bihar', Guwahati: 'Assam',
};
const GROUPS = [
  ['OFFSITE', 'Off-site ATMs'],
  ['ONSITE', 'Branch ATMs'],
  ['HIGHRISK', 'High-risk locations'],
  ['HIGHWAY', 'Highway kiosks'],
] as const;
const SITES = ['Main Road', 'Market', 'Railway Station', 'Mall', 'Bus Stand', 'Hospital', 'University', 'Airport', 'Industrial Area', 'Petrol Pump'];

let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = <T>(a: readonly T[]) => a[Math.floor(rnd() * a.length)]!;

async function main() {
  if (config().NODE_ENV === 'production') throw new Error('Refusing to seed a production database');
  const c = new Client({ connectionString: config().DATABASE_URL });
  await c.connect();
  const realm = config().SIP_REALM;
  const hash = await hashPassword(DEMO_PASSWORD);
  try {
    await c.query('BEGIN');
    await syncRbac(c);

    const old = await c.query(`SELECT id FROM organizations WHERE code = 'DEMOBANK'`);
    if (old.rows[0]) {
      const id = old.rows[0].id;
      console.log('removing previous demo organization');
      await c.query(`SET LOCAL wintek.retention_job = 'on'`);
      for (const sql of [
        `DELETE FROM call_events WHERE organization_id = $1`,
        `UPDATE call_queue SET fulfilled_call_id = NULL WHERE organization_id = $1`,
        `DELETE FROM call_sessions WHERE organization_id = $1`,
        `DELETE FROM call_queue WHERE organization_id = $1`,
        `DELETE FROM device_events WHERE organization_id = $1`,
        `DELETE FROM audit_logs WHERE organization_id = $1 OR actor_user_id IN (SELECT id FROM users WHERE organization_id = $1)`,
        `DELETE FROM assignment_overrides WHERE organization_id = $1`,
        `DELETE FROM atm_assignments WHERE organization_id = $1`,
        `DELETE FROM sip_identities WHERE organization_id = $1`,
        `DELETE FROM atm_group_members WHERE organization_id = $1`,
        `DELETE FROM atm_devices WHERE organization_id = $1`,
        `DELETE FROM shift_members WHERE organization_id = $1`,
        `DELETE FROM shifts WHERE organization_id = $1`,
        `DELETE FROM operator_presence WHERE organization_id = $1`,
        `DELETE FROM operator_regions WHERE organization_id = $1`,
        `DELETE FROM operator_groups WHERE organization_id = $1`,
        `DELETE FROM operators WHERE organization_id = $1`,
        `DELETE FROM routing_policies WHERE organization_id = $1`,
        `DELETE FROM system_settings WHERE organization_id = $1`,
        `DELETE FROM users WHERE organization_id = $1`,
        `DELETE FROM atm_groups WHERE organization_id = $1`,
        `DELETE FROM regions WHERE organization_id = $1`,
        `DELETE FROM organizations WHERE id = $1`,
      ]) await c.query(sql, [id]);
    }

    // Platform super admin (no organization).
    await c.query(
      `INSERT INTO users (organization_id, username, display_name, password_hash) VALUES (NULL, 'superadmin', 'Platform Super Admin', $1)
       ON CONFLICT (username) WHERE deleted_at IS NULL DO UPDATE SET password_hash = EXCLUDED.password_hash, status = 'ACTIVE', failed_logins = 0, locked_until = NULL`,
      [hash],
    );
    await c.query(`INSERT INTO user_roles (user_id, role_code) SELECT id, 'SUPER_ADMIN' FROM users WHERE username = 'superadmin' ON CONFLICT DO NOTHING`);

    const org = (await c.query(`INSERT INTO organizations (code, name, timezone) VALUES ('DEMOBANK', 'Demo National Bank', 'Asia/Kolkata') RETURNING id`)).rows[0].id;
    await c.query(`INSERT INTO routing_policies (organization_id, scope) VALUES ($1, 'ORGANIZATION')`, [org]);

    const regionIds: Record<string, string> = {};
    for (const [code, name] of REGIONS) {
      regionIds[code] = (await c.query(`INSERT INTO regions (organization_id, code, name) VALUES ($1,$2,$3) RETURNING id`, [org, code, name])).rows[0].id;
    }
    const groupIds: Record<string, string> = {};
    for (const [code, name] of GROUPS) {
      groupIds[code] = (await c.query(`INSERT INTO atm_groups (organization_id, code, name) VALUES ($1,$2,$3) RETURNING id`, [org, code, name])).rows[0].id;
    }

    const mkUser = async (username: string, name: string, roles: string[]) => {
      const id = (await c.query(`INSERT INTO users (organization_id, username, display_name, password_hash) VALUES ($1,$2,$3,$4) RETURNING id`, [org, username, name, hash])).rows[0].id;
      for (const r of roles) await c.query(`INSERT INTO user_roles (user_id, role_code) VALUES ($1,$2)`, [id, r]);
      return id as string;
    };
    await mkUser('orgadmin', 'Org Administrator', ['ORG_ADMIN']);
    await mkUser('auditor', 'Compliance Auditor', ['AUDITOR']);

    // 24x7 shift so seeded operators are on duty whenever you try the demo.
    const shift = (await c.query(
      `INSERT INTO shifts (organization_id, name, days_of_week, start_time, end_time, timezone) VALUES ($1, 'Round the clock', '{1,2,3,4,5,6,7}', '00:00', '23:59', 'Asia/Kolkata') RETURNING id`,
      [org],
    )).rows[0].id;

    const FIRST = ['Aarav', 'Diya', 'Kabir', 'Meera', 'Rohan', 'Isha', 'Vikram', 'Anaya', 'Arjun', 'Kavya', 'Neel', 'Priya', 'Sameer', 'Tara', 'Yash', 'Zoya'];
    const LAST = ['Sharma', 'Iyer', 'Khan', 'Patel', 'Das', 'Reddy', 'Nair', 'Singh'];
    const operators: { id: string; region: string }[] = [];
    const mkOperator = async (username: string, name: string, role: string, regions: string[], groups: string[] = []) => {
      const uid = await mkUser(username, name, [role]);
      const opId = (await c.query(`INSERT INTO operators (organization_id, user_id, employee_code) VALUES ($1,$2,$3) RETURNING id`, [org, uid, username.toUpperCase()])).rows[0].id;
      for (const r of regions) await c.query(`INSERT INTO operator_regions (organization_id, operator_id, region_id) VALUES ($1,$2,$3)`, [org, opId, regionIds[r]]);
      for (const g of groups) await c.query(`INSERT INTO operator_groups (organization_id, operator_id, group_id) VALUES ($1,$2,$3)`, [org, opId, groupIds[g]]);
      await c.query(`INSERT INTO operator_presence (operator_id, organization_id) VALUES ($1,$2)`, [opId, org]);
      await c.query(`INSERT INTO shift_members (organization_id, shift_id, operator_id, valid_from) VALUES ($1,$2,$3, current_date - 1)`, [org, shift, opId]);
      const su = operatorSipUsername(username);
      await c.query(`INSERT INTO sip_identities (organization_id, kind, operator_id, sip_username, realm, ha1) VALUES ($1,'OPERATOR',$2,$3,$4,$5)`, [
        org, opId, su, realm, sipHa1(su, realm, generateSipPassword()),
      ]);
      return opId as string;
    };
    await mkOperator('supervisor', 'Shift Supervisor', 'SUPERVISOR', REGIONS.map((r) => r[0]));
    let k = 0;
    for (const [code] of REGIONS) {
      for (let i = 1; i <= 4; i++) {
        const name = `${FIRST[k % FIRST.length]} ${LAST[k % LAST.length]}`;
        const username = k === 0 ? 'operator1' : `op.${code.toLowerCase()}${i}`;
        operators.push({ id: await mkOperator(username, name, 'OPERATOR', [code]), region: code });
        k++;
      }
    }

    console.log(`creating ${N_ATMS} ATMs...`);
    const atmRows: { id: string; region: string }[] = [];
    const batch = 500;
    for (let start = 0; start < N_ATMS; start += batch) {
      const vals: unknown[] = [];
      const tuples: string[] = [];
      for (let i = start; i < Math.min(N_ATMS, start + batch); i++) {
        const [rcode, , cities] = REGIONS[i % REGIONS.length]!;
        const city = pick(cities);
        const code = `ATM-${rcode.slice(0, 2)}-${String(i + 1).padStart(5, '0')}`;
        const reg = rnd() < 0.94 ? 'REGISTERED' : rnd() < 0.5 ? 'UNREGISTERED' : 'EXPIRED';
        const health = reg !== 'REGISTERED' ? 'UNKNOWN' : rnd() < 0.015 ? 'FAULT' : rnd() < 0.02 ? 'DEGRADED' : 'OK';
        const fw = rnd() < 0.8 ? '1.4.2' : '1.3.9';
        const site = `${city} ${pick(SITES)}`;
        const b = vals.length;
        vals.push(org, code, `${site} ${i + 1}`, regionIds[rcode], STATES[city], city, site, fw, reg, health, `CAM-${code}`);
        tuples.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10},
                     CASE WHEN $${b + 9} = 'REGISTERED' THEN now() - (random() * interval '4 minutes') ELSE now() - (random() * interval '3 days') END,
                     now() - (random() * interval '20 days'), $${b + 11}, 'https://vms.example.internal/live?camera={cameraRef}')`);
      }
      const r = await c.query(
        `INSERT INTO atm_devices (organization_id, atm_code, name, region_id, state, city, site, firmware_version, registration_status, health,
                                  last_seen_at, last_registered_at, vms_camera_ref, vms_deep_link)
         VALUES ${tuples.join(',')} RETURNING id, atm_code, region_id`,
        vals,
      );
      for (const row of r.rows) {
        const region = Object.entries(regionIds).find(([, id]) => id === row.region_id)![0];
        atmRows.push({ id: row.id, region });
      }
      // SIP identities (HA1 of a random password: devices are re-provisioned via the UI for real use).
      await c.query(
        `INSERT INTO sip_identities (organization_id, kind, atm_id, sip_username, realm, ha1)
         SELECT $1, 'ATM', x.id, x.u, $2, x.h FROM unnest($3::uuid[], $4::text[], $5::text[]) AS x(id, u, h)`,
        [org, realm, r.rows.map((x) => x.id), r.rows.map((x) => atmSipUsername(x.atm_code)), r.rows.map((x) => sipHa1(atmSipUsername(x.atm_code), realm, generateSipPassword()))],
      );
    }

    // Groups and static assignments: primary/backup are operators of the ATM's region.
    for (const a of atmRows) {
      const regionOps = operators.filter((o) => o.region === a.region);
      const p = regionOps[Math.floor(rnd() * regionOps.length)]!;
      const b = regionOps.filter((o) => o.id !== p.id)[Math.floor(rnd() * (regionOps.length - 1))]!;
      await c.query(`INSERT INTO atm_assignments (atm_id, organization_id, primary_operator_id, backup_operator_id, shift_id) VALUES ($1,$2,$3,$4,$5)`, [a.id, org, p.id, b.id, shift]);
      await c.query(`INSERT INTO atm_group_members (organization_id, atm_id, group_id) VALUES ($1,$2,$3)`, [org, a.id, groupIds[rnd() < 0.6 ? 'OFFSITE' : 'ONSITE']]);
      if (rnd() < 0.1) await c.query(`INSERT INTO atm_group_members (organization_id, atm_id, group_id) VALUES ($1,$2,$3)`, [org, a.id, groupIds['HIGHRISK']]);
    }

    // 7 days of synthetic call metadata for charts and history.
    console.log('creating call history...');
    const calls = Math.min(4000, N_ATMS * 2);
    for (let i = 0; i < calls; i++) {
      const a = atmRows[Math.floor(rnd() * atmRows.length)]!;
      const op = operators.filter((o) => o.region === a.region)[Math.floor(rnd() * 4)]!;
      const uid = (await c.query(`SELECT user_id FROM operators WHERE id = $1`, [op.id])).rows[0].user_id;
      const r = rnd();
      const state = r < 0.82 ? 'COMPLETED' : r < 0.88 ? 'TIMEOUT' : r < 0.93 ? 'FAILED' : r < 0.97 ? 'CANCELLED' : 'BUSY';
      const ago = rnd() * 7 * 86_400;
      const dur = 20 + Math.floor(rnd() * 240);
      await c.query(
        `INSERT INTO call_sessions (organization_id, atm_id, operator_id, initiated_by, request_id, state, priority, routing_decision,
                                    requested_at, reserved_at, dialing_at, ringing_at, answered_at, ended_at, state_changed_at, sip_code, failure_reason, hangup_by, media_node)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'PRIMARY',
                 now() - make_interval(secs => $8), now() - make_interval(secs => $8), now() - make_interval(secs => $8 - 1),
                 now() - make_interval(secs => $8 - 2),
                 CASE WHEN $6 = 'COMPLETED' THEN now() - make_interval(secs => $8 - 3) END,
                 now() - make_interval(secs => $8 - 3 - CASE WHEN $6 = 'COMPLETED' THEN $9 ELSE 30 END),
                 now() - make_interval(secs => $8 - 3 - CASE WHEN $6 = 'COMPLETED' THEN $9 ELSE 30 END),
                 $10, $11, $12, 'asterisk-1')`,
        [org, a.id, op.id, uid, `seed-${i}`, state, rnd() < 0.05 ? 'P1' : rnd() < 0.2 ? 'P2' : 'P3', Math.floor(ago), dur,
         state === 'COMPLETED' ? 200 : state === 'TIMEOUT' ? 408 : state === 'BUSY' ? 486 : state === 'FAILED' ? 503 : 487,
         state === 'TIMEOUT' ? 'ATM did not answer' : state === 'FAILED' ? 'media node unreachable' : null,
         state === 'COMPLETED' ? (rnd() < 0.9 ? 'OPERATOR' : 'ATM') : null],
      );
    }
    // A few device events for the activity feed.
    await c.query(
      `INSERT INTO device_events (organization_id, atm_id, type, severity, occurred_at, detail)
       SELECT organization_id, id, CASE WHEN registration_status = 'REGISTERED' THEN 'REGISTERED' ELSE registration_status END,
              CASE WHEN registration_status = 'REGISTERED' THEN 'info' ELSE 'warning' END, last_seen_at, '{"source":"seed"}'
         FROM atm_devices WHERE organization_id = $1 ORDER BY random() LIMIT 400`,
      [org],
    );
    await c.query(
      `INSERT INTO device_events (organization_id, atm_id, type, severity, occurred_at, detail)
       SELECT organization_id, id, 'FAULT', 'critical', now() - random() * interval '12 hours', '{"reason":"speaker amplifier not detected"}'
         FROM atm_devices WHERE organization_id = $1 AND health = 'FAULT'`,
      [org],
    );
    await c.query('COMMIT');
    console.log(`\nSeeded organization DEMOBANK with ${N_ATMS} ATMs and ${operators.length + 1} operators.`);
    console.log(`Sign in with any of: superadmin, orgadmin, supervisor, operator1, auditor  /  password: ${DEMO_PASSWORD}`);
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
