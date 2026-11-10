import type { CallState } from './call-state.js';
import type { Availability, DeviceHealth, DeviceRegistration } from './presence.js';
import type { Priority } from './priority.js';

export const EVENT_SCHEMA_VERSION = 1;

export const EventType = {
  ATM_STATUS_CHANGED: 'atm.status.changed',
  ATM_REGISTRATION_CHANGED: 'atm.registration.changed',
  OPERATOR_PRESENCE_CHANGED: 'operator.presence.changed',
  CALL_REQUESTED: 'call.requested',
  CALL_DIALING: 'call.dialing',
  CALL_RINGING: 'call.ringing',
  CALL_CONNECTED: 'call.connected',
  CALL_TERMINATING: 'call.terminating',
  CALL_ENDED: 'call.ended',
  CALL_FAILED: 'call.failed',
  QUEUE_UPDATED: 'queue.updated',
  ASSIGNMENT_UPDATED: 'assignment.updated',
  SYSTEM_ALERT: 'system.alert',
  /** Server -> client: your sequence has a gap you cannot fill; refetch snapshots. */
  RESYNC_REQUIRED: 'system.resync_required',
} as const;
export type EventType = (typeof EventType)[keyof typeof EventType];

/**
 * Every real-time event uses this envelope. Delivery is at-least-once and may
 * be reordered across reconnects, so clients:
 *  - drop events whose `id` they have already applied (dedupe window),
 *  - track `seq` per `orgId` stream; a gap triggers a replay request with
 *    `since`, and if the server can no longer replay it sends
 *    RESYNC_REQUIRED and the client refetches REST snapshots,
 *  - apply entity updates only if `entityVersion` is newer than what they hold.
 */
export interface EventEnvelope<TType extends EventType = EventType, TData = unknown> {
  id: string;
  type: TType;
  schemaVersion: number;
  /** ISO-8601 server time */
  ts: string;
  orgId: string;
  entityType: 'atm' | 'operator' | 'call' | 'queue' | 'assignment' | 'system';
  entityId: string;
  /** Monotonic per-org sequence (Redis INCR), for gap detection. */
  seq: number;
  /** Per-entity version (DB row version), for last-writer-wins on the client. */
  entityVersion: number;
  correlationId: string | null;
  data: TData;
}

export interface CallEventData {
  callId: string;
  atmId: string;
  atmCode: string;
  atmName: string;
  operatorId: string;
  operatorName: string;
  state: CallState;
  priority: Priority;
  requestedAt: string;
  correlationId: string;
  sipCode?: number | null;
  reason?: string | null;
  answeredAt?: string | null;
  endedAt?: string | null;
}

export interface AtmStatusData {
  atmId: string;
  registration: DeviceRegistration;
  health: DeviceHealth;
  inCall: boolean;
  lastSeenAt: string | null;
}

export interface OperatorPresenceData {
  operatorId: string;
  selected: Availability;
  effective: Availability;
  currentCallId: string | null;
}

export interface SystemAlertData {
  severity: 'info' | 'warning' | 'critical';
  component: string;
  message: string;
}

export interface ClientHello {
  type: 'hello';
  /** last seq seen per org, for replay after reconnect */
  since?: Record<string, number>;
}

/** Event type published for each call state the server enters. */
export function eventTypeForCallState(state: CallState): EventType {
  switch (state) {
    case 'REQUESTED':
    case 'VALIDATING':
    case 'RESERVED':
      return EventType.CALL_REQUESTED;
    case 'DIALING':
      return EventType.CALL_DIALING;
    case 'RINGING':
      return EventType.CALL_RINGING;
    case 'CONNECTED':
      return EventType.CALL_CONNECTED;
    case 'TERMINATING':
      return EventType.CALL_TERMINATING;
    case 'COMPLETED':
    case 'CANCELLED':
      return EventType.CALL_ENDED;
    default:
      return EventType.CALL_FAILED;
  }
}

export interface QueueEventData {
  queueItemId: string;
  atmId: string;
  state: 'WAITING' | 'OFFERED' | 'FULFILLED' | 'CANCELLED' | 'EXPIRED';
  priority: Priority;
  offeredOperatorId: string | null;
  escalated: boolean;
  reason: string | null;
}
