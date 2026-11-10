/**
 * Development device simulator: keeps a fleet of ATM intercoms "registered" by
 * sending registration refreshes to the API's registrar webhook, exactly as
 * Kamailio would in stage 2. A small share of devices flap offline/online.
 *
 *   DATABASE_URL=... API=http://localhost:3000 npx ts-node --transpile-only scripts/device-simulator.ts
 *
 * Env: ONLINE_RATIO (default 0.94), REFRESH_SECONDS (default 240), FLAP_PER_MIN (default 6)
 */
import { Client } from 'pg';

const API = process.env.API ?? 'http://localhost:3000';
const SECRET = process.env.INTERNAL_WEBHOOK_SECRET ?? 'dev-internal-secret';
const ONLINE = Number(process.env.ONLINE_RATIO ?? 0.94);
const REFRESH_S = Number(process.env.REFRESH_SECONDS ?? 240);
const FLAP_PER_MIN = Number(process.env.FLAP_PER_MIN ?? 6);

async function send(username: string, state: 'REGISTERED' | 'UNREGISTERED', i: number) {
  const r = await fetch(`${API}/api/v1/internal/sip/registrations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Wintek-Internal-Secret': SECRET },
    body: JSON.stringify({ username, state, contactIp: `10.${20 + (i % 4)}.${Math.floor(i / 250) % 255}.${(i % 250) + 2}`, contactPort: 5060, userAgent: 'WintekIntercom/1.4.2 (ESP32-S3)' }),
  });
  if (!r.ok && r.status !== 204) throw new Error(`${r.status} ${await r.text()}`);
}

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const rows = (await db.query<{ sip_username: string }>(`SELECT sip_username FROM sip_identities WHERE kind = 'ATM' AND enabled ORDER BY sip_username`)).rows;
  await db.end();
  const fleet = rows.map((r, i) => ({ user: r.sip_username, i, online: Math.random() < ONLINE }));
  console.log(`simulating ${fleet.length} devices, ${fleet.filter((d) => d.online).length} online, refresh every ${REFRESH_S}s`);

  // Initial registration burst, throttled.
  for (const d of fleet) if (d.online) await send(d.user, 'REGISTERED', d.i).catch((e) => console.error(e.message));
  console.log('initial registrations sent');

  // Spread refreshes evenly across the refresh period.
  const perTick = Math.max(1, Math.ceil(fleet.length / REFRESH_S));
  let cursor = 0;
  setInterval(() => {
    for (let k = 0; k < perTick; k++) {
      const d = fleet[cursor++ % fleet.length]!;
      if (d.online) void send(d.user, 'REGISTERED', d.i).catch(() => undefined);
    }
  }, 1000);

  // Flaps: some devices drop and some come back.
  setInterval(() => {
    const d = fleet[Math.floor(Math.random() * fleet.length)]!;
    d.online = !d.online;
    void send(d.user, d.online ? 'REGISTERED' : 'UNREGISTERED', d.i).catch(() => undefined);
  }, 60_000 / Math.max(1, FLAP_PER_MIN));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
