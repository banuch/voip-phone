import { create } from 'zustand';
import { ACTIVE_CALL_STATES, type Availability, type CallEventData, type Priority } from '@wintek/shared';
import { ApiError, dataService, isMock } from '@/services/api';
import { SimulatedPhone } from '@/services/sip/simulated-phone';
import { SipJsPhone } from '@/services/sip/sipjs-phone';
import { ensureMicPermission, type AudioQuality, type MediaState, type Phone, type PhoneRegistration } from '@/services/sip/phone';
import type { CallView } from '@/types/api';
import { uuid } from '@/lib/utils';

const PREFS_KEY = 'wintek.console.prefs';
interface Prefs {
  micId?: string;
  speakerId?: string;
  volume: number;
}
const loadPrefs = (): Prefs => {
  try {
    return { volume: 0.9, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') };
  } catch {
    return { volume: 0.9 };
  }
};
const savePrefs = (p: Prefs) => {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* storage may be unavailable */
  }
};

export interface ConsoleState {
  phone: Phone | null;
  registration: PhoneRegistration;
  registrationDetail: string | null;
  micPermission: 'unknown' | 'granted' | 'denied' | 'unavailable';
  media: MediaState;
  quality: AudioQuality | null;
  muted: boolean;
  prefs: Prefs;
  selected: Availability;
  effective: Availability;
  /** The call as the SERVER reports it. */
  call: CallView | null;
  placing: boolean;
  error: { code: string; message: string } | null;
  notice: string | null;

  startConsole: () => Promise<void>;
  stopConsole: () => Promise<void>;
  placeCall: (atmId: string, opts?: { priority?: Priority; queueIfBusy?: boolean; queueItemId?: string }) => Promise<'placed' | 'queued' | 'failed'>;
  hangup: () => Promise<void>;
  setMuted: (m: boolean) => void;
  setVolume: (v: number) => void;
  setMic: (id: string) => Promise<void>;
  setSpeaker: (id: string) => Promise<void>;
  setPresence: (a: Availability) => Promise<void>;
  applyCallEvent: (d: CallEventData) => void;
  applyPresence: (selected: Availability, effective: Availability) => void;
  recover: () => Promise<void>;
  clearError: () => void;
}

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

