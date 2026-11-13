import { Logger } from '@nestjs/common';
import WebSocket from 'ws';
import { q850ToSip, type CallPlumbing, type DialRequest, type DriverHealth, type SipDriver, type SipSignal } from './sip-driver';

export interface AriOptions {
  url: string; // http://asterisk:8088/ari
  user: string;
  password: string;
  app: string;
  node: string;
  /** asterisk-registrar: PJSIP/<user>; kamailio: PJSIP/<user>@<trunk> */
  dialMode: 'asterisk-registrar' | 'kamailio';
  kamailioTrunk: string;
}

interface AriChannel {
  id: string;
  state: string;
  caller?: { number?: string; name?: string };
  dialplan?: { exten?: string };
}

/**
 * Asterisk REST Interface driver.
 *
 * ARI (not AMI) is used for call control: it gives an application exclusive,
 * event-driven ownership of channels and bridges (Stasis), which is exactly
 * the "server decides" model this platform needs. AMI is not used for call
 * control; it may be used later for read-only node statistics.
 *
 * Dialplan contract (infra/asterisk/extensions.conf):
 *   [operators] exten => _call-.,1,Stasis(wintek,operator,${EXTEN:5},${PJSIP_HEADER(read,X-Wintek-Call-Token)})
 * The ATM leg is originated by this driver directly into Stasis with
 * appArgs "atm,<callId>", so it enters the app when answered.
 */
export class AriSipDriver implements SipDriver {
  readonly name = 'ari';
  readonly node: string;
  private readonly log = new Logger('AriDriver');
  private ws: WebSocket | null = null;
  private emit: (s: SipSignal) => void = () => undefined;
  private connected = false;
  private stopping = false;
  private backoff = 1000;
  private lastError = '';
  /** channelId -> leg. Rebuilt lazily from call ids carried in channel ids after a restart. */
  private readonly legs = new Map<string, { callId: string; leg: 'OPERATOR' | 'ATM' }>();
  private readonly auth: string;

  constructor(private readonly o: AriOptions) {
    this.node = o.node;
    this.auth = 'Basic ' + Buffer.from(`${o.user}:${o.password}`).toString('base64');
  }

  async start(onSignal: (s: SipSignal) => void) {
    this.emit = onSignal;
    this.stopping = false; // restartable: leadership may move away and come back
    this.openEvents();
  }

  async stop() {
    this.stopping = true;
    this.ws?.close();
  }

