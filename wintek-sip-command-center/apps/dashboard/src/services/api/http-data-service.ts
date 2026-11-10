import type { Availability, Priority } from '@wintek/shared';
import type { AtmFilters, AuditFilters, Session } from '@/types/api';
import { RealtimeClient } from '../realtime';
import { ApiError, type DataService, type RealtimeHandlers } from './data-service';

const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? '/api/v1';

const qs = (o: Record<string, unknown>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

/**
 * REST client. The access token lives only in memory; the refresh token is an
 * httpOnly cookie the browser sends to /auth/refresh. A 401 triggers one
 * coalesced refresh and a single retry.
 */
export class HttpDataService implements DataService {
  readonly kind = 'api' as const;
  private token: string | null = null;
  private refreshing: Promise<Session> | null = null;
  onSessionLost: () => void = () => undefined;
  onSession: (s: Session) => void = () => undefined;

  private async req<T>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
    const res = await fetch(BASE + path, {
      method,
      credentials: 'include',
      headers: {
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && !retried && !path.startsWith('/auth/')) {
      try {
        await this.refresh();
      } catch {
        this.onSessionLost();
        throw new ApiError(401, 'SESSION_EXPIRED', 'Your session has expired');
      }
      return this.req<T>(method, path, body, true);
    }
    const text = await res.text();
    const data = text ? JSON.parse(text) : undefined;
    if (!res.ok) {
      throw new ApiError(res.status, data?.code ?? `HTTP_${res.status}`, data?.message ?? res.statusText, data?.details, data?.correlationId);
    }
    return data as T;
  }

  private get = <T>(p: string) => this.req<T>('GET', p);
  private post = <T>(p: string, b: unknown = {}) => this.req<T>('POST', p, b);

  async login(username: string, password: string) {
    const s = await this.req<Session>('POST', '/auth/login', { username, password });
    this.token = s.accessToken;
    this.onSession(s);
    return s;
  }

  refresh() {
    this.refreshing ??= this.req<Session>('POST', '/auth/refresh', {})
      .then((s) => {
        this.token = s.accessToken;
        this.onSession(s);
        return s;
      })
      .finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  async logout() {
    await this.req('POST', '/auth/logout', {}).catch(() => undefined);
    this.token = null;
  }

  me = () => this.get<any>('/auth/me');
  summary = () => this.get<any>('/dashboard/summary');
  activity = (limit = 50) => this.get<any>(`/dashboard/activity${qs({ limit })}`);
  regionStats = () => this.get<any>('/dashboard/regions');
  callsReport = (r: Record<string, unknown>) => this.get<any>(`/reports/calls${qs(r)}`);
  availabilityReport = (r: Record<string, unknown>) => this.get<any>(`/reports/availability${qs(r)}`);
  health = () => this.get<any>('/system/health');

  atms = (f: AtmFilters) => this.get<any>(`/atms${qs({ ...f })}`);
  atm = (id: string) => this.get<any>(`/atms/${id}`);
  regions = () => this.get<any>('/atms/regions');
  groups = () => this.get<any>('/atms/groups');
  createAtm = (b: Record<string, unknown>) => this.post<any>('/atms', b);
  updateAtm = (id: string, b: Record<string, unknown>) => this.req<any>('PATCH', `/atms/${id}`, b);
  rotateCredentials = (id: string) => this.post<any>(`/atms/${id}/credentials/rotate`);
  bulkAtms = (b: { atmIds: string[]; action: string; targetId?: string | null }) => this.post<any>('/atms/bulk', b);
  importAtms = (csv: string, dryRun: boolean) => this.post<any>(`/atms/import${qs({ dryRun })}`, { csv });

  operators = (f: Record<string, unknown> = {}) => this.get<any>(`/operators${qs({ pageSize: 500, ...f })}`);
  operator = (id: string) => this.get<any>(`/operators/${id}`);
  setPresence = (availability: Availability) => this.req<any>('PUT', '/operators/me/presence', { availability });
  heartbeat = async (sipRegistered: boolean, mediaFault: boolean) => {
    await this.post('/operators/me/heartbeat', { sipRegistered, mediaFault });
  };
  webrtcCredentials = () => this.post<any>('/operators/me/webrtc-credentials');

  assignments = (f: Record<string, unknown>) => this.get<any>(`/assignments${qs(f)}`);
  setAssignment = (atmId: string, b: unknown) => this.req<any>('PUT', `/assignments/${atmId}`, b);
  overrides = (activeOnly = true) => this.get<any>(`/assignment-overrides${qs({ activeOnly })}`);
  createOverride = (b: unknown) => this.post<any>('/assignment-overrides', b);
  revokeOverride = async (id: string) => {
    await this.req('DELETE', `/assignment-overrides/${id}`);
  };
  resolve = (atmId: string) => this.get<any>(`/assignments/${atmId}/resolve`);

  shifts = () => this.get<any>('/shifts');
  saveShift = (b: any) => (b.id ? this.req<any>('PUT', `/shifts/${b.id}`, { ...b, id: undefined }) : this.post<any>('/shifts', b));
  setShiftMembers = (id: string, operatorIds: string[]) => this.req<any>('PUT', `/shifts/${id}/members`, { operatorIds });

  initiateCall = (b: { atmId: string; requestId: string; priority?: Priority; queueIfBusy?: boolean; queueItemId?: string }) => this.post<any>('/calls/initiate', b);
  hangup = (id: string) => this.post<any>(`/calls/${id}/hangup`);
  call = (id: string) => this.get<any>(`/calls/${id}/status`);
  activeCalls = () => this.get<any>('/calls');
  myCall = () => this.get<any>('/calls/mine');
  callHistory = (f: Record<string, unknown>) => this.get<any>(`/call-history${qs(f)}`);

  queue = (includeClosed = false) => this.get<any>(`/queue${qs({ includeClosed })}`);
  enqueue = (b: unknown) => this.post<any>('/queue', b);
  cancelQueue = async (id: string) => {
    await this.req('DELETE', `/queue/${id}`);
  };
  declineQueue = async (id: string) => {
    await this.post(`/queue/${id}/decline`);
  };

  audit = (f: AuditFilters) => this.get<any>(`/audit${qs({ ...f })}`);
  organizations = () => this.get<any>('/admin/organizations');
  users = () => this.get<any>('/admin/users');
  roles = () => this.get<any>('/admin/roles');
  createUser = (b: unknown) => this.post<any>('/admin/users', b);
  updateUser = (id: string, b: unknown) => this.req<any>('PATCH', `/admin/users/${id}`, b);
  createRegion = (b: unknown) => this.post<any>('/admin/regions', b);
  createGroup = (b: unknown) => this.post<any>('/admin/groups', b);
  routingPolicies = () => this.get<any>('/routing-policies');
  saveRoutingPolicy = (b: unknown) => this.req<any>('PUT', '/routing-policies', b);
  settings = () => this.get<any>('/admin/settings');
  putSetting = (key: string, value: unknown) => this.req<any>('PUT', `/admin/settings/${encodeURIComponent(key)}`, { value });

  subscribe(h: RealtimeHandlers) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = (import.meta.env.VITE_WS_URL as string | undefined) ?? `${proto}://${location.host}/ws`;
    const client = new RealtimeClient(url, async () => this.token, h);
    client.start();
    return () => client.stop();
  }
}
