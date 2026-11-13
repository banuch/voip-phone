/**
 * Call session state machine (V1.1, operator-initiated calls only).
 *
 * The server is the only authority that moves a call between states, and it
 * does so only on validated inputs: API validation results for the early
 * states, and SIP/ARI channel events for DIALING onwards. A call is never
 * CONNECTED because an HTTP request succeeded; only an ARI "channel Up" event
 * on the ATM leg (with the operator leg already bridged) produces CONNECTED.
 */

export const CallState = {
  IDLE: 'IDLE',
  REQUESTED: 'REQUESTED',
  VALIDATING: 'VALIDATING',
  RESERVED: 'RESERVED',
  DIALING: 'DIALING',
  RINGING: 'RINGING',
  CONNECTED: 'CONNECTED',
  TERMINATING: 'TERMINATING',
  COMPLETED: 'COMPLETED',
  BUSY: 'BUSY',
  FAILED: 'FAILED',
  TIMEOUT: 'TIMEOUT',
  CANCELLED: 'CANCELLED',
} as const;
export type CallState = (typeof CallState)[keyof typeof CallState];

export const ALL_CALL_STATES = Object.values(CallState) as CallState[];

/** Final states: the session is closed and its reservation is released. */
export const TERMINAL_CALL_STATES: ReadonlySet<CallState> = new Set([
  CallState.COMPLETED,
  CallState.BUSY,
  CallState.FAILED,
  CallState.TIMEOUT,
  CallState.CANCELLED,
]);

/**
 * States that hold the ATM and the operator. The database enforces "one
 * active call per ATM" and "one active call per operator" with partial unique
 * indexes over exactly this set (see migration 001), so the list here and the
 * SQL list must stay identical.
 */
export const ACTIVE_CALL_STATES: ReadonlySet<CallState> = new Set([
  CallState.RESERVED,
  CallState.DIALING,
  CallState.RINGING,
  CallState.CONNECTED,
  CallState.TERMINATING,
]);

const T = CallState;

/** Allowed transitions. Anything not listed is rejected. */
export const CALL_TRANSITIONS: Readonly<Record<CallState, readonly CallState[]>> = {
  [T.IDLE]: [T.REQUESTED],
  [T.REQUESTED]: [T.VALIDATING, T.CANCELLED],
  [T.VALIDATING]: [T.RESERVED, T.BUSY, T.FAILED, T.CANCELLED],
  // RESERVED -> DIALING happens when the operator's WebRTC leg enters the
  // Stasis application and the server originates the ATM leg.
  [T.RESERVED]: [T.DIALING, T.CANCELLED, T.TIMEOUT, T.FAILED],
  [T.DIALING]: [T.RINGING, T.CONNECTED, T.BUSY, T.FAILED, T.TIMEOUT, T.TERMINATING],
  [T.RINGING]: [T.CONNECTED, T.BUSY, T.FAILED, T.TIMEOUT, T.TERMINATING],
  [T.CONNECTED]: [T.TERMINATING, T.FAILED],
  [T.TERMINATING]: [T.COMPLETED, T.CANCELLED, T.FAILED],
  [T.COMPLETED]: [],
  [T.BUSY]: [],
  [T.FAILED]: [],
  [T.TIMEOUT]: [],
  [T.CANCELLED]: [],
};

export function canTransition(from: CallState, to: CallState): boolean {
  return CALL_TRANSITIONS[from].includes(to);
}

export class InvalidCallTransitionError extends Error {
  constructor(
    readonly from: CallState,
    readonly to: CallState,
  ) {
    super(`Invalid call state transition ${from} -> ${to}`);
    this.name = 'InvalidCallTransitionError';
  }
}

export function assertTransition(from: CallState, to: CallState): void {
  if (!canTransition(from, to)) throw new InvalidCallTransitionError(from, to);
}

export const isTerminal = (s: CallState) => TERMINAL_CALL_STATES.has(s);
export const isActive = (s: CallState) => ACTIVE_CALL_STATES.has(s);

/**
 * Timers that bound each non-terminal state. A background sweeper moves calls
 * that overstay to the listed outcome, so a crashed API process can never
 * leave an ATM or operator reserved forever.
 */
export const CALL_STATE_TIMEOUTS_MS: Partial<Record<CallState, { ms: number; onExpire: CallState }>> = {
  [T.REQUESTED]: { ms: 5_000, onExpire: T.CANCELLED },
  [T.VALIDATING]: { ms: 5_000, onExpire: T.CANCELLED },
  // Operator browser must place its INVITE into Stasis within this window.
  [T.RESERVED]: { ms: 15_000, onExpire: T.TIMEOUT },
  [T.DIALING]: { ms: 10_000, onExpire: T.TIMEOUT },
  // ATM auto-answer is normally < 2 s; 30 s covers a configured delay.
  [T.RINGING]: { ms: 30_000, onExpire: T.TIMEOUT },
  // Safety net only: hangup normally completes in < 1 s.
  [T.TERMINATING]: { ms: 10_000, onExpire: T.COMPLETED },
};

/** Hard ceiling for a connected call; supervisors may raise it per org. */
export const DEFAULT_MAX_CALL_DURATION_MS = 60 * 60 * 1000;

/** SIP response code -> terminal state, for failures reported by ARI. */
export function terminalStateForSipCode(code: number): CallState {
  if (code === 486 || code === 600) return T.BUSY;
  if (code === 408 || code === 480) return T.TIMEOUT;
  if (code === 487) return T.CANCELLED;
  return T.FAILED;
}
