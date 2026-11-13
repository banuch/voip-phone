import type { EventEnvelope } from '@wintek/shared';
import type { ConnectionState, RealtimeHandlers } from './api/data-service';

/**
 * Applies at-least-once, possibly reordered events exactly once and in order
 * per organization stream:
 *  - duplicates (same id, or seq already applied) are dropped,
 *  - a gap (seq > last + 1) is held briefly and a replay is requested,
 *  - if the gap can't be filled, the caller is told to resync from REST.
 * seq = 0 means "unsequenced" (server degraded): applied as is.
 */
export class EventSequencer {
  private last = new Map<string, number>();
  private seen = new Set<string>();
  private seenOrder: string[] = [];
  private pending = new Map<string, Map<number, EventEnvelope>>();
  private gapTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly apply: (e: EventEnvelope) => void,
    private readonly requestReplay: (orgId: string, since: number) => void,
    private readonly onGapUnfilled: (orgId: string) => void,
    private readonly gapWaitMs = 1500,
  ) {}

  lastSeq(): Record<string, number> {
    return Object.fromEntries(this.last);
  }

  /** Baseline from the server's `ready` message, after a REST snapshot was (re)loaded. */
  reset(seq: Record<string, number>) {
    this.last = new Map(Object.entries(seq));
    this.pending.clear();
    this.gapTimers.forEach(clearTimeout);
    this.gapTimers.clear();
  }

  private remember(id: string) {
    this.seen.add(id);
    this.seenOrder.push(id);
    if (this.seenOrder.length > 2000) this.seen.delete(this.seenOrder.shift()!);
  }

  push(e: EventEnvelope) {
    if (this.seen.has(e.id)) return;
    if (!e.seq) {
      this.remember(e.id);
      this.apply(e);
      return;
    }
    const last = this.last.get(e.orgId);
    if (last === undefined) {
      // First sight of this stream: accept as baseline.
      this.last.set(e.orgId, e.seq);
      this.remember(e.id);
      this.apply(e);
      return;
    }
    if (e.seq <= last) return; // already applied (replay overlap)
    if (e.seq === last + 1) {
      this.remember(e.id);
      this.apply(e);
      this.last.set(e.orgId, e.seq);
      this.drain(e.orgId);
      return;
    }
    // Gap: hold, ask for the missing range once, give up after a short wait.
    const buf = this.pending.get(e.orgId) ?? new Map<number, EventEnvelope>();
    buf.set(e.seq, e);
    this.pending.set(e.orgId, buf);
    if (!this.gapTimers.has(e.orgId)) {
      this.requestReplay(e.orgId, last);
      this.gapTimers.set(
        e.orgId,
        setTimeout(() => {
          this.gapTimers.delete(e.orgId);
          if ((this.pending.get(e.orgId)?.size ?? 0) > 0) {
            this.pending.delete(e.orgId);
            this.last.delete(e.orgId);
            this.onGapUnfilled(e.orgId);
          }
        }, this.gapWaitMs),
      );
    }
  }

  private drain(orgId: string) {
    const buf = this.pending.get(orgId);
    if (!buf) return;
    for (;;) {
      const next = (this.last.get(orgId) ?? 0) + 1;
      const e = buf.get(next);
      if (!e) break;
      buf.delete(next);
      this.remember(e.id);
      this.apply(e);
      this.last.set(orgId, next);
    }
    if (buf.size === 0) {
      this.pending.delete(orgId);
      const t = this.gapTimers.get(orgId);
      if (t) clearTimeout(t);
      this.gapTimers.delete(orgId);
    }
  }
}

/** WebSocket transport with auth handshake, heartbeats, exponential backoff and replay on reconnect. */
export class RealtimeClient {
  private ws: WebSocket | null = null;
  private stopped = false;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly seq: EventSequencer;

  constructor(
    private readonly url: string,
    private readonly getToken: () => Promise<string | null>,
    private readonly h: RealtimeHandlers,
  ) {
    this.seq = new EventSequencer(
      (e) => (e.type === 'system.resync_required' ? h.onResync(String((e.data as any)?.reason ?? 'resync')) : h.onEvent(e)),
      (orgId, since) => this.send({ type: 'replay', orgId, since }),
      () => h.onResync('event gap'),
    );
  }

  start() {
    this.stopped = false;
    void this.open();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close(1000, 'client stop');
    this.ws = null;
  }

  send(msg: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private async open() {
    if (this.stopped) return;
    this.h.onState(this.attempt === 0 ? 'connecting' : 'reconnecting');
    const token = await this.getToken();
    if (this.stopped) return; // stopped while awaiting the token (e.g. React StrictMode remount)
    if (!token) return this.retry('no session');
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token, since: this.seq.lastSeq() }));
    ws.onmessage = (m) => {
      let msg: any;
      try {
        msg = JSON.parse(m.data as string);
      } catch {
        return;
      }
      if (msg.type === 'ready') {
        const resumed = this.attempt > 0;
        this.attempt = 0;
        this.h.onState('open');
        // Reconnected: replay was requested with our last seq; if nothing was
        // known yet, take the server's sequence as baseline.
        if (!resumed || Object.keys(this.seq.lastSeq()).length === 0) this.seq.reset(msg.seq ?? {});
        return;
      }
      if (msg.type === 'pong' || msg.type === 'error') return;
      if (msg.id && msg.type) this.seq.push(msg as EventEnvelope);
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.retry(ev.code === 4401 ? 'authentication' : `closed ${ev.code}`);
    };
    ws.onerror = () => undefined;
  }

  private retry(detail: string) {
    if (this.stopped) return;
    this.attempt++;
    this.h.onState(this.attempt > 3 ? 'offline' : 'reconnecting', detail);
    const delay = Math.min(30_000, 500 * 2 ** Math.min(this.attempt, 6)) * (0.75 + Math.random() * 0.5);
    this.timer = setTimeout(() => void this.open(), delay);
  }
}

export type { ConnectionState };
