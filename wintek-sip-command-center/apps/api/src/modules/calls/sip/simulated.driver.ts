import { Logger } from '@nestjs/common';
import type { CallPlumbing, DialRequest, DriverHealth, SipDriver, SipSignal } from './sip-driver';

export interface SimulationOptions {
  operatorLegDelayMs: number;
  ringDelayMs: number;
  answerDelayMs: number;
  /** ATM usernames that never answer (to exercise TIMEOUT). */
  noAnswer?: Set<string>;
  /** ATM usernames that reject with busy (486). */
  busy?: Set<string>;
}

/**
 * Development/test driver with no Asterisk. Emits the same signals, in the
 * same order and through the same code path, as the ARI driver, so the call
 * state machine, reservations, timeouts and dashboard are exercised for real.
 * Refused in production by config validation.
 */
export class SimulatedSipDriver implements SipDriver {
  readonly name = 'simulated';
  private readonly log = new Logger('SimulatedSip');
  private emit: (s: SipSignal) => void = () => undefined;
  private readonly live = new Map<string, { callId: string; leg: 'OPERATOR' | 'ATM' }>();
  private readonly timers = new Map<string, NodeJS.Timeout[]>();

  constructor(
    readonly node: string,
    private readonly opts: SimulationOptions = { operatorLegDelayMs: 300, ringDelayMs: 500, answerDelayMs: 1500 },
  ) {}

  async start(onSignal: (s: SipSignal) => void) {
    this.emit = onSignal;
    this.emit({ type: 'DRIVER_STATE', connected: true, detail: 'simulator ready' });
  }

  async stop() {
    for (const ts of this.timers.values()) ts.forEach(clearTimeout);
    this.timers.clear();
  }

  private later(callId: string, ms: number, fn: () => void) {
    const t = setTimeout(fn, ms);
    this.timers.set(callId, [...(this.timers.get(callId) ?? []), t]);
  }

  private attempt = 0;

  simulateOperatorLeg(callId: string, token: string, operatorEndpoint: string) {
    const channelId = `sim-op-${callId}-${++this.attempt}`;
    this.later(callId, this.opts.operatorLegDelayMs, () => {
      this.live.set(channelId, { callId, leg: 'OPERATOR' });
      this.emit({ type: 'OPERATOR_LEG', callId, token, channelId, endpoint: operatorEndpoint, node: this.node });
    });
  }

  async dialAtm(req: DialRequest) {
    this.live.set(req.atmChannelId, { callId: req.callId, leg: 'ATM' });
    const user = req.atmSipUsername;
    if (this.opts.busy?.has(user)) {
      this.later(req.callId, this.opts.ringDelayMs, () => this.end(req.atmChannelId, 17, 'User busy'));
      return;
    }
    this.later(req.callId, this.opts.ringDelayMs, () => this.emit({ type: 'ATM_RINGING', callId: req.callId, channelId: req.atmChannelId }));
    if (this.opts.noAnswer?.has(user)) return;
    this.later(req.callId, this.opts.answerDelayMs, () => {
      if (this.live.has(req.atmChannelId)) this.emit({ type: 'ATM_ANSWERED', callId: req.callId, channelId: req.atmChannelId });
    });
  }

  async connect(_call: CallPlumbing) {
    /* bridging is implicit in the simulator */
  }

  async rejectOperatorLeg(channelId: string) {
    this.end(channelId, 21, 'Call rejected');
  }

  private end(channelId: string, q850: number, reason: string) {
    const leg = this.live.get(channelId);
    if (!leg) return;
    this.live.delete(channelId);
    this.emit({ type: 'LEG_ENDED', callId: leg.callId, leg: leg.leg, channelId, q850, sipCode: null, reason });
  }

  async hangup(call: CallPlumbing) {
    for (const t of this.timers.get(call.callId) ?? []) clearTimeout(t);
    this.timers.delete(call.callId);
    for (const id of [call.operatorChannelId, call.atmChannelId]) if (id) setTimeout(() => this.end(id, 16, 'Normal clearing'), 50);
  }

  async liveChannelIds() {
    return new Set(this.live.keys());
  }

  async health(): Promise<DriverHealth> {
    return { name: this.name, node: this.node, connected: true, detail: `simulator, ${this.live.size} live legs`, latencyMs: 0 };
  }

  /** Test hook: the ATM (or operator browser) hangs up. */
  remoteHangup(channelId: string) {
    this.end(channelId, 16, 'Remote hangup');
  }
}
