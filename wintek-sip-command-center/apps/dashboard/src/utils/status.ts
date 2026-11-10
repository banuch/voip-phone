import type { Availability, CallState, DeviceHealth, DeviceRegistration, Priority } from '@wintek/shared';

export type Tone = 'success' | 'warning' | 'danger' | 'info' | 'primary' | 'neutral';

/** One mapping from domain state to colour + label, used everywhere for consistency. */
export const registrationTone: Record<DeviceRegistration, Tone> = { REGISTERED: 'success', UNREGISTERED: 'danger', EXPIRED: 'danger', UNKNOWN: 'neutral' };
export const registrationLabel: Record<DeviceRegistration, string> = { REGISTERED: 'Online', UNREGISTERED: 'Offline', EXPIRED: 'Expired', UNKNOWN: 'Unknown' };
export const healthTone: Record<DeviceHealth, Tone> = { OK: 'success', DEGRADED: 'warning', FAULT: 'danger', UNKNOWN: 'neutral' };
export const availabilityTone: Record<Availability, Tone> = { AVAILABLE: 'success', BUSY: 'primary', BREAK: 'warning', OFFLINE: 'neutral', UNAVAILABLE: 'warning', FAULT: 'danger' };
export const availabilityLabel: Record<Availability, string> = { AVAILABLE: 'Available', BUSY: 'Busy', BREAK: 'On break', OFFLINE: 'Offline', UNAVAILABLE: 'Unavailable', FAULT: 'Fault' };
export const callTone: Record<CallState, Tone> = {
  IDLE: 'neutral', REQUESTED: 'info', VALIDATING: 'info', RESERVED: 'info', DIALING: 'info', RINGING: 'warning', CONNECTED: 'success',
  TERMINATING: 'neutral', COMPLETED: 'neutral', BUSY: 'warning', FAILED: 'danger', TIMEOUT: 'danger', CANCELLED: 'neutral',
};
export const callLabel: Record<CallState, string> = {
  IDLE: 'Idle', REQUESTED: 'Requested', VALIDATING: 'Validating', RESERVED: 'Reserved', DIALING: 'Dialing', RINGING: 'Ringing', CONNECTED: 'Connected',
  TERMINATING: 'Ending', COMPLETED: 'Completed', BUSY: 'Busy', FAILED: 'Failed', TIMEOUT: 'No answer', CANCELLED: 'Cancelled',
};
export const priorityTone: Record<Priority, Tone> = { P1: 'danger', P2: 'warning', P3: 'primary', P4: 'neutral' };

/** Human messages for API error codes shown to operators. */
export const callErrorText: Record<string, string> = {
  ATM_BUSY: 'This ATM is already in a call.',
  ATM_OFFLINE: 'The ATM intercom is offline (not registered).',
  ATM_DISABLED: 'This ATM is disabled or in maintenance.',
  OPERATOR_BUSY: 'You already have an active call.',
  OPERATOR_UNAVAILABLE: 'Set yourself Available (with the console connected) to place calls.',
  NOT_AUTHORIZED: 'You are not assigned to this ATM.',
  CAPACITY: 'Call capacity reached. Try again in a moment.',
  MEDIA_FAILED: 'The audio connection could not be established.',
};
