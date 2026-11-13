import { Inviter, Registerer, RegistererState, SessionState, UserAgent, type Session, type Web } from 'sip.js';
import type { DialInfo, WebRtcConfig } from '@/types/api';
import { qualityScore, type Phone, type PhoneEvents } from './phone';

/**
 * SIP.js softphone: SIP over WSS to the WebRTC edge (Asterisk/Kamailio),
 * DTLS-SRTP media, Opus or G.711 negotiated by Asterisk which transcodes to
 * the ATM's G.711 RTP leg.
 */
export class SipJsPhone implements Phone {
  readonly kind = 'sipjs' as const;
  private ua: UserAgent | null = null;
  private registerer: Registerer | null = null;
  private session: Session | null = null;
  private ev: PhoneEvents | null = null;
  private audio: HTMLAudioElement;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private muted = false;
  private lastStats: { lost: number; received: number } | null = null;
  private isRegistered = false;

  constructor() {
    this.audio = new Audio();
    this.audio.autoplay = true;
  }

  get registered() {
    return this.isRegistered;
  }

  async start(cfg: WebRtcConfig, ev: PhoneEvents) {
    this.ev = ev;
    const uri = UserAgent.makeURI(cfg.sipUri);
    if (!uri) throw new Error(`invalid SIP URI ${cfg.sipUri}`);
    this.ua = new UserAgent({
      uri,
      authorizationUsername: cfg.authorizationUsername,
      authorizationPassword: cfg.password,
      transportOptions: { server: cfg.wssUrl, traceSip: false, keepAliveInterval: 25 },
      sessionDescriptionHandlerFactoryOptions: { peerConnectionConfiguration: { iceServers: cfg.iceServers, bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' } },
      logLevel: 'warn',
      // Inbound calls are not part of V1.1: operators only place calls.
      delegate: {
        onInvite: (inv) => void inv.reject({ statusCode: 486 }),
        onDisconnect: (err) => {
          this.isRegistered = false;
          ev.onRegistration('failed', err ? `transport lost: ${err.message}` : 'transport closed');
          void this.reconnect();
        },
      },
    });
    ev.onRegistration('registering');
    await this.ua.start();
    this.registerer = new Registerer(this.ua, { expires: 300, refreshFrequency: 80 });
    this.registerer.stateChange.addListener((s) => {
      this.isRegistered = s === RegistererState.Registered;
      ev.onRegistration(this.isRegistered ? 'registered' : s === RegistererState.Registered ? 'registered' : 'unregistered');
    });
    await this.registerer.register({
      requestDelegate: { onReject: (r) => ev.onRegistration('failed', `${r.message.statusCode} ${r.message.reasonPhrase}`) },
    });
  }

  private async reconnect() {
    for (let i = 0; i < 8 && this.ua; i++) {
      await new Promise((r) => setTimeout(r, Math.min(15_000, 1000 * 2 ** i)));
      try {
        await this.ua.reconnect();
        await this.registerer?.register();
        return;
      } catch {
        /* keep trying */
      }
    }
  }

  async stop() {
    await this.hangup().catch(() => undefined);
    await this.registerer?.unregister().catch(() => undefined);
    await this.ua?.stop().catch(() => undefined);
    this.ua = null;
    this.isRegistered = false;
  }

  async dial(d: DialInfo, opts: { micDeviceId?: string }) {
    if (!this.ua) throw new Error('softphone not started');
    if (this.session) throw new Error('a call is already in progress on this console');
    const target = UserAgent.makeURI(d.target);
    if (!target) throw new Error(`bad dial target ${d.target}`);
    const inviter = new Inviter(this.ua, target, {
      extraHeaders: Object.entries(d.headers).map(([k, v]) => `${k}: ${v}`),
      sessionDescriptionHandlerOptions: {
        constraints: { audio: opts.micDeviceId ? { deviceId: { exact: opts.micDeviceId }, echoCancellation: true, noiseSuppression: true, autoGainControl: true } : { echoCancellation: true, noiseSuppression: true }, video: false },
      },
    });
    this.session = inviter;
    this.ev?.onMedia('connecting');
    inviter.stateChange.addListener((st) => {
      if (st === SessionState.Established) {
        this.attachRemote();
        this.setMuted(this.muted);
        this.ev?.onMedia('established');
        this.startStats();
      } else if (st === SessionState.Terminated) {
        this.cleanup();
        this.ev?.onMedia('ended');
      }
    });
    await inviter.invite({
      requestDelegate: {
        onProgress: (r) => r.message.statusCode === 180 && this.ev?.onMedia('ringing'),
        onReject: (r) => this.ev?.onMedia('failed', `${r.message.statusCode} ${r.message.reasonPhrase}`),
      },
    });
  }

  private sdh() {
    return this.session?.sessionDescriptionHandler as Web.SessionDescriptionHandler | undefined;
  }

  private attachRemote() {
    const sdh = this.sdh();
    if (!sdh) return;
    this.audio.srcObject = sdh.remoteMediaStream;
    void this.audio.play().catch(() => undefined);
  }

  async hangup() {
    const s = this.session;
    if (!s) return;
    if (s.state === SessionState.Established) await s.bye();
    else if (s instanceof Inviter && (s.state === SessionState.Initial || s.state === SessionState.Establishing)) await s.cancel();
  }

  setMuted(m: boolean) {
    this.muted = m;
    this.sdh()?.peerConnection?.getSenders().forEach((snd) => snd.track && (snd.track.enabled = !m));
  }

  setVolume(v: number) {
    this.audio.volume = Math.max(0, Math.min(1, v));
  }

  async setOutputDevice(id: string) {
    const a = this.audio as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
    if (!a.setSinkId) return false;
    await a.setSinkId(id);
    return true;
  }

  async setInputDevice(id: string) {
    const pc = this.sdh()?.peerConnection;
    if (!pc) return; // used on the next call
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: id }, echoCancellation: true, noiseSuppression: true }, video: false });
    const track = stream.getAudioTracks()[0]!;
    track.enabled = !this.muted;
    const sender = pc.getSenders().find((s) => s.track?.kind === 'audio');
    const old = sender?.track;
    await sender?.replaceTrack(track);
    old?.stop();
  }

  private startStats() {
    this.stopStats();
    this.statsTimer = setInterval(async () => {
      const pc = this.sdh()?.peerConnection;
      if (!pc) return;
      const stats = await pc.getStats();
      let lost = 0;
      let received = 0;
      let jitter = 0;
      let rtt: number | null = null;
      let codec: string | null = null;
      const codecs = new Map<string, string>();
      stats.forEach((r: any) => r.type === 'codec' && codecs.set(r.id, r.mimeType));
      stats.forEach((r: any) => {
        if (r.type === 'inbound-rtp' && r.kind === 'audio') {
          lost = r.packetsLost ?? 0;
          received = r.packetsReceived ?? 0;
          jitter = (r.jitter ?? 0) * 1000;
          codec = codecs.get(r.codecId) ?? null;
        }
        if (r.type === 'remote-inbound-rtp' && r.kind === 'audio' && r.roundTripTime !== undefined) rtt = r.roundTripTime * 1000;
        if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.currentRoundTripTime !== undefined && rtt === null) rtt = r.currentRoundTripTime * 1000;
      });
      const prev = this.lastStats;
      const dl = prev ? lost - prev.lost : lost;
      const dr = prev ? received - prev.received : received;
      this.lastStats = { lost, received };
      const lossPct = dr + dl > 0 ? (Math.max(0, dl) / (dr + Math.max(0, dl))) * 100 : 0;
      this.ev?.onQuality({ score: qualityScore(lossPct, jitter, rtt), packetLossPct: Math.round(lossPct * 10) / 10, jitterMs: Math.round(jitter), rttMs: rtt === null ? null : Math.round(rtt), codec });
    }, 2000);
  }

  private stopStats() {
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.statsTimer = null;
    this.lastStats = null;
  }

  private cleanup() {
    this.stopStats();
    this.audio.srcObject = null;
    this.session = null;
  }
}
