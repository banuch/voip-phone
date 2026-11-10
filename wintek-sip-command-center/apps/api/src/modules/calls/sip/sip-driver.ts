/**
 * Boundary between call control (CallsService - the only authority on call
 * state) and the media/signalling plane (Asterisk via ARI, or a simulator).
 * Drivers translate raw platform events into these normalized signals and
 * execute plumbing commands; they never decide call state themselves.
 */

export type LegKind = 'OPERATOR' | 'ATM';

export type SipSignal =
  /** The operator's browser INVITE reached the Stasis app carrying a call id and dial token. */
  | { type: 'OPERATOR_LEG'; callId: string; token: string; channelId: string; endpoint: string; node: string }
  /** 180 Ringing from the ATM. */
  | { type: 'ATM_RINGING'; callId: string; channelId: string }
  /** 200 OK from the ATM (channel Up). */
  | { type: 'ATM_ANSWERED'; callId: string; channelId: string }
  /** A leg is gone. q850 is the hangup cause; sipCode is derived when known. */
  | { type: 'LEG_ENDED'; callId: string; leg: LegKind; channelId: string; q850: number | null; sipCode: number | null; reason: string }
  /** Registrar endpoint state (Asterisk-as-registrar deployments). */
  | { type: 'ENDPOINT_STATE'; endpoint: string; state: 'online' | 'offline'; contactIp?: string | null; contactPort?: number | null; userAgent?: string | null }
  | { type: 'DRIVER_STATE'; connected: boolean; detail: string };

export interface CallPlumbing {
  callId: string;
  operatorChannelId: string | null;
  atmChannelId: string | null;
  bridgeId: string | null;
}

export interface DialRequest {
  callId: string;
  operatorChannelId: string;
  /** Pre-assigned so that every event for the ATM leg maps to the call from its first moment. */
  atmChannelId: string;
  bridgeId: string;
  atmSipUsername: string;
  callerIdName: string;
  ringTimeoutSec: number;
}

export interface DriverHealth {
  name: string;
  node: string;
  connected: boolean;
  detail: string;
  latencyMs: number | null;
}

export interface SipDriver {
  readonly name: string;
  readonly node: string;
  start(onSignal: (s: SipSignal) => void): Promise<void>;
  stop(): Promise<void>;
  /** Simulator only: pretend the operator's browser has placed its INVITE. */
  simulateOperatorLeg?(callId: string, token: string, operatorEndpoint: string): void;
  /** Ring the operator leg back, create the bridge and originate the ATM leg. */
  dialAtm(req: DialRequest): Promise<void>;
  /** ATM answered: answer the operator leg and bridge both legs. */
  connect(call: CallPlumbing): Promise<void>;
  rejectOperatorLeg(channelId: string, reason: 'unauthorized' | 'unknown_call' | 'busy'): Promise<void>;
  /** Hang up every leg and destroy the bridge. Must be idempotent. */
  hangup(call: CallPlumbing): Promise<void>;
  /** Live channel ids on this media node, or null if the node can't be queried. */
  liveChannelIds(): Promise<Set<string> | null>;
  health(): Promise<DriverHealth>;
}

export const SIP_DRIVER = Symbol('SIP_DRIVER');

/** Q.850 cause -> SIP response code (RFC 3398) for call metadata. */
export function q850ToSip(cause: number | null): number | null {
  if (cause === null) return null;
  const map: Record<number, number> = {
    1: 404, 3: 404, 16: 200, 17: 486, 18: 408, 19: 480, 20: 480, 21: 603, 22: 410, 27: 502, 28: 484,
    31: 480, 34: 503, 38: 503, 41: 503, 42: 503, 47: 503, 55: 403, 57: 403, 58: 503, 65: 488, 79: 501, 88: 488, 102: 504, 127: 500,
  };
  return map[cause] ?? 500;
}
