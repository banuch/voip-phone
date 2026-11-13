import { describe, expect, it } from 'vitest';
import {
  ACTIVE_CALL_STATES, ALL_CALL_STATES, CALL_STATE_TIMEOUTS_MS, CALL_TRANSITIONS, CallState,
  TERMINAL_CALL_STATES, assertTransition, canTransition, terminalStateForSipCode,
} from '../src/index.js';

describe('call state machine', () => {
  it('terminal states have no outgoing transitions', () => {
    for (const s of TERMINAL_CALL_STATES) expect(CALL_TRANSITIONS[s]).toEqual([]);
  });

  it('every non-terminal state can reach a terminal state', () => {
    for (const start of ALL_CALL_STATES) {
      const seen = new Set<CallState>([start]);
      const stack = [start];
      let reaches = TERMINAL_CALL_STATES.has(start);
      while (stack.length) {
        for (const n of CALL_TRANSITIONS[stack.pop()!]) {
          if (TERMINAL_CALL_STATES.has(n)) reaches = true;
          if (!seen.has(n)) { seen.add(n); stack.push(n); }
        }
      }
      expect(reaches, start).toBe(true);
    }
  });

  it('every non-terminal, non-idle state is bounded by a timeout', () => {
    for (const s of ALL_CALL_STATES) {
      if (TERMINAL_CALL_STATES.has(s) || s === 'IDLE' || s === 'CONNECTED') continue;
      expect(CALL_STATE_TIMEOUTS_MS[s], s).toBeDefined();
      expect(canTransition(s, CALL_STATE_TIMEOUTS_MS[s]!.onExpire), s).toBe(true);
    }
  });

  it('follows the happy path', () => {
    const path: CallState[] = ['IDLE', 'REQUESTED', 'VALIDATING', 'RESERVED', 'DIALING', 'RINGING', 'CONNECTED', 'TERMINATING', 'COMPLETED'];
    for (let i = 1; i < path.length; i++) expect(() => assertTransition(path[i - 1]!, path[i]!)).not.toThrow();
  });

  it('cannot jump to CONNECTED without dialing', () => {
    expect(canTransition('RESERVED', 'CONNECTED')).toBe(false);
    expect(canTransition('VALIDATING', 'CONNECTED')).toBe(false);
    expect(() => assertTransition('COMPLETED', 'CONNECTED')).toThrow(/Invalid/);
  });

  it('active and terminal sets are disjoint', () => {
    for (const s of ACTIVE_CALL_STATES) expect(TERMINAL_CALL_STATES.has(s)).toBe(false);
  });

  it('maps SIP codes', () => {
    expect(terminalStateForSipCode(486)).toBe('BUSY');
    expect(terminalStateForSipCode(408)).toBe('TIMEOUT');
    expect(terminalStateForSipCode(487)).toBe('CANCELLED');
    expect(terminalStateForSipCode(503)).toBe('FAILED');
  });
});
