import { create } from 'zustand';
import type { EventEnvelope } from '@wintek/shared';
import type { ConnectionState } from '@/services/api';

export interface RealtimeState {
  connection: ConnectionState;
  detail: string | null;
  lastEventAt: number | null;
  connectedAt: number | null;
  /** Ring buffer of recent events for the live feed. */
  recent: EventEnvelope[];
  alerts: { id: string; ts: string; severity: 'info' | 'warning' | 'critical'; message: string; read: boolean }[];
  setConnection: (c: ConnectionState, detail?: string) => void;
  pushEvent: (e: EventEnvelope) => void;
  markAlertsRead: () => void;
}

export const useRealtime = create<RealtimeState>((set) => ({
  connection: 'connecting',
  detail: null,
  lastEventAt: null,
  connectedAt: null,
  recent: [],
  alerts: [],
  setConnection: (connection, detail) => set((s) => ({ connection, detail: detail ?? null, connectedAt: connection === 'open' ? Date.now() : s.connectedAt })),
  pushEvent: (e) =>
    set((s) => {
      const alerts =
        e.type === 'system.alert'
          ? [{ id: e.id, ts: e.ts, severity: (e.data as any).severity ?? 'info', message: (e.data as any).message ?? 'alert', read: false }, ...s.alerts].slice(0, 50)
          : s.alerts;
      return { lastEventAt: Date.now(), recent: [e, ...s.recent].slice(0, 200), alerts };
    }),
  markAlertsRead: () => set((s) => ({ alerts: s.alerts.map((a) => ({ ...a, read: true })) })),
}));
