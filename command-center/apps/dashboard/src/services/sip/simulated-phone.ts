import type { DialInfo, WebRtcConfig } from '@/types/api';
import { qualityScore, type Phone, type PhoneEvents } from './phone';

/**
 * Stand-in softphone for mock mode and SIP_DRIVER=simulated backends. It
 * "registers" and reports plausible media quality; the call itself is driven
 * by the server (or the mock service), exactly as with a real phone.
 */
export class SimulatedPhone implements Phone {
  readonly kind = 'simulated' as const;
  private ev: PhoneEvents | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private isRegistered = false;

  get registered() {
    return this.isRegistered;
  }

  async start(_cfg: WebRtcConfig, ev: PhoneEvents) {
    this.ev = ev;
    ev.onRegistration('registering');
    await new Promise((r) => setTimeout(r, 400));
    this.isRegistered = true;
    ev.onRegistration('registered', 'simulated softphone');
  }

  async stop() {
    this.isRegistered = false;
    this.ev?.onRegistration('unregistered');
    if (this.timer) clearInterval(this.timer);
  }

  async dial(_d: DialInfo) {
    this.ev?.onMedia('connecting');
    setTimeout(() => this.ev?.onMedia('ringing'), 700);
    setTimeout(() => {
      this.ev?.onMedia('established');
      this.timer = setInterval(() => {
        const loss = Math.random() < 0.85 ? Math.random() * 0.6 : Math.random() * 4;
        const jitter = 4 + Math.random() * 18;
        const rtt = 40 + Math.random() * 60;
        this.ev?.onQuality({ score: qualityScore(loss, jitter, rtt), packetLossPct: Math.round(loss * 10) / 10, jitterMs: Math.round(jitter), rttMs: Math.round(rtt), codec: 'audio/opus' });
      }, 2000);
    }, 2200);
  }

  async hangup() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.ev?.onMedia('ended');
  }

  setMuted() {}
  setVolume() {}
  async setOutputDevice() {
    return true;
  }
  async setInputDevice() {}
}
