import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import type { CallEventData, EventEnvelope, OperatorPresenceData } from '@wintek/shared';
import { dataService } from '@/services/api';
import { useConsole } from '@/stores/console';
import { useRealtime } from '@/stores/realtime';
import { useSession } from '@/stores/session';

/** Which cached queries an event makes stale. Snapshots are refetched, not patched, so REST stays the source of truth. */
const INVALIDATES: Record<string, string[][]> = {
  'atm.status.changed': [['atms'], ['summary'], ['regionStats'], ['atm']],
  'atm.registration.changed': [['atms'], ['summary'], ['regionStats'], ['atm']],
  'operator.presence.changed': [['operators'], ['summary'], ['regionStats']],
  'call.requested': [['activeCalls'], ['atms'], ['summary'], ['operators']],
  'call.dialing': [['activeCalls'], ['atms']],
  'call.ringing': [['activeCalls'], ['atms']],
  'call.connected': [['activeCalls'], ['atms'], ['summary']],
  'call.terminating': [['activeCalls']],
  'call.ended': [['activeCalls'], ['atms'], ['summary'], ['operators'], ['activity'], ['callHistory']],
  'call.failed': [['activeCalls'], ['atms'], ['summary'], ['operators'], ['activity'], ['callHistory']],
  'queue.updated': [['queue'], ['summary'], ['atms']],
  'assignment.updated': [['atms'], ['assignments'], ['overrides'], ['atm']],
  'system.alert': [['health']],
};

/**
 * Bridges the event stream into the UI:
 *  - console call/presence state is updated immediately from events,
 *  - list/summary queries are invalidated, coalesced to at most once per
 *    second per key so a burst (e.g. 500 ATMs re-registering after a network
 *    blip) costs one refetch, not 500,
 *  - after reconnect or a resync request every snapshot is refetched.
 */
export function useRealtimeSync() {
  const qc = useQueryClient();
  const status = useSession((s) => s.status);

  useEffect(() => {
    if (status !== 'signedIn') return;
    const pending = new Map<string, string[]>();
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const schedule = (keys: string[][]) => {
      for (const k of keys) pending.set(k.join('|'), k);
      flushTimer ??= setTimeout(() => {
        flushTimer = null;
        for (const k of pending.values()) void qc.invalidateQueries({ queryKey: k });
        pending.clear();
      }, 1000);
    };

    const me = () => useSession.getState().user;
    const onEvent = (e: EventEnvelope) => {
      useRealtime.getState().pushEvent(e);
      if (e.entityType === 'call') useConsole.getState().applyCallEvent(e.data as CallEventData);
      if (e.type === 'operator.presence.changed') {
        const p = e.data as OperatorPresenceData;
        if (p.operatorId === me()?.operatorId) useConsole.getState().applyPresence(p.selected, p.effective);
      }
      schedule(INVALIDATES[e.type] ?? []);
    };

    let wasOpen = false;
    const unsub = dataService.subscribe({
      onEvent,
      onState: (s, detail) => {
        useRealtime.getState().setConnection(s, detail);
        if (s === 'open' && wasOpen === false) {
          // (Re)connected: anything may have happened while we were away.
          void qc.invalidateQueries();
        }
        wasOpen = s === 'open';
      },
      onResync: () => void qc.invalidateQueries(),
    });
    return () => {
      unsub();
      if (flushTimer) clearTimeout(flushTimer);
    };
  }, [status, qc]);
}