export const useConsole = create<ConsoleState>((set, get) => ({
  phone: null,
  registration: 'unregistered',
  registrationDetail: null,
  micPermission: 'unknown',
  media: 'idle',
  quality: null,
  muted: false,
  prefs: loadPrefs(),
  selected: 'OFFLINE',
  effective: 'OFFLINE',
  call: null,
  placing: false,
  error: null,
  notice: null,

  startConsole: async () => {
    if (get().phone) return;
    const mic = await ensureMicPermission();
    set({ micPermission: mic });
    const cfg = await dataService.webrtcCredentials();
    const phone: Phone = isMock || cfg.driver === 'simulated' ? new SimulatedPhone() : new SipJsPhone();
    set({ phone });
    await phone.start(cfg, {
      onRegistration: (registration, detail) => {
        set({ registration, registrationDetail: detail ?? null });
        void dataService.heartbeat(registration === 'registered', mic !== 'granted').catch(() => undefined);
      },
      onMedia: (media, detail) => {
        set({ media, ...(media === 'failed' ? { error: { code: 'MEDIA_FAILED', message: detail ?? 'Audio connection failed' } } : {}) });
        if (media === 'ended' || media === 'failed') set({ quality: null });
      },
      onQuality: (quality) => set({ quality }),
    });
    phone.setVolume(get().prefs.volume);
    if (get().prefs.speakerId) await phone.setOutputDevice(get().prefs.speakerId!).catch(() => false);
    // Presence heartbeat: the server marks us OFFLINE if these stop (tab closed, network lost).
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    const beat = () => void dataService.heartbeat(get().phone?.registered ?? false, get().micPermission !== 'granted').catch(() => undefined);
    beat();
    heartbeatTimer = setInterval(beat, 10_000);
  },

  stopConsole: async () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    await get().phone?.stop();
    set({ phone: null, registration: 'unregistered' });
  },

  placeCall: async (atmId, opts = {}) => {
    const st = get();
    if (st.placing || (st.call && ACTIVE_CALL_STATES.has(st.call.state))) {
      set({ error: { code: 'OPERATOR_BUSY', message: 'You already have an active call' } });
      return 'failed';
    }
    set({ placing: true, error: null, notice: null });
    const requestId = uuid(); // one per click; retries of this click reuse it
    try {
      const result = await dataService.initiateCall({ atmId, requestId, ...opts }).catch(async (e) => {
        // Network blip: retry once with the SAME requestId - the server dedupes.
        if (e instanceof ApiError) throw e;
        return dataService.initiateCall({ atmId, requestId, ...opts });
      });
      if (result.queued) {
        set({ notice: `ATM busy — request queued (${result.queueItem.priority}). You will be offered the call when it frees up.` });
        return 'queued';
      }
      set({ call: result.call });
      if (result.dial && st.phone) {
        await st.phone.dial(result.dial, { micDeviceId: st.prefs.micId }).catch(async (e) => {
          set({ error: { code: 'MEDIA_FAILED', message: `Could not start audio: ${e.message}` } });
          await dataService.hangup(result.call.id).catch(() => undefined);
        });
      } else if (!st.phone) {
        set({ error: { code: 'CONSOLE_OFFLINE', message: 'Softphone not started' } });
      }
      return 'placed';
    } catch (e: any) {
      set({ error: { code: e.code ?? 'ERROR', message: e.message ?? 'Call failed' } });
      return 'failed';
    } finally {
      set({ placing: false });
    }
  },

  hangup: async () => {
    const c = get().call;
    await get().phone?.hangup().catch(() => undefined);
    if (c) {
      const v = await dataService.hangup(c.id).catch(() => null);
      if (v) set({ call: v });
    }
  },

  setMuted: (m) => {
    get().phone?.setMuted(m);
    set({ muted: m });
  },
  setVolume: (v) => {
    get().phone?.setVolume(v);
    const prefs = { ...get().prefs, volume: v };
    savePrefs(prefs);
    set({ prefs });
  },
  setMic: async (id) => {
    await get().phone?.setInputDevice(id);
    const prefs = { ...get().prefs, micId: id };
    savePrefs(prefs);
    set({ prefs });
  },
  setSpeaker: async (id) => {
    const ok = await get().phone?.setOutputDevice(id);
    if (ok === false) set({ notice: 'This browser cannot choose the speaker; the system default output is used.' });
    const prefs = { ...get().prefs, speakerId: id };
    savePrefs(prefs);
    set({ prefs });
  },

  setPresence: async (a) => {
    try {
      const r = await dataService.setPresence(a);
      set({ selected: r.selected ?? a, effective: r.effective });
    } catch (e: any) {
      set({ error: { code: e.code ?? 'ERROR', message: e.message } });
    }
  },

  applyCallEvent: (d) => {
    const c = get().call;
    if (!c || c.id !== d.callId) return;
    set({ call: { ...c, state: d.state, answeredAt: d.answeredAt ?? c.answeredAt, endedAt: d.endedAt ?? c.endedAt, sipCode: d.sipCode ?? c.sipCode, failureReason: d.reason ?? c.failureReason } });
    if (!ACTIVE_CALL_STATES.has(d.state)) {
      void get().phone?.hangup().catch(() => undefined);
      set({ muted: false });
      get().phone?.setMuted(false);
    }
  },

  applyPresence: (selected, effective) => set({ selected, effective }),

  recover: async () => {
    const mine = await dataService.myCall().catch(() => null);
    if (mine) {
      set({ call: mine, notice: 'Recovered your active call after reload. If the audio was interrupted, the call will end and can be placed again.' });
    }
  },

  clearError: () => set({ error: null, notice: null }),
}));
