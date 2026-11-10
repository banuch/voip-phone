import { Injectable, Logger } from '@nestjs/common';
import type { AtmStatusData, DeviceHealth, DeviceRegistration } from '@wintek/shared';
import { DatabaseService } from '../../common/db/database.service';
import { EventBusService } from '../realtime/event-bus.service';

export interface RegistrationSignal {
  sipUsername: string;
  state: 'REGISTERED' | 'UNREGISTERED' | 'EXPIRED';
  contactIp?: string | null;
  contactPort?: number | null;
  userAgent?: string | null;
  source: 'asterisk' | 'kamailio' | 'sweeper';
}

/** A device that registered but hasn't refreshed for this long is EXPIRED (2 x 300 s default expiry + slack). */
const STALE_REGISTRATION = '660 seconds';

/**
 * Applies registrar signals to the device snapshot in atm_devices.
 * Writes only on change (plus a last_seen_at touch at most once a minute),
 * so 20,000 devices refreshing every 5 minutes cost ~67 cheap updates/s.
 */
@Injectable()
export class DeviceStatusService {
  private readonly log = new Logger(DeviceStatusService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly bus: EventBusService,
  ) {}

  async applyRegistration(s: RegistrationSignal): Promise<boolean> {
    const changed = await this.db.tx(async (c) => {
      const r = await c.query(
        `SELECT d.id, d.organization_id, d.registration_status, d.health, d.firmware_version, d.version
           FROM sip_identities si JOIN atm_devices d ON d.id = si.atm_id
          WHERE si.sip_username = $1 AND si.kind = 'ATM' FOR UPDATE OF d`,
        [s.sipUsername],
      );
      const d = r.rows[0];
      if (!d) return null;
      if (d.registration_status === s.state) {
        if (s.state === 'REGISTERED') {
          await c.query(
            `UPDATE atm_devices SET last_seen_at = now()
              WHERE id = $1 AND (last_seen_at IS NULL OR last_seen_at < now() - interval '60 seconds')`,
            [d.id],
          );
        }
        return null;
      }
      const fw = s.userAgent?.match(/\/(\d+\.\d+(?:\.\d+)?)/)?.[1] ?? null;
      const health: DeviceHealth = s.state === 'REGISTERED' ? (d.health === 'FAULT' ? 'FAULT' : 'OK') : 'UNKNOWN';
      const u = await c.query(
        `UPDATE atm_devices
            SET registration_status = $2, health = $3,
                last_registered_at = CASE WHEN $2 = 'REGISTERED' THEN now() ELSE last_registered_at END,
                last_seen_at = CASE WHEN $2 = 'REGISTERED' THEN now() ELSE last_seen_at END,
                contact_ip = coalesce($4::inet, contact_ip), contact_port = coalesce($5, contact_port),
                user_agent = coalesce($6, user_agent), firmware_version = coalesce($7, firmware_version)
          WHERE id = $1
          RETURNING version, last_seen_at, (SELECT EXISTS (SELECT 1 FROM call_sessions c WHERE c.atm_id = $1
                     AND c.state IN ('RESERVED','DIALING','RINGING','CONNECTED','TERMINATING'))) AS in_call`,
        [d.id, s.state, health, s.contactIp ?? null, s.contactPort ?? null, s.userAgent ?? null, fw],
      );
      await c.query(
        `INSERT INTO device_events (organization_id, atm_id, type, severity, detail) VALUES ($1,$2,$3,$4,$5)`,
        [d.organization_id, d.id, s.state, s.state === 'REGISTERED' ? 'info' : 'warning', JSON.stringify({ source: s.source, contactIp: s.contactIp ?? null })],
      );
      if (fw && fw !== d.firmware_version) {
        await c.query(
          `INSERT INTO device_events (organization_id, atm_id, type, detail) VALUES ($1,$2,'FIRMWARE_CHANGED',$3)`,
          [d.organization_id, d.id, JSON.stringify({ from: d.firmware_version, to: fw })],
        );
      }
      return {
        orgId: d.organization_id as string,
        version: u.rows[0].version as number,
        data: {
          atmId: d.id,
          registration: s.state as DeviceRegistration,
          health,
          inCall: u.rows[0].in_call,
          lastSeenAt: u.rows[0].last_seen_at?.toISOString?.() ?? null,
        } satisfies AtmStatusData,
      };
    });
    if (!changed) return false;
    await this.bus.publish({
      type: 'atm.registration.changed',
      orgId: changed.orgId,
      entityType: 'atm',
      entityId: changed.data.atmId,
      entityVersion: changed.version,
      data: changed.data,
    });
    return true;
  }

  /** Leader job: registrations that stopped refreshing without an explicit unregister. */
  async sweepStaleRegistrations(): Promise<number> {
    const rows = await this.db.query<{ sip_username: string }>(
      `SELECT si.sip_username FROM atm_devices d JOIN sip_identities si ON si.atm_id = d.id
        WHERE d.registration_status = 'REGISTERED' AND d.deleted_at IS NULL
          AND d.last_seen_at < now() - interval '${STALE_REGISTRATION}'
        LIMIT 1000`,
    );
    for (const r of rows) await this.applyRegistration({ sipUsername: r.sip_username, state: 'EXPIRED', source: 'sweeper' });
    if (rows.length) this.log.warn(`${rows.length} ATM registration(s) expired without refresh`);
    return rows.length;
  }

  async setHealth(atmId: string, health: DeviceHealth, reason: string) {
    const r = await this.db.one(
      `UPDATE atm_devices SET health = $2 WHERE id = $1 AND health <> $2 RETURNING organization_id, version, registration_status, last_seen_at`,
      [atmId, health],
    );
    if (!r) return;
    await this.db.query(`INSERT INTO device_events (organization_id, atm_id, type, severity, detail) VALUES ($1,$2,$3,$4,$5)`, [
      r.organization_id,
      atmId,
      health === 'FAULT' ? 'FAULT' : 'FAULT_CLEARED',
      health === 'FAULT' ? 'critical' : 'info',
      JSON.stringify({ reason }),
    ]);
    await this.bus.publish({
      type: 'atm.status.changed',
      orgId: r.organization_id,
      entityType: 'atm',
      entityId: atmId,
      entityVersion: r.version,
      data: { atmId, registration: r.registration_status, health, inCall: false, lastSeenAt: r.last_seen_at } as AtmStatusData,
    });
  }
}