  private openEvents() {
    const wsUrl = this.o.url.replace(/^http/, 'ws') + `/events?app=${encodeURIComponent(this.o.app)}&subscribeAll=false`;
    const ws = new WebSocket(wsUrl, { headers: { Authorization: this.auth } });
    this.ws = ws;
    ws.on('open', () => {
      this.connected = true;
      this.backoff = 1000;
      this.log.log(`connected to ARI ${this.o.url} as app ${this.o.app}`);
      this.emit({ type: 'DRIVER_STATE', connected: true, detail: 'ARI connected' });
      // Registration state of PJSIP endpoints (Asterisk-as-registrar stage).
      void this.req('POST', `/applications/${this.o.app}/subscription?eventSource=endpoint:PJSIP`).catch((e) =>
        this.log.warn(`endpoint subscription failed: ${e.message}`),
      );
    });
    ws.on('message', (raw) => {
      try {
        this.onEvent(JSON.parse(raw.toString()));
      } catch (e: any) {
        this.log.warn(`bad ARI event: ${e.message}`);
      }
    });
    ws.on('error', (e) => (this.lastError = e.message));
    ws.on('close', () => {
      const was = this.connected;
      this.connected = false;
      if (was) this.emit({ type: 'DRIVER_STATE', connected: false, detail: `ARI disconnected ${this.lastError}` });
      if (this.stopping) return;
      setTimeout(() => this.openEvents(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 15_000);
    });
  }

  private async req<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(this.o.url + path, {
      method,
      headers: { Authorization: this.auth, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(5000),
    });
    if (res.status === 404 && method === 'DELETE') return undefined as T; // already gone: idempotent
    if (!res.ok) throw new Error(`ARI ${method} ${path} -> ${res.status} ${await res.text().catch(() => '')}`);
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  private legOf(channelId: string) {
    const known = this.legs.get(channelId);
    if (known) return known;
    // Ids are "wk-op-<callId>" / "wk-atm-<callId>" so legs survive an API restart.
    const m = /^wk-(op|atm)-([0-9a-f-]{36})$/.exec(channelId);
    return m ? { callId: m[2]!, leg: m[1] === 'op' ? ('OPERATOR' as const) : ('ATM' as const) } : null;
  }

  private onEvent(e: any) {
    switch (e.type) {
      case 'StasisStart': {
        const ch: AriChannel = e.channel;
        const args: string[] = e.args ?? [];
        if (args[0] === 'operator') {
          const [, callId = '', token = ''] = args;
          this.legs.set(ch.id, { callId, leg: 'OPERATOR' });
          // The endpoint name of the channel ("PJSIP/op-alice-00000012" -> "op-alice") identifies the caller;
          // it was authenticated by digest auth, so it can't be spoofed by headers.
          const endpoint = (e.channel.name as string | undefined)?.replace(/^PJSIP\//, '').replace(/-[0-9a-f]{8}$/, '') ?? '';
          this.emit({ type: 'OPERATOR_LEG', callId, token, channelId: ch.id, endpoint, node: this.node });
        } else if (args[0] === 'atm') {
          this.emit({ type: 'ATM_ANSWERED', callId: args[1] ?? this.legOf(ch.id)?.callId ?? '', channelId: ch.id });
        }
        break;
      }
      case 'ChannelStateChange': {
        const leg = this.legOf(e.channel.id);
        if (leg?.leg === 'ATM' && e.channel.state === 'Ringing') this.emit({ type: 'ATM_RINGING', callId: leg.callId, channelId: e.channel.id });
        break;
      }
      case 'ChannelDestroyed': {
        // Unknown channel (e.g. the operator leg after an API restart): CallsService
        // resolves the call by its stored channel id.
        const leg = this.legOf(e.channel.id) ?? { callId: '', leg: 'OPERATOR' as const };
        this.legs.delete(e.channel.id);
        const cause = typeof e.cause === 'number' ? e.cause : null;
        this.emit({ type: 'LEG_ENDED', callId: leg.callId, leg: leg.leg, channelId: e.channel.id, q850: cause, sipCode: q850ToSip(cause), reason: e.cause_txt ?? 'destroyed' });
        break;
      }
      case 'EndpointStateChange': {
        const ep = e.endpoint;
        if (ep?.technology !== 'PJSIP' || !ep.resource?.startsWith('atm-')) break;
        this.emit({ type: 'ENDPOINT_STATE', endpoint: ep.resource, state: ep.state === 'online' ? 'online' : 'offline' });
        break;
      }
    }
  }

  async dialAtm(r: DialRequest) {
    this.legs.set(r.atmChannelId, { callId: r.callId, leg: 'ATM' });
    // 180 Ringing back to the browser while we reach the ATM.
    await this.req('POST', `/channels/${r.operatorChannelId}/ring`);
    await this.req('POST', `/bridges?type=mixing&bridgeId=${r.bridgeId}&name=${r.bridgeId}`);
    await this.req('POST', `/bridges/${r.bridgeId}/addChannel?channel=${r.operatorChannelId}`);
    const endpoint =
      this.o.dialMode === 'kamailio' ? `PJSIP/${r.atmSipUsername}@${this.o.kamailioTrunk}` : `PJSIP/${r.atmSipUsername}`;
    const qs = new URLSearchParams({
      endpoint,
      app: this.o.app,
      appArgs: `atm,${r.callId}`,
      callerId: `"${r.callerIdName.replace(/"/g, '')}" <wintek>`,
      timeout: String(r.ringTimeoutSec),
      originator: r.operatorChannelId,
    });
    await this.req('POST', `/channels/${r.atmChannelId}?${qs}`, {
      variables: {
        // Auto-answer hint for endpoints that honour it; the Wintek device auto-answers authorized calls regardless.
        'PJSIP_HEADER(add,Call-Info)': '<sip:wintek>;answer-after=0',
        'PJSIP_HEADER(add,X-Wintek-Call-Id)': r.callId,
      },
    });
  }

  async connect(call: CallPlumbing) {
    if (!call.operatorChannelId || !call.atmChannelId || !call.bridgeId) throw new Error('incomplete call plumbing');
    await this.req('POST', `/channels/${call.operatorChannelId}/answer`);
    await this.req('POST', `/bridges/${call.bridgeId}/addChannel?channel=${call.atmChannelId}`);
  }

  async rejectOperatorLeg(channelId: string, reason: 'unauthorized' | 'unknown_call' | 'busy') {
    const cause = reason === 'busy' ? 'busy' : 'congestion';
    await this.req('DELETE', `/channels/${channelId}?reason=${cause}`).catch((e) => this.log.warn(e.message));
  }

  async hangup(call: CallPlumbing) {
    const jobs: Promise<unknown>[] = [];
    if (call.atmChannelId) jobs.push(this.req('DELETE', `/channels/${call.atmChannelId}?reason=normal`));
    if (call.operatorChannelId) jobs.push(this.req('DELETE', `/channels/${call.operatorChannelId}?reason=normal`));
    await Promise.allSettled(jobs);
    if (call.bridgeId) await this.req('DELETE', `/bridges/${call.bridgeId}`).catch(() => undefined);
  }

  async liveChannelIds(): Promise<Set<string> | null> {
    if (!this.connected) return null;
    try {
      const chans = await this.req<AriChannel[]>('GET', '/channels');
      return new Set(chans.map((c) => c.id));
    } catch {
      return null;
    }
  }

  async health(): Promise<DriverHealth> {
    const t = Date.now();
    try {
      const info = await this.req('GET', '/asterisk/info?only=system');
      return { name: this.name, node: this.node, connected: this.connected, detail: `Asterisk ${info?.system?.version ?? ''}`.trim(), latencyMs: Date.now() - t };
    } catch (e: any) {
      return { name: this.name, node: this.node, connected: false, detail: e.message, latencyMs: null };
    }
  }
}
