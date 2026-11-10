import { Logger, OnModuleDestroy } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { OnGatewayConnection, OnGatewayInit, WebSocketGateway } from '@nestjs/websockets';
import { Permission, type EventEnvelope } from '@wintek/shared';
import type { WebSocket, Server } from 'ws';
import { z } from 'zod';
import type { AccessTokenClaims, AuthUser } from '../../common/auth/auth-user';
import { userFromClaims } from '../../common/auth/guards';
import { EventBusService } from './event-bus.service';
import { PresenceService } from '../operators/presence.service';

const ClientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('auth'), token: z.string().min(10), since: z.record(z.number().int().nonnegative()).optional() }),
  z.object({ type: z.literal('heartbeat'), sipRegistered: z.boolean(), mediaFault: z.boolean().optional() }),
  z.object({ type: z.literal('replay'), orgId: z.string().uuid(), since: z.number().int().nonnegative() }),
  z.object({ type: z.literal('ping') }),
]);

interface ClientState {
  user: AuthUser | null;
  alive: boolean;
  authTimer: NodeJS.Timeout;
}

/**
 * WebSocket endpoint at /ws.
 *
 *   client -> {type:'auth', token, since:{[orgId]: lastSeq}}   (within 5 s of connecting)
 *   server -> {type:'ready', seq:{[orgId]: currentSeq}} then replayed events, or system.resync_required
 *   server -> EventEnvelope ...
 *   client -> {type:'heartbeat', sipRegistered, mediaFault}    (operators, every 10 s)
 *
 * Browsers can't send headers on a WebSocket upgrade, so the access token is
 * sent as the first message instead of in the URL (URLs end up in proxy logs).
 */
@WebSocketGateway({ path: '/ws' })
export class EventsGateway implements OnGatewayConnection, OnGatewayInit, OnModuleDestroy {
  private readonly log = new Logger(EventsGateway.name);
  private readonly clients = new Map<WebSocket, ClientState>();
  private pingTimer?: NodeJS.Timeout;
  private unsubscribe?: () => void;

  constructor(
    private readonly jwt: JwtService,
    private readonly bus: EventBusService,
    private readonly presence: PresenceService,
  ) {}

  afterInit(_server: Server) {
    this.unsubscribe = this.bus.on((e) => this.fanOut(e));
    this.pingTimer = setInterval(() => {
      for (const [ws, st] of this.clients) {
        if (!st.alive) {
          ws.terminate();
          continue;
        }
        st.alive = false;
        ws.ping();
      }
    }, 15_000);
  }

  onModuleDestroy() {
    clearInterval(this.pingTimer);
    this.unsubscribe?.();
  }

  get connectionCount() {
    return this.clients.size;
  }

  handleConnection(ws: WebSocket) {
    const st: ClientState = {
      user: null,
      alive: true,
      authTimer: setTimeout(() => ws.close(4401, 'auth timeout'), 5_000),
    };
    this.clients.set(ws, st);
    ws.on('pong', () => (st.alive = true));
    ws.on('close', () => {
      clearTimeout(st.authTimer);
      this.clients.delete(ws);
    });
    ws.on('message', (raw) => {
      void this.onMessage(ws, st, raw.toString()).catch((e) => this.log.warn(`ws message failed: ${e.message}`));
    });
  }

  private send(ws: WebSocket, payload: unknown) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
  }

  private async onMessage(ws: WebSocket, st: ClientState, raw: string) {
    if (raw.length > 8192) return ws.close(4400, 'message too large');
    let msg: z.infer<typeof ClientMessage>;
    try {
      msg = ClientMessage.parse(JSON.parse(raw));
    } catch {
      return this.send(ws, { type: 'error', code: 'BAD_MESSAGE' });
    }
    if (msg.type === 'ping') return this.send(ws, { type: 'pong', ts: Date.now() });

    if (msg.type === 'auth') {
      try {
        const claims = await this.jwt.verifyAsync<AccessTokenClaims>(msg.token, { algorithms: ['HS256'] });
        if (claims.typ !== 'access') throw new Error('wrong type');
        st.user = userFromClaims(claims);
      } catch {
        return ws.close(4401, 'invalid token');
      }
      clearTimeout(st.authTimer);
      const orgs = st.user.organizationId ? [st.user.organizationId] : Object.keys(msg.since ?? {});
      const seq: Record<string, number> = {};
      for (const o of orgs) seq[o] = await this.bus.currentSeq(o);
      this.send(ws, { type: 'ready', seq, nodeTime: new Date().toISOString() });
      for (const [org, since] of Object.entries(msg.since ?? {})) await this.replay(ws, st.user, org, since);
      return;
    }

    if (!st.user) return ws.close(4401, 'not authenticated');

    if (msg.type === 'replay') return this.replay(ws, st.user, msg.orgId, msg.since);

    if (msg.type === 'heartbeat') {
      if (!st.user.operatorId || !st.user.permissions.has(Permission.PRESENCE_SELF)) return;
      await this.presence.heartbeat(st.user, { sipRegistered: msg.sipRegistered, mediaFault: msg.mediaFault ?? false });
    }
  }

  private async replay(ws: WebSocket, user: AuthUser, orgId: string, since: number) {
    if (!this.canSee(user, orgId)) return;
    const events = await this.bus.replay(orgId, since);
    if (events === null) return this.send(ws, this.bus.resyncEnvelope(orgId, 'replay window exceeded'));
    for (const e of events) this.send(ws, e);
  }

  private canSee(user: AuthUser, orgId: string) {
    return user.permissions.has(Permission.CROSS_TENANT) || user.organizationId === orgId;
  }

  private fanOut(e: EventEnvelope) {
    const json = JSON.stringify(e);
    for (const [ws, st] of this.clients) {
      if (st.user && this.canSee(st.user, e.orgId) && ws.readyState === ws.OPEN) ws.send(json);
    }
  }
}
