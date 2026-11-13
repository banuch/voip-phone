/**
 * Operator availability. `selected` is what the operator chose; `effective`
 * is what routing uses after the server combines it with heartbeat freshness,
 * WebRTC registration and the operator's actual call state.
 */
export const Availability = {
  AVAILABLE: 'AVAILABLE',
  BUSY: 'BUSY',
  BREAK: 'BREAK',
  OFFLINE: 'OFFLINE',
  UNAVAILABLE: 'UNAVAILABLE',
  FAULT: 'FAULT',
} as const;
export type Availability = (typeof Availability)[keyof typeof Availability];

/** States an operator may pick by hand. BUSY, OFFLINE and FAULT are derived. */
export const SELECTABLE_AVAILABILITY: readonly Availability[] = ['AVAILABLE', 'BREAK', 'UNAVAILABLE'];

export const HEARTBEAT_INTERVAL_MS = 10_000;
/** Missing this many intervals marks the operator OFFLINE. */
export const HEARTBEAT_STALE_MS = 30_000;

export interface PresenceInputs {
  selected: Availability;
  lastHeartbeatAt: number | null;
  /** Browser SIP UA registered with the WebRTC edge. */
  sipRegistered: boolean;
  /** Operator holds an active call (from call_sessions, not from the browser). */
  inActiveCall: boolean;
  /** Browser reported an unrecoverable media/device fault (no mic, ICE failed...). */
  mediaFault: boolean;
  now: number;
}

export function effectiveAvailability(p: PresenceInputs): Availability {
  if (p.lastHeartbeatAt === null || p.now - p.lastHeartbeatAt > HEARTBEAT_STALE_MS) return 'OFFLINE';
  if (p.inActiveCall) return 'BUSY';
  if (p.mediaFault) return 'FAULT';
  if (!p.sipRegistered && p.selected === 'AVAILABLE') return 'FAULT';
  if (p.selected === 'BUSY' || p.selected === 'OFFLINE' || p.selected === 'FAULT') return 'UNAVAILABLE';
  return p.selected;
}

export const canTakeCall = (a: Availability) => a === 'AVAILABLE';

/** ATM device connectivity. */
export const DeviceRegistration = {
  REGISTERED: 'REGISTERED',
  UNREGISTERED: 'UNREGISTERED',
  EXPIRED: 'EXPIRED',
  UNKNOWN: 'UNKNOWN',
} as const;
export type DeviceRegistration = (typeof DeviceRegistration)[keyof typeof DeviceRegistration];

export const DeviceHealth = { OK: 'OK', DEGRADED: 'DEGRADED', FAULT: 'FAULT', UNKNOWN: 'UNKNOWN' } as const;
export type DeviceHealth = (typeof DeviceHealth)[keyof typeof DeviceHealth];
