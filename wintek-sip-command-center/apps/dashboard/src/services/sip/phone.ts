import type { DialInfo, WebRtcConfig } from '@/types/api';

export type PhoneRegistration = 'unregistered' | 'registering' | 'registered' | 'failed';
export type MediaState = 'idle' | 'connecting' | 'ringing' | 'established' | 'ended' | 'failed';

export interface AudioQuality {
  /** 1 (bad) .. 5 (excellent), estimated from loss/jitter/RTT (E-model inspired). */
  score: number;
  packetLossPct: number;
  jitterMs: number;
  rttMs: number | null;
  codec: string | null;
}

export interface PhoneEvents {
  onRegistration: (s: PhoneRegistration, detail?: string) => void;
  onMedia: (s: MediaState, detail?: string) => void;
  onQuality: (q: AudioQuality) => void;
}

/**
 * Operator softphone. The SERVER decides call state (from ARI events); the
 * phone only reports local media facts (registration, ICE/media, quality),
 * which feed presence heartbeats and the call panel's diagnostics.
 */
export interface Phone {
  readonly kind: 'sipjs' | 'simulated';
  start(cfg: WebRtcConfig, ev: PhoneEvents): Promise<void>;
  stop(): Promise<void>;
  dial(d: DialInfo, opts: { micDeviceId?: string }): Promise<void>;
  hangup(): Promise<void>;
  setMuted(m: boolean): void;
  setVolume(v: number): void;
  setOutputDevice(id: string): Promise<boolean>;
  setInputDevice(id: string): Promise<void>;
  readonly registered: boolean;
}

export const supportsOutputSelection = () =>
  typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;

export async function listAudioDevices(): Promise<{ inputs: MediaDeviceInfo[]; outputs: MediaDeviceInfo[]; labelled: boolean }> {
  if (!navigator.mediaDevices?.enumerateDevices) return { inputs: [], outputs: [], labelled: false };
  const all = await navigator.mediaDevices.enumerateDevices();
  return {
    inputs: all.filter((d) => d.kind === 'audioinput'),
    outputs: all.filter((d) => d.kind === 'audiooutput'),
    labelled: all.some((d) => d.label),
  };
}

/** Ask for mic permission early (before the first call) so the CALL button is instant. */
export async function ensureMicPermission(): Promise<'granted' | 'denied' | 'unavailable'> {
  if (!navigator.mediaDevices?.getUserMedia) return 'unavailable';
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    s.getTracks().forEach((t) => t.stop());
    return 'granted';
  } catch (e: any) {
    return e?.name === 'NotFoundError' ? 'unavailable' : 'denied';
  }
}

export function qualityScore(lossPct: number, jitterMs: number, rttMs: number | null): number {
  // Effective latency per ITU-T G.107 simplification, mapped to a 1-5 MOS-like value.
  const latency = (rttMs ?? 80) / 2 + jitterMs * 2 + 10;
  let r = latency < 160 ? 93.2 - latency / 40 : 93.2 - (latency - 120) / 10;
  r -= lossPct * 2.5;
  r = Math.max(0, Math.min(100, r));
  const mos = 1 + 0.035 * r + 0.000007 * r * (r - 60) * (100 - r);
  return Math.round(Math.max(1, Math.min(5, mos)) * 10) / 10;
}
