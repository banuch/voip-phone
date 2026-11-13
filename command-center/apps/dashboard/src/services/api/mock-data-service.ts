import {
  ACTIVE_CALL_STATES, EVENT_SCHEMA_VERSION, ROLE_LABEL, ROLE_PERMISSIONS, eventTypeForCallState, sortQueue,
  type Availability, type CallState, type EventEnvelope, type EventType, type Priority, type Role,
} from '@wintek/shared';
import type {
  ActivityItem, Assignment, Atm, AtmDetail, AtmFilters, AuditEntry, AuditFilters, CallView, CallsReport, DashboardSummary,
  InitiateResult, Operator, Override, Page, QueueItem, RegionRef, Session, SessionUser, Shift, SystemHealth,
} from '@/types/api';
import { uuid } from '@/lib/utils';
import { ApiError, type DataService, type RealtimeHandlers } from './data-service';

/*
 * In-browser simulation of the platform for UI development (VITE_DATA_SOURCE=mock).
 * It follows the same rules as the server (one call per ATM/operator,
 * authorization by assignment/region, CONNECTED only after "answer") so UI
 * behaviour matches production. Nothing here is used in API mode.
 */

let s = 20261110;
const rnd = () => {
  // mulberry32: exact 32-bit integer math (a naive LCG overflows JS doubles and cycles early)
  s = (s + 0x6d2b79f5) | 0;
  let t = Math.imul(s ^ (s >>> 15), 1 | s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = <T,>(a: readonly T[]) => a[Math.floor(rnd() * a.length)]!;
const iso = (t: number) => new Date(t).toISOString();
const delay = (ms = 120) => new Promise((r) => setTimeout(r, ms + Math.random() * 80));

const ORG = { id: '00000000-0000-4000-8000-000000000001', name: 'Demo National Bank' };
const REGIONS = [
  { id: 'r-north', code: 'NORTH', name: 'North Zone', cities: ['Delhi', 'Chandigarh', 'Lucknow', 'Jaipur'] },
  { id: 'r-west', code: 'WEST', name: 'West Zone', cities: ['Mumbai', 'Pune', 'Ahmedabad', 'Surat'] },
  { id: 'r-south', code: 'SOUTH', name: 'South Zone', cities: ['Chennai', 'Bengaluru', 'Hyderabad', 'Kochi'] },
  { id: 'r-east', code: 'EAST', name: 'East Zone', cities: ['Kolkata', 'Bhubaneswar', 'Patna', 'Guwahati'] },
];
const GROUPS = [
  { id: 'g-off', code: 'OFFSITE', name: 'Off-site ATMs' },
  { id: 'g-on', code: 'ONSITE', name: 'Branch ATMs' },
  { id: 'g-risk', code: 'HIGHRISK', name: 'High-risk locations' },
];
const SITES = ['Main Road', 'Market', 'Railway Station', 'Mall', 'Bus Stand', 'Hospital', 'University', 'Airport', 'Industrial Area'];
const NAMES = ['Aarav Sharma', 'Diya Iyer', 'Kabir Khan', 'Meera Patel', 'Rohan Das', 'Isha Reddy', 'Vikram Nair', 'Anaya Singh', 'Arjun Sharma', 'Kavya Iyer', 'Neel Khan', 'Priya Patel', 'Sameer Das', 'Tara Reddy', 'Yash Nair', 'Zoya Singh'];

const USERS: Record<string, { name: string; roles: Role[]; op?: number }> = {
  superadmin: { name: 'Platform Super Admin', roles: ['SUPER_ADMIN'] },
  orgadmin: { name: 'Org Administrator', roles: ['ORG_ADMIN'] },
  supervisor: { name: 'Shift Supervisor', roles: ['SUPERVISOR'], op: 16 },
  operator1: { name: 'Aarav Sharma', roles: ['OPERATOR'], op: 0 },
  auditor: { name: 'Compliance Auditor', roles: ['AUDITOR'] },
};

interface MockCall extends CallView {
  timers: ReturnType<typeof setTimeout>[];
}

export class MockDataService implements DataService {
  readonly kind = 'mock' as const;
  private user: SessionUser | null = null;
  private atmsList: Atm[] = [];
  private ops: Operator[] = [];
  private calls = new Map<string, MockCall>();
  private history: CallView[] = [];
  private queueItems: QueueItem[] = [];
  private auditLog: AuditEntry[] = [];
  private overridesList: Override[] = [];
  private shiftList: Shift[] = [];
  private listeners = new Set<RealtimeHandlers>();
  private seq = 0;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private requestIds = new Map<string, string>();

  constructor(nAtms = 2000) {
    this.ops = NAMES.map((name, i) => {
      const region = REGIONS[Math.floor(i / 4) % 4]!;
      const avail: Availability = i === 0 ? 'OFFLINE' : pick(['AVAILABLE', 'AVAILABLE', 'AVAILABLE', 'BREAK', 'UNAVAILABLE', 'OFFLINE'] as const);
      return this.mkOperator(`op-${i}`, i === 0 ? 'operator1' : `op.${region.code.toLowerCase()}${(i % 4) + 1}`, name, ['OPERATOR'], [region], avail);
    });
    this.ops.push(this.mkOperator('op-16', 'supervisor', 'Shift Supervisor', ['SUPERVISOR'], REGIONS, 'OFFLINE'));

    for (let i = 0; i < nAtms; i++) {
      const region = REGIONS[i % 4]!;
      const city = pick(region.cities);
      const regionOps = this.ops.filter((o) => o.regions[0]?.id === region.id && o.roles.includes('OPERATOR'));
      const p = regionOps[Math.floor(rnd() * regionOps.length)]!;
      const b = regionOps.find((o) => o.id !== p.id)!;
      const online = rnd() < 0.94;
      const code = `ATM-${region.code.slice(0, 2)}-${String(i + 1).padStart(5, '0')}`;
      const site = `${city} ${pick(SITES)}`;
      this.atmsList.push({
        id: `atm-${i}`, atmCode: code, name: `${site} ${i + 1}`, organizationId: ORG.id, organizationName: ORG.name,
        regionId: region.id, regionName: region.name, state: null, city, site, sipUsername: `atm-${code.toLowerCase()}`,
        deviceModel: 'WINTEK-ESP32S3-INTERCOM', firmwareVersion: rnd() < 0.8 ? '1.4.2' : '1.3.9', status: rnd() < 0.01 ? 'MAINTENANCE' : 'ACTIVE',
        registrationStatus: online ? 'REGISTERED' : rnd() < 0.5 ? 'UNREGISTERED' : 'EXPIRED',
        health: !online ? 'UNKNOWN' : rnd() < 0.015 ? 'FAULT' : rnd() < 0.02 ? 'DEGRADED' : 'OK',
        lastRegisteredAt: iso(Date.now() - rnd() * 86_400_000 * 5), lastSeenAt: iso(Date.now() - (online ? rnd() * 240_000 : rnd() * 86_400_000 * 2)),
        contactIp: online ? `10.${20 + (i % 4)}.${Math.floor(i / 250)}.${(i % 250) + 2}` : null, userAgent: 'WintekIntercom/1.4.2',
        vmsCameraRef: `CAM-${code}`, vmsDeepLink: 'https://vms.example.internal/live?camera={cameraRef}',
        primaryOperatorId: p.id, primaryOperatorName: p.name, backupOperatorId: b.id, backupOperatorName: b.name,
        overrideOperatorId: null, overrideOperatorName: null, overrideEndsAt: null,
        assignedOperatorId: p.id, assignedOperatorName: p.name, activeCallId: null, activeCallState: null, activeCallOperatorName: null,
        queueItemId: null, queuePriority: null, groups: [rnd() < 0.6 ? GROUPS[0]! : GROUPS[1]!, ...(rnd() < 0.1 ? [GROUPS[2]!] : [])], version: 1,
      });
    }
    // Seven days of history for charts.
    for (let i = 0; i < 3500; i++) {
      const a = pick(this.atmsList);
      const op = this.ops.find((o) => o.id === a.primaryOperatorId)!;
      const r = rnd();
      const state: CallState = r < 0.82 ? 'COMPLETED' : r < 0.88 ? 'TIMEOUT' : r < 0.93 ? 'FAILED' : r < 0.97 ? 'CANCELLED' : 'BUSY';
      const t = Date.now() - rnd() * 7 * 86_400_000;
      const dur = state === 'COMPLETED' ? (20 + rnd() * 240) * 1000 : null;
      this.history.push(this.mkCallView(uuid(), a, op, state, rnd() < 0.05 ? 'P1' : 'P3', t, state === 'COMPLETED' ? t + 3000 : null, dur ? t + 3000 + dur : t + 30_000));
    }
    this.history.sort((x, y) => +new Date(y.requestedAt) - +new Date(x.requestedAt));
    this.shiftList = [
      { id: 'sh-day', name: 'Day shift', regionId: null, regionName: null, daysOfWeek: [1, 2, 3, 4, 5, 6, 7], startTime: '06:00', endTime: '14:00', timezone: 'Asia/Kolkata', members: this.ops.slice(0, 6).map((o) => ({ operatorId: o.id, name: o.name, validFrom: '2026-01-01', validTo: null, onShift: true })), version: 1 },
      { id: 'sh-eve', name: 'Evening shift', regionId: null, regionName: null, daysOfWeek: [1, 2, 3, 4, 5, 6, 7], startTime: '14:00', endTime: '22:00', timezone: 'Asia/Kolkata', members: this.ops.slice(6, 12).map((o) => ({ operatorId: o.id, name: o.name, validFrom: '2026-01-01', validTo: null, onShift: false })), version: 1 },
      { id: 'sh-night', name: 'Night shift', regionId: null, regionName: null, daysOfWeek: [1, 2, 3, 4, 5, 6, 7], startTime: '22:00', endTime: '06:00', timezone: 'Asia/Kolkata', members: this.ops.slice(12).map((o) => ({ operatorId: o.id, name: o.name, validFrom: '2026-01-01', validTo: null, onShift: false })), version: 1 },
    ];
    for (let i = 0; i < 60; i++) {
      const op = pick(this.ops);
      this.audit_(pick(['auth.login', 'presence.selected', 'call.initiated', 'call.ended', 'assignment.updated', 'atm.updated']), op.username, 'SUCCESS', 'operator', op.id, Date.now() - rnd() * 86_400_000);
    }
    this.auditLog.sort((a, b) => +new Date(b.occurredAt) - +new Date(a.occurredAt));
  }

  private mkOperator(id: string, username: string, name: string, roles: Role[], regions: typeof REGIONS, availability: Availability): Operator {
    return {
      id, organizationId: ORG.id, organizationName: ORG.name, userId: `u-${id}`, username, name, email: null, accountStatus: 'ACTIVE',
      lastLoginAt: iso(Date.now() - rnd() * 3_600_000 * 20), employeeCode: username.toUpperCase(), routingPriority: 100, status: 'ACTIVE',
      selectedAvailability: availability, availability, sipRegistered: availability !== 'OFFLINE', lastHeartbeatAt: iso(Date.now()),
      sipUsername: `op-${username}`, roles, regions: regions.map((r) => ({ id: r.id, name: r.name })), groups: [],
      primaryAssignments: 0, backupAssignments: 0, currentCall: null, onShift: true, version: 1,
    };
  }

  private mkCallView(id: string, a: Atm, op: Operator, state: CallState, priority: Priority, t: number, answered: number | null, ended: number | null): CallView {
    return {
      id, organizationId: ORG.id, atmId: a.id, atmCode: a.atmCode, atmName: a.name, regionName: a.regionName, operatorId: op.id, operatorName: op.name,
      state, priority, routingDecision: 'PRIMARY', correlationId: uuid(), sipCode: state === 'COMPLETED' ? 200 : state === 'TIMEOUT' ? 408 : state === 'BUSY' ? 486 : state === 'FAILED' ? 503 : null,
      failureReason: state === 'TIMEOUT' ? 'ATM did not answer' : state === 'FAILED' ? 'media node unreachable' : null,
      hangupBy: state === 'COMPLETED' ? 'OPERATOR' : null, mediaNode: 'asterisk-1', requestedAt: iso(t), answeredAt: answered ? iso(answered) : null,
      endedAt: ended ? iso(ended) : null, durationMs: answered && ended ? ended - answered : null, version: 1,
    };
  }

  private audit_(action: string, actor: string | null, outcome: AuditEntry['outcome'], entityType: string, entityId: string, t = Date.now(), detail: Record<string, unknown> | null = null) {
    this.auditLog.unshift({ id: String(this.auditLog.length + 1), organizationId: ORG.id, actorUserId: null, actorUsername: actor, action, entityType, entityId, outcome, ip: '10.0.0.15', correlationId: uuid(), detail, occurredAt: iso(t) });
  }

  // ---------------------------------------------------------------- events
  private emit(type: EventType, entityType: EventEnvelope['entityType'], entityId: string, data: unknown) {
    const e: EventEnvelope = { id: uuid(), type, schemaVersion: EVENT_SCHEMA_VERSION, ts: iso(Date.now()), orgId: ORG.id, entityType, entityId, seq: ++this.seq, entityVersion: this.seq, correlationId: null, data };
    for (const l of this.listeners) l.onEvent(e);
  }

  subscribe(h: RealtimeHandlers) {
    this.listeners.add(h);
    h.onState('connecting');
    setTimeout(() => h.onState('open'), 300);
    this.ticker ??= setInterval(() => this.simulateBackground(), 2500);
    return () => {
      this.listeners.delete(h);
      if (!this.listeners.size && this.ticker) {
        clearInterval(this.ticker);
        this.ticker = null;
      }
    };
  }

  /** Background life: registrations flap, other operators place calls. */
  private simulateBackground() {
    if (rnd() < 0.6) {
      const a = pick(this.atmsList);
      if (!a.activeCallId) {
        a.registrationStatus = a.registrationStatus === 'REGISTERED' ? (rnd() < 0.5 ? 'UNREGISTERED' : 'EXPIRED') : 'REGISTERED';
        a.health = a.registrationStatus === 'REGISTERED' ? 'OK' : 'UNKNOWN';
        a.lastSeenAt = iso(Date.now());
        a.version++;
        this.emit('atm.registration.changed', 'atm', a.id, { atmId: a.id, registration: a.registrationStatus, health: a.health, inCall: false, lastSeenAt: a.lastSeenAt });
      }
    }
    const busyOthers = [...this.calls.values()].filter((c) => c.operatorId !== this.user?.operatorId);
    if (rnd() < 0.35 && busyOthers.length < 6) {
      const op = this.ops.find((o) => o.availability === 'AVAILABLE' && o.id !== this.user?.operatorId && !o.currentCall);
      const a = op && this.atmsList.find((x) => x.primaryOperatorId === op.id && x.registrationStatus === 'REGISTERED' && !x.activeCallId && rnd() < 0.05);
      if (op && a) this.startCall(a, op, rnd() < 0.1 ? 'P2' : 'P3', 4000 + rnd() * 20_000);
    }
  }

  // ---------------------------------------------------------------- call simulation
  private setCallState(c: MockCall, state: CallState) {
    c.state = state;
    c.version++;
    const now = Date.now();
    if (state === 'CONNECTED') c.answeredAt = iso(now);
    const a = this.atmsList.find((x) => x.id === c.atmId)!;
    const op = this.ops.find((o) => o.id === c.operatorId)!;
    const terminal = !ACTIVE_CALL_STATES.has(state);
    if (terminal) {
      c.endedAt = iso(now);
      c.durationMs = c.answeredAt ? now - +new Date(c.answeredAt) : null;
      c.timers.forEach(clearTimeout);
      this.calls.delete(c.id);
      const { timers: _t, ...view } = c;
      this.history.unshift(view);
      a.activeCallId = null;
      a.activeCallState = null;
      a.activeCallOperatorName = null;
      op.currentCall = null;
      op.availability = op.selectedAvailability === 'AVAILABLE' ? 'AVAILABLE' : op.selectedAvailability;
      this.audit_('call.ended', null, 'SUCCESS', 'call', c.id, now, { state });
      this.dispatchQueue();
    } else {
      a.activeCallId = c.id;
      a.activeCallState = state;
      a.activeCallOperatorName = op.name;
      op.currentCall = { id: c.id, atmId: a.id, state, answeredAt: c.answeredAt };
      op.availability = 'BUSY';
    }
    a.version++;
    op.version++;
    this.emit(eventTypeForCallState(state), 'call', c.id, {
      callId: c.id, atmId: a.id, atmCode: a.atmCode, atmName: a.name, operatorId: op.id, operatorName: op.name, state, priority: c.priority,
      requestedAt: c.requestedAt, correlationId: c.correlationId, answeredAt: c.answeredAt, endedAt: c.endedAt, sipCode: c.sipCode, reason: c.failureReason,
    });
    this.emit('operator.presence.changed', 'operator', op.id, { operatorId: op.id, selected: op.selectedAvailability, effective: op.availability, currentCallId: op.currentCall?.id ?? null });
  }

  private startCall(a: Atm, op: Operator, priority: Priority, autoHangupMs?: number): MockCall {
    const c: MockCall = { ...this.mkCallView(uuid(), a, op, 'RESERVED', priority, Date.now(), null, null), timers: [] };
    c.routingDecision = a.primaryOperatorId === op.id ? 'PRIMARY' : a.backupOperatorId === op.id ? 'BACKUP' : 'DYNAMIC';
    this.calls.set(c.id, c);
    this.setCallState(c, 'RESERVED');
    const t = (ms: number, fn: () => void) => c.timers.push(setTimeout(fn, ms));
    t(400, () => this.setCallState(c, 'DIALING'));
    t(900, () => this.setCallState(c, 'RINGING'));
    if (a.health === 'FAULT') {
      t(4000, () => {
        c.failureReason = 'ATM did not answer';
        c.sipCode = 408;
        this.setCallState(c, 'TIMEOUT');
      });
    } else {
      t(2200, () => {
        c.sipCode = 200;
        this.setCallState(c, 'CONNECTED');
      });
    }
    if (autoHangupMs) t(2200 + autoHangupMs, () => this.endCall(c, 'ATM'));
    return c;
  }

  private endCall(c: MockCall, by: string) {
    if (!this.calls.has(c.id)) return;
    c.hangupBy = by;
    const answered = c.state === 'CONNECTED';
    this.setCallState(c, 'TERMINATING');
    c.timers.push(setTimeout(() => this.setCallState(c, answered ? 'COMPLETED' : 'CANCELLED'), 250));
  }

  private dispatchQueue() {
    const open = this.queueItems.filter((q) => q.state === 'WAITING');
    for (const q of sortQueue(open.map((x) => ({ ...x, enqueuedAt: +new Date(x.enqueuedAt) })), Date.now())) {
      const item = this.queueItems.find((x) => x.id === q.id)!;
      const a = this.atmsList.find((x) => x.id === item.atmId)!;
      if (a.activeCallId) continue;
      const op = this.ops.find((o) => o.id === item.preferredOperatorId && o.availability === 'AVAILABLE') ?? this.ops.find((o) => o.availability === 'AVAILABLE' && o.regions.some((r) => r.id === a.regionId));
      if (!op) continue;
      item.state = 'OFFERED';
      item.offeredOperatorId = op.id;
      item.offeredOperatorName = op.name;
      item.offerExpiresAt = iso(Date.now() + 30_000);
      item.version++;
      this.emit('queue.updated', 'queue', item.id, { queueItemId: item.id, atmId: a.id, state: item.state, priority: item.priority, offeredOperatorId: op.id, escalated: false, reason: item.reason });
    }
  }

  // ---------------------------------------------------------------- auth
  async login(username: string, password: string): Promise<Session> {
    await delay(300);
    const u = USERS[username.toLowerCase()];
    if (!u || password.length < 1) throw new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid username or password');
    const op = u.op !== undefined ? this.ops[u.op] : undefined;
    this.user = {
      id: `u-${username}`, username, displayName: u.name, organizationId: u.roles.includes('SUPER_ADMIN') ? null : ORG.id,
      organizationName: u.roles.includes('SUPER_ADMIN') ? null : ORG.name, roles: u.roles,
      permissions: [...new Set(u.roles.flatMap((r) => ROLE_PERMISSIONS[r]))], operatorId: op?.id ?? null,
    };
    this.audit_('auth.login', username, 'SUCCESS', 'user', this.user.id);
    return { accessToken: 'mock-token', accessExpiresIn: 900, user: this.user };
  }

  async refresh(): Promise<Session> {
    if (!this.user) throw new ApiError(401, 'REFRESH_INVALID', 'No session');
    return { accessToken: 'mock-token', accessExpiresIn: 900, user: this.user };
  }

  async logout() {
    this.user = null;
  }

  async me() {
    if (!this.user) throw new ApiError(401, 'AUTH_REQUIRED', 'Not signed in');
    return this.user;
  }

  private need(p: string) {
    if (!this.user?.permissions.includes(p)) throw new ApiError(403, 'FORBIDDEN', 'Insufficient permissions', { missing: [p] });
  }

  // ---------------------------------------------------------------- dashboard
  async summary(): Promise<DashboardSummary> {
    await delay(60);
    const reg = this.atmsList.filter((a) => a.registrationStatus === 'REGISTERED');
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todays = this.history.filter((c) => +new Date(c.requestedAt) >= +today);
    return {
      totalAtms: this.atmsList.length, onlineAtms: reg.filter((a) => a.status === 'ACTIVE').length, offlineAtms: this.atmsList.length - reg.filter((a) => a.status === 'ACTIVE').length,
      provisionedSipDevices: this.atmsList.length, registeredSipDevices: reg.length, activeCalls: this.calls.size,
      connectedCalls: [...this.calls.values()].filter((c) => c.state === 'CONNECTED').length,
      availableOperators: this.ops.filter((o) => o.availability === 'AVAILABLE').length, busyOperators: this.ops.filter((o) => o.availability === 'BUSY').length,
      unavailableOperators: this.ops.filter((o) => ['BREAK', 'UNAVAILABLE', 'FAULT'].includes(o.availability)).length, offlineOperators: this.ops.filter((o) => o.availability === 'OFFLINE').length,
      faultyDevices: this.atmsList.filter((a) => a.health === 'FAULT' || a.health === 'DEGRADED').length,
      callsToday: todays.length + this.calls.size, failedCallsToday: todays.filter((c) => ['FAILED', 'TIMEOUT', 'BUSY'].includes(c.state)).length,
      queuedRequests: this.queueItems.filter((q) => q.state === 'WAITING' || q.state === 'OFFERED').length, asOf: iso(Date.now()),
    };
  }

  async activity(limit = 50): Promise<ActivityItem[]> {
    await delay(60);
    return this.history.slice(0, limit).map((c) => ({
      kind: 'call' as const, id: c.id, at: c.endedAt ?? c.requestedAt, type: c.state, severity: ['FAILED', 'TIMEOUT', 'BUSY'].includes(c.state) ? ('warning' as const) : ('info' as const),
      atmCode: c.atmCode, atmName: c.atmName, operatorName: c.operatorName, refId: c.id,
    }));
  }

  async regionStats() {
    await delay(60);
    return REGIONS.map((r) => {
      const atms = this.atmsList.filter((a) => a.regionId === r.id);
      return {
        id: r.id, name: r.name, total: atms.length, online: atms.filter((a) => a.registrationStatus === 'REGISTERED').length,
        faults: atms.filter((a) => a.health === 'FAULT' || a.health === 'DEGRADED').length, activeCalls: atms.filter((a) => a.activeCallId).length,
        availableOperators: this.ops.filter((o) => o.availability === 'AVAILABLE' && o.regions.some((x) => x.id === r.id)).length,
      };
    });
  }

  async callsReport(r: { from?: string; to?: string; bucket?: 'hour' | 'day' }): Promise<CallsReport> {
    await delay(150);
    const to = r.to ? +new Date(r.to) : Date.now();
    const from = r.from ? +new Date(r.from) : to - 86_400_000;
    const bucket = r.bucket ?? (to - from > 3 * 86_400_000 ? 'day' : 'hour');
    const step = bucket === 'hour' ? 3_600_000 : 86_400_000;
    const inRange = this.history.filter((c) => +new Date(c.requestedAt) >= from && +new Date(c.requestedAt) < to);
    const series = [];
    for (let t = Math.floor(from / step) * step; t < to; t += step) {
      const b = inRange.filter((c) => +new Date(c.requestedAt) >= t && +new Date(c.requestedAt) < t + step);
      const durs = b.filter((c) => c.durationMs).map((c) => c.durationMs!);
      series.push({ bucket: iso(t), total: b.length, connected: b.filter((c) => c.answeredAt).length, failed: b.filter((c) => ['FAILED', 'TIMEOUT', 'BUSY'].includes(c.state)).length, avgDurationSec: durs.length ? Math.round(durs.reduce((x, y) => x + y, 0) / durs.length / 1000) : 0 });
    }
    const group = <K extends string>(key: (c: CallView) => K) => {
      const m = new Map<K, CallView[]>();
      for (const c of inRange) m.set(key(c), [...(m.get(key(c)) ?? []), c]);
      return m;
    };
    return {
      from: iso(from), to: iso(to), bucket, series,
      byRegion: [...group((c) => c.regionName)].map(([region, cs]) => ({ region, total: cs.length, connected: cs.filter((c) => c.answeredAt).length, failed: cs.filter((c) => ['FAILED', 'TIMEOUT', 'BUSY'].includes(c.state)).length })),
      byOperator: [...group((c) => c.operatorName)].map(([operator, cs]) => ({ operator, calls: cs.length, connected: cs.filter((c) => c.answeredAt).length, talkTimeSec: Math.round(cs.reduce((x, c) => x + (c.durationMs ?? 0), 0) / 1000) })).sort((a, b) => b.calls - a.calls),
      failures: [...group((c) => `${c.state}|${c.failureReason ?? ''}` as string)].filter(([k]) => !k.startsWith('COMPLETED')).map(([k, cs]) => ({ state: k.split('|')[0]!, reason: k.split('|')[1]!, sipCode: cs[0]!.sipCode, count: cs.length })),
    };
  }

  async availabilityReport(r: { from?: string; to?: string; bucket?: 'hour' | 'day' }) {
    const rep = await this.callsReport(r);
    return rep.series.map((p, i) => ({ bucket: p.bucket, registrations: 40 + Math.round(20 * Math.sin(i / 3) + rnd() * 15), disconnects: Math.round(8 + 6 * Math.cos(i / 4) + rnd() * 6), faults: Math.round(rnd() * 3) }));
  }

  async health(): Promise<SystemHealth> {
    await delay(80);
    return {
      status: 'degraded', node: 'mock-node', version: '1.1.0', sipDriver: 'simulated', uptimeSec: Math.round(performance.now() / 1000),
      components: [
        { name: 'database', status: 'up', detail: 'PostgreSQL (simulated)', latencyMs: 2 },
        { name: 'redis', status: 'up', detail: 'Redis (simulated)', latencyMs: 1 },
        { name: 'media:asterisk-1', status: 'up', detail: 'Asterisk 20 (simulated)', latencyMs: 4 },
        { name: 'media:asterisk-2', status: 'degraded', detail: 'High jitter on trunk (simulated)', latencyMs: 38 },
        { name: 'kamailio-edge', status: 'up', detail: 'registrar (simulated)', latencyMs: 3 },
        { name: 'websocket', status: 'up', detail: `${this.listeners.size} connection(s)`, latencyMs: null },
      ],
      jobs: [], checkedAt: iso(Date.now()),
    };
  }

  // ---------------------------------------------------------------- ATMs
  private authorizedFor(a: Atm, opId: string) {
    const op = this.ops.find((o) => o.id === opId);
    return a.primaryOperatorId === opId || a.backupOperatorId === opId || a.overrideOperatorId === opId || !!op?.regions.some((r) => r.id === a.regionId);
  }

  async atms(f: AtmFilters): Promise<Page<Atm>> {
    await delay(90);
    this.need('atm:read');
    let items = this.atmsList;
    if (f.mine) items = this.user?.operatorId ? items.filter((a) => this.authorizedFor(a, this.user!.operatorId!)) : [];
    if (f.regionId) items = items.filter((a) => a.regionId === f.regionId);
    if (f.groupId) items = items.filter((a) => a.groups.some((g) => g.id === f.groupId));
    if (f.registration) items = items.filter((a) => a.registrationStatus === f.registration);
    if (f.health) items = items.filter((a) => a.health === f.health);
    if (f.status) items = items.filter((a) => a.status === f.status);
    if (f.inCall !== undefined) items = items.filter((a) => !!a.activeCallId === f.inCall);
    if (f.operatorId) items = items.filter((a) => [a.primaryOperatorId, a.backupOperatorId, a.overrideOperatorId].includes(f.operatorId!));
    if (f.q) {
      const q = f.q.toLowerCase();
      items = items.filter((a) => [a.atmCode, a.name, a.city, a.site, a.sipUsername].some((v) => v?.toLowerCase().includes(q)));
    }
    if (f.sort) {
      const desc = f.sort.startsWith('-');
      const k = (desc ? f.sort.slice(1) : f.sort) as keyof Atm;
      const map: Record<string, keyof Atm> = { lastSeen: 'lastSeenAt', registration: 'registrationStatus', region: 'regionName', firmware: 'firmwareVersion' };
      const key = map[k as string] ?? k;
      items = [...items].sort((x, y) => String(x[key] ?? '').localeCompare(String(y[key] ?? '')) * (desc ? -1 : 1));
    }
    const page = f.page ?? 1;
    const size = f.pageSize ?? 50;
    return { items: items.slice((page - 1) * size, page * size), total: items.length, page, pageSize: size };
  }

  async atm(id: string): Promise<AtmDetail> {
    await delay(90);
    const a = this.atmsList.find((x) => x.id === id);
    if (!a) throw new ApiError(404, 'NOT_FOUND', 'ATM not found');
    const calls = this.history.filter((c) => c.atmId === id).slice(0, 25);
    return {
      ...a, vmsLink: a.vmsDeepLink?.replace('{cameraRef}', a.vmsCameraRef ?? '') ?? null, sip: { username: a.sipUsername, domain: 'sip.wintek.local', realm: 'sip.wintek.local', credentialVersion: 1 },
      recentCalls: calls.map((c) => ({ ...c })), faults: a.health === 'FAULT' ? [{ id: '1', type: 'FAULT', severity: 'critical', detail: { reason: 'speaker amplifier not detected' }, occurredAt: iso(Date.now() - 3_600_000) }] : [],
      deviceEvents: [{ id: '2', type: a.registrationStatus, severity: a.registrationStatus === 'REGISTERED' ? 'info' : 'warning', detail: { source: 'kamailio' }, occurredAt: a.lastSeenAt ?? iso(Date.now()) }],
    };
  }

  async regions(): Promise<RegionRef[]> {
    return REGIONS.map((r) => ({ id: r.id, code: r.code, name: r.name, atmCount: this.atmsList.filter((a) => a.regionId === r.id).length }));
  }

  async groups(): Promise<RegionRef[]> {
    return GROUPS.map((g) => ({ ...g, atmCount: this.atmsList.filter((a) => a.groups.some((x) => x.id === g.id)).length }));
  }

  private creds(username: string) {
    return { sipUsername: username, sipPassword: Array.from({ length: 24 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'[Math.floor(Math.random() * 56)]).join(''), realm: 'sip.wintek.local', domain: 'sip.wintek.local', credentialVersion: 1 };
  }

  async createAtm(b: Record<string, any>) {
    await delay();
    this.need('atm:manage');
    const region = REGIONS.find((r) => r.id === b.regionId) ?? REGIONS[0]!;
    const atm: Atm = { ...this.atmsList[0]!, id: `atm-${this.atmsList.length}`, atmCode: b.atmCode, name: b.name, regionId: region.id, regionName: region.name, city: b.city ?? null, site: b.site ?? null, sipUsername: `atm-${String(b.atmCode).toLowerCase()}`, registrationStatus: 'UNKNOWN', health: 'UNKNOWN', lastSeenAt: null, lastRegisteredAt: null, activeCallId: null, activeCallState: null, version: 1 };
    this.atmsList.unshift(atm);
    this.audit_('atm.provisioned', this.user?.username ?? null, 'SUCCESS', 'atm', atm.id);
    return { atm, credentials: b.provisionSip === false ? null : this.creds(atm.sipUsername!) };
  }

  async updateAtm(id: string, b: Record<string, any>) {
    await delay();
    this.need('atm:manage');
    const a = this.atmsList.find((x) => x.id === id)!;
    Object.assign(a, b, { version: a.version + 1 });
    this.audit_('atm.updated', this.user?.username ?? null, 'SUCCESS', 'atm', id, Date.now(), b);
    return a;
  }

  async rotateCredentials(id: string) {
    await delay();
    this.need('atm:credentials');
    const a = this.atmsList.find((x) => x.id === id)!;
    this.audit_('atm.credentials.rotated', this.user?.username ?? null, 'SUCCESS', 'atm', id);
    return { credentials: { ...this.creds(a.sipUsername!), credentialVersion: (a.credentialVersion ?? 1) + 1 }, notice: 'Provision the device with this password now; it will not be shown again.' };
  }

  async bulkAtms(b: { atmIds: string[]; action: string; targetId?: string | null }) {
    await delay();
    this.need('atm:manage');
    for (const id of b.atmIds) {
      const a = this.atmsList.find((x) => x.id === id);
      if (!a) continue;
      if (b.action === 'DISABLE') a.status = 'DISABLED';
      if (b.action === 'ENABLE') a.status = 'ACTIVE';
      if (b.action === 'MAINTENANCE') a.status = 'MAINTENANCE';
    }
    this.audit_(`atm.bulk.${b.action.toLowerCase()}`, this.user?.username ?? null, 'SUCCESS', 'atm', `${b.atmIds.length} atms`);
    return { affected: b.atmIds.length };
  }

  async importAtms(csv: string, dryRun: boolean) {
    await delay(400);
    const lines = csv.trim().split(/\r?\n/).slice(1);
    const results = lines.map((l, i) => {
      const [code, name, region] = l.split(',');
      const ok = code && name && REGIONS.some((r) => r.code === region?.trim().toUpperCase());
      return ok
        ? { line: i + 2, atmCode: code!, status: 'CREATED' as const, credentials: dryRun ? undefined : this.creds(`atm-${code!.toLowerCase()}`) }
        : { line: i + 2, atmCode: code ?? '', status: 'ERROR' as const, error: !region ? 'region_code is required' : `unknown region_code "${region}"` };
    });
    return { dryRun, total: lines.length, created: results.filter((r) => r.status === 'CREATED').length, updated: 0, errors: results.filter((r) => r.status === 'ERROR').length, results };
  }

  // ---------------------------------------------------------------- operators
  async operators(f: { q?: string; availability?: string; regionId?: string } = {}) {
    await delay(80);
    let items = this.ops.map((o) => ({ ...o, primaryAssignments: this.atmsList.filter((a) => a.primaryOperatorId === o.id).length, backupAssignments: this.atmsList.filter((a) => a.backupOperatorId === o.id).length }));
    if (f.q) items = items.filter((o) => o.name.toLowerCase().includes(f.q!.toLowerCase()) || o.username.includes(f.q!.toLowerCase()));
    if (f.availability) items = items.filter((o) => o.availability === f.availability);
    if (f.regionId) items = items.filter((o) => o.regions.some((r) => r.id === f.regionId));
    return { items, total: items.length, page: 1, pageSize: 500 };
  }

  async operator(id: string) {
    const o = this.ops.find((x) => x.id === id);
    if (!o) throw new ApiError(404, 'NOT_FOUND', 'Operator not found');
    return o;
  }

  async setPresence(a: Availability) {
    await delay(80);
    const op = this.ops.find((o) => o.id === this.user?.operatorId);
    if (!op) throw new ApiError(400, 'NOT_AN_OPERATOR', 'User is not an operator');
    op.selectedAvailability = a;
    op.availability = op.currentCall ? 'BUSY' : op.sipRegistered ? a : a === 'AVAILABLE' ? 'FAULT' : a;
    this.audit_('presence.selected', this.user!.username, 'SUCCESS', 'operator', op.id, Date.now(), { to: a });
    this.emit('operator.presence.changed', 'operator', op.id, { operatorId: op.id, selected: a, effective: op.availability, currentCallId: op.currentCall?.id ?? null });
    if (op.availability === 'AVAILABLE') this.dispatchQueue();
    return { selected: a, effective: op.availability };
  }

  async heartbeat(sipRegistered: boolean) {
    const op = this.ops.find((o) => o.id === this.user?.operatorId);
    if (!op) return;
    const before = op.availability;
    op.sipRegistered = sipRegistered;
    op.lastHeartbeatAt = iso(Date.now());
    if (!op.currentCall) op.availability = op.selectedAvailability === 'OFFLINE' ? 'UNAVAILABLE' : !sipRegistered && op.selectedAvailability === 'AVAILABLE' ? 'FAULT' : op.selectedAvailability;
    if (before !== op.availability) this.emit('operator.presence.changed', 'operator', op.id, { operatorId: op.id, selected: op.selectedAvailability, effective: op.availability, currentCallId: null });
  }

  async webrtcCredentials() {
    await delay();
    return { wssUrl: 'wss://mock/ws', sipUri: 'sip:mock@local', authorizationUsername: 'mock', password: 'mock', realm: 'mock', iceServers: [], driver: 'simulated' as const };
  }

  // ---------------------------------------------------------------- assignments
  async assignments(f: { atmId?: string; operatorId?: string }): Promise<Assignment[]> {
    await delay(80);
    return this.atmsList
      .filter((a) => (!f.atmId || a.id === f.atmId) && (!f.operatorId || a.primaryOperatorId === f.operatorId || a.backupOperatorId === f.operatorId))
      .slice(0, 300)
      .map((a) => ({ atmId: a.id, atmCode: a.atmCode, atmName: a.name, regionName: a.regionName, primaryOperatorId: a.primaryOperatorId, primaryOperatorName: a.primaryOperatorName, backupOperatorId: a.backupOperatorId, backupOperatorName: a.backupOperatorName, shiftId: null, updatedAt: iso(Date.now() - 86_400_000), version: a.version }));
  }

  async setAssignment(atmId: string, b: { primaryOperatorId?: string | null; backupOperatorId?: string | null; expectedVersion?: number }) {
    await delay();
    this.need('assignment:manage');
    const a = this.atmsList.find((x) => x.id === atmId)!;
    if (b.expectedVersion !== undefined && b.expectedVersion !== a.version) throw new ApiError(409, 'STALE_VERSION', 'Assignment was changed by someone else; reload and retry');
    if (b.primaryOperatorId && b.primaryOperatorId === b.backupOperatorId) throw new ApiError(400, 'SAME_OPERATOR', 'Primary and backup operator must differ');
    if (b.primaryOperatorId !== undefined) {
      a.primaryOperatorId = b.primaryOperatorId;
      a.primaryOperatorName = this.ops.find((o) => o.id === b.primaryOperatorId)?.name ?? null;
    }
    if (b.backupOperatorId !== undefined) {
      a.backupOperatorId = b.backupOperatorId;
      a.backupOperatorName = this.ops.find((o) => o.id === b.backupOperatorId)?.name ?? null;
    }
    a.version++;
    this.audit_('assignment.updated', this.user?.username ?? null, 'SUCCESS', 'atm', atmId, Date.now(), b);
    this.emit('assignment.updated', 'assignment', atmId, { atmId, kind: 'STATIC' });
    return { version: a.version };
  }

  async overrides(activeOnly = true) {
    await delay(60);
    return this.overridesList.filter((o) => !activeOnly || (o.active && +new Date(o.endsAt) > Date.now()));
  }

  async createOverride(b: { atmId: string; operatorId: string; reason: string; endsAt: string; startsAt?: string }) {
    await delay();
    this.need('assignment:override');
    if (this.overridesList.some((o) => o.atmId === b.atmId && o.active)) throw new ApiError(409, 'OVERRIDE_CONFLICT', 'Another override for this ATM overlaps that time window; revoke it first');
    const a = this.atmsList.find((x) => x.id === b.atmId)!;
    const op = this.ops.find((o) => o.id === b.operatorId)!;
    const o: Override = { id: uuid(), atmId: a.id, atmCode: a.atmCode, atmName: a.name, operatorId: op.id, operatorName: op.name, reason: b.reason, createdByName: this.user!.displayName, startsAt: b.startsAt ?? iso(Date.now()), endsAt: b.endsAt, revokedAt: null, active: true };
    this.overridesList.unshift(o);
    a.overrideOperatorId = op.id;
    a.overrideOperatorName = op.name;
    a.overrideEndsAt = b.endsAt;
    a.assignedOperatorId = op.id;
    a.assignedOperatorName = op.name;
    this.audit_('assignment.override.created', this.user!.username, 'SUCCESS', 'atm', a.id, Date.now(), { operatorId: op.id, reason: b.reason, endsAt: b.endsAt });
    this.emit('assignment.updated', 'assignment', a.id, { atmId: a.id, kind: 'OVERRIDE' });
    return o;
  }

  async revokeOverride(id: string) {
    await delay();
    const o = this.overridesList.find((x) => x.id === id);
    if (!o) return;
    o.active = false;
    o.revokedAt = iso(Date.now());
    const a = this.atmsList.find((x) => x.id === o.atmId)!;
    a.overrideOperatorId = a.overrideOperatorName = a.overrideEndsAt = null;
    a.assignedOperatorId = a.primaryOperatorId;
    a.assignedOperatorName = a.primaryOperatorName;
    this.audit_('assignment.override.revoked', this.user!.username, 'SUCCESS', 'atm', a.id);
    this.emit('assignment.updated', 'assignment', a.id, { atmId: a.id, kind: 'OVERRIDE_REVOKED' });
  }

  async resolve(atmId: string) {
    await delay();
    const a = this.atmsList.find((x) => x.id === atmId)!;
    const p = this.ops.find((o) => o.id === a.primaryOperatorId);
    const b = this.ops.find((o) => o.id === a.backupOperatorId);
    const trace: { step: string; operatorId: string | null; outcome: string; reason: string }[] = [];
    trace.push({ step: 'OVERRIDE', operatorId: a.overrideOperatorId, outcome: a.overrideOperatorId ? 'SELECTED' : 'NOT_CONFIGURED', reason: a.overrideOperatorId ? 'eligible' : 'no override in force' });
    if (a.overrideOperatorId) return { kind: 'OVERRIDE' as const, operatorId: a.overrideOperatorId, policySource: 'ORGANIZATION', trace };
    const ok = (o?: Operator) => o?.availability === 'AVAILABLE';
    trace.push({ step: 'PRIMARY', operatorId: p?.id ?? null, outcome: ok(p) ? 'SELECTED' : 'SKIPPED', reason: ok(p) ? 'eligible' : `availability ${p?.availability}` });
    if (ok(p)) return { kind: 'PRIMARY' as const, operatorId: p!.id, policySource: 'ORGANIZATION', trace };
    trace.push({ step: 'BACKUP', operatorId: b?.id ?? null, outcome: ok(b) ? 'SELECTED' : 'SKIPPED', reason: ok(b) ? 'eligible' : `availability ${b?.availability}` });
    if (ok(b)) return { kind: 'BACKUP' as const, operatorId: b!.id, policySource: 'ORGANIZATION', trace };
    const d = this.ops.find((o) => ok(o) && o.regions.some((r) => r.id === a.regionId));
    trace.push({ step: 'DYNAMIC', operatorId: d?.id ?? null, outcome: d ? 'SELECTED' : 'SKIPPED', reason: d ? 'best of eligible pool' : 'no eligible operator in pool' });
    if (d) return { kind: 'DYNAMIC' as const, operatorId: d.id, policySource: 'ORGANIZATION', trace };
    trace.push({ step: 'ESCALATE', operatorId: null, outcome: 'SELECTED', reason: 'no eligible operator' });
    return { kind: 'ESCALATE' as const, operatorId: null, policySource: 'ORGANIZATION', trace };
  }

  // ---------------------------------------------------------------- shifts
  async shifts() {
    await delay(60);
    return this.shiftList;
  }

  async saveShift(b: any) {
    await delay();
    this.need('shift:manage');
    if (b.id) Object.assign(this.shiftList.find((x) => x.id === b.id)!, b);
    else this.shiftList.push({ ...b, id: uuid(), members: [], regionName: null, version: 1 });
    this.audit_(b.id ? 'shift.updated' : 'shift.created', this.user!.username, 'SUCCESS', 'shift', b.id ?? 'new');
    return {};
  }

  async setShiftMembers(id: string, operatorIds: string[]) {
    await delay();
    const sh = this.shiftList.find((x) => x.id === id)!;
    sh.members = operatorIds.map((oid) => ({ operatorId: oid, name: this.ops.find((o) => o.id === oid)?.name ?? oid, validFrom: iso(Date.now()).slice(0, 10), validTo: null, onShift: false }));
    return {};
  }

  // ---------------------------------------------------------------- calls
  async initiateCall(b: { atmId: string; requestId: string; priority?: Priority; queueIfBusy?: boolean; queueItemId?: string }): Promise<InitiateResult> {
    await delay(150);
    this.need('call:initiate');
    const prior = this.requestIds.get(b.requestId);
    if (prior) {
      const c = this.calls.get(prior) ?? this.history.find((x) => x.id === prior)!;
      return { queued: false, call: { ...c }, dial: null, replayed: true };
    }
    const opId = this.user?.operatorId;
    const op = this.ops.find((o) => o.id === opId);
    const a = this.atmsList.find((x) => x.id === b.atmId);
    if (!op) throw new ApiError(403, 'NOT_AN_OPERATOR', 'Only operators can place calls');
    if (!a) throw new ApiError(404, 'NOT_FOUND', 'ATM not found');
    if (!this.authorizedFor(a, op.id) && !this.user!.permissions.includes('call:initiate:any')) throw new ApiError(403, 'NOT_AUTHORIZED', 'You are not assigned to this ATM');
    if (a.status !== 'ACTIVE') throw new ApiError(409, 'ATM_DISABLED', `ATM is ${a.status.toLowerCase()}`);
    if (a.registrationStatus !== 'REGISTERED') throw new ApiError(409, 'ATM_OFFLINE', 'ATM intercom is not registered', { registration: a.registrationStatus });
    if (op.currentCall) throw new ApiError(409, 'OPERATOR_BUSY', 'You already have an active call');
    if (op.availability !== 'AVAILABLE') throw new ApiError(409, 'OPERATOR_UNAVAILABLE', `Your status is ${op.availability}; set yourself AVAILABLE with a connected console`, { availability: op.availability });
    if (a.activeCallId) {
      if (b.queueIfBusy) {
        const q: QueueItem = {
          id: uuid(), organizationId: ORG.id, atmId: a.id, atmCode: a.atmCode, atmName: a.name, regionName: a.regionName, priority: b.priority ?? 'P3', state: 'WAITING', source: 'OPERATOR',
          reason: 'ATM busy when called', externalRef: null, preferredOperatorId: op.id, offeredOperatorId: null, offeredOperatorName: null, offerExpiresAt: null,
          requestedByName: op.name, escalatedAt: null, enqueuedAt: iso(Date.now()), expiresAt: iso(Date.now() + 300_000), closedAt: null, closeReason: null, atmBusy: true, position: null, version: 1,
        };
        this.queueItems.push(q);
        a.queueItemId = q.id;
        a.queuePriority = q.priority;
        this.emit('queue.updated', 'queue', q.id, { queueItemId: q.id, atmId: a.id, state: 'WAITING', priority: q.priority, offeredOperatorId: null, escalated: false, reason: q.reason });
        return { queued: true, queueItem: { id: q.id, priority: q.priority, state: 'WAITING' } };
      }
      throw new ApiError(409, 'ATM_BUSY', 'ATM is already in a call', { queueAllowed: true });
    }
    if (b.queueItemId) {
      const q = this.queueItems.find((x) => x.id === b.queueItemId);
      if (q) {
        q.state = 'FULFILLED';
        q.closedAt = iso(Date.now());
        this.emit('queue.updated', 'queue', q.id, { queueItemId: q.id, atmId: a.id, state: 'FULFILLED', priority: q.priority, offeredOperatorId: op.id, escalated: false, reason: q.reason });
      }
    }
    const c = this.startCall(a, op, b.priority ?? 'P3');
    this.requestIds.set(b.requestId, c.id);
    this.audit_('call.initiated', this.user!.username, 'SUCCESS', 'call', c.id, Date.now(), { atmCode: a.atmCode });
    return { queued: false, call: { ...c }, dial: { target: `sip:call-${c.id}@mock`, headers: { 'X-Wintek-Call-Token': 'mock' }, expiresInMs: 15000 }, replayed: false };
  }

  async hangup(callId: string) {
    await delay(80);
    const c = this.calls.get(callId);
    if (!c) return this.call(callId);
    if (c.operatorId !== this.user?.operatorId && !this.user?.permissions.includes('call:hangup:any')) throw new ApiError(403, 'FORBIDDEN', 'You can only hang up your own calls');
    this.audit_('call.hangup', this.user!.username, 'SUCCESS', 'call', callId);
    this.endCall(c, c.operatorId === this.user?.operatorId ? 'OPERATOR' : 'SUPERVISOR');
    return { ...c };
  }

  async call(callId: string) {
    const c = this.calls.get(callId) ?? this.history.find((x) => x.id === callId);
    if (!c) throw new ApiError(404, 'NOT_FOUND', 'Call not found');
    const { timers: _t, ...view } = c as MockCall;
    return { ...view };
  }

  async activeCalls() {
    await delay(60);
    return [...this.calls.values()].map(({ timers: _t, ...v }) => ({ ...v }));
  }

  async myCall() {
    const c = [...this.calls.values()].find((x) => x.operatorId === this.user?.operatorId);
    if (!c) return null;
    const { timers: _t, ...v } = c;
    return { ...v };
  }

  async callHistory(f: { atmId?: string; operatorId?: string; state?: string; page?: number; pageSize?: number }) {
    await delay(100);
    let items = this.history;
    if (f.atmId) items = items.filter((c) => c.atmId === f.atmId);
    if (f.operatorId) items = items.filter((c) => c.operatorId === f.operatorId);
    if (f.state) items = items.filter((c) => c.state === f.state);
    const page = f.page ?? 1;
    const size = f.pageSize ?? 50;
    return { items: items.slice((page - 1) * size, page * size), total: items.length, page, pageSize: size };
  }

  // ---------------------------------------------------------------- queue
  async queue(includeClosed = false) {
    await delay(60);
    const open = this.queueItems.filter((q) => q.state === 'WAITING' || q.state === 'OFFERED');
    const order = sortQueue(open.map((q) => ({ ...q, enqueuedAt: +new Date(q.enqueuedAt) })), Date.now());
    return (includeClosed ? this.queueItems : open).map((q) => ({ ...q, atmBusy: !!this.atmsList.find((a) => a.id === q.atmId)?.activeCallId, position: order.findIndex((x) => x.id === q.id) + 1 || null }));
  }

  async enqueue(b: { atmId: string; priority: Priority; reason?: string; externalRef?: string }) {
    await delay();
    this.need('queue:manage');
    const a = this.atmsList.find((x) => x.id === b.atmId)!;
    const q: QueueItem = {
      id: uuid(), organizationId: ORG.id, atmId: a.id, atmCode: a.atmCode, atmName: a.name, regionName: a.regionName, priority: b.priority, state: 'WAITING', source: 'SUPERVISOR',
      reason: b.reason ?? null, externalRef: b.externalRef ?? null, preferredOperatorId: null, offeredOperatorId: null, offeredOperatorName: null, offerExpiresAt: null,
      requestedByName: this.user!.displayName, escalatedAt: null, enqueuedAt: iso(Date.now()), expiresAt: iso(Date.now() + 600_000), closedAt: null, closeReason: null, atmBusy: !!a.activeCallId, position: null, version: 1,
    };
    this.queueItems.push(q);
    this.emit('queue.updated', 'queue', q.id, { queueItemId: q.id, atmId: a.id, state: 'WAITING', priority: q.priority, offeredOperatorId: null, escalated: false, reason: q.reason });
    setTimeout(() => this.dispatchQueue(), 800);
    return q;
  }

  async cancelQueue(id: string) {
    await delay();
    const q = this.queueItems.find((x) => x.id === id);
    if (!q) return;
    q.state = 'CANCELLED';
    q.closedAt = iso(Date.now());
    this.emit('queue.updated', 'queue', q.id, { queueItemId: q.id, atmId: q.atmId, state: 'CANCELLED', priority: q.priority, offeredOperatorId: null, escalated: false, reason: q.reason });
  }

  async declineQueue(id: string) {
    await delay();
    const q = this.queueItems.find((x) => x.id === id);
    if (!q) return;
    q.state = 'WAITING';
    q.offeredOperatorId = q.offeredOperatorName = null;
    this.emit('queue.updated', 'queue', q.id, { queueItemId: q.id, atmId: q.atmId, state: 'WAITING', priority: q.priority, offeredOperatorId: null, escalated: false, reason: q.reason });
  }

  // ---------------------------------------------------------------- audit & admin
  async audit(f: AuditFilters) {
    await delay(80);
    this.need('audit:read');
    let items = this.auditLog;
    if (f.action) items = items.filter((a) => a.action.startsWith(f.action!));
    if (f.actor) items = items.filter((a) => a.actorUsername === f.actor);
    if (f.outcome) items = items.filter((a) => a.outcome === f.outcome);
    const page = f.page ?? 1;
    const size = f.pageSize ?? 50;
    return { items: items.slice((page - 1) * size, page * size), total: items.length, page, pageSize: size };
  }

  async organizations() {
    return [{ id: ORG.id, code: 'DEMOBANK', name: ORG.name, timezone: 'Asia/Kolkata', status: 'ACTIVE', atmCount: this.atmsList.length, operatorCount: this.ops.length }];
  }

  async users() {
    return Object.entries(USERS).map(([username, u]) => ({ id: `u-${username}`, username, displayName: u.name, email: null, status: 'ACTIVE', organizationId: ORG.id, lastLoginAt: iso(Date.now() - 3_600_000), roles: u.roles, operatorId: u.op !== undefined ? this.ops[u.op]!.id : null }));
  }

  async roles() {
    return (Object.keys(ROLE_PERMISSIONS) as Role[]).map((r) => ({ code: r, name: ROLE_LABEL[r], permissions: [...ROLE_PERMISSIONS[r]] }));
  }

  async createUser() {
    await delay();
    return {};
  }
  async updateUser() {
    await delay();
    return {};
  }
  async createRegion() {
    await delay();
    return {};
  }
  async createGroup() {
    await delay();
    return {};
  }
  async routingPolicies() {
    return [{ id: 'rp-1', scope: 'ORGANIZATION', scopeId: null, allowDynamic: true, requireActiveShift: true, sameRegionOnly: true, preferGroupMatch: true, allowQueueWhenBusy: true, queueTimeoutSeconds: 300, allowPreemption: false }];
  }
  async saveRoutingPolicy() {
    await delay();
    return {};
  }
  async settings() {
    return { keys: ['calls.maxDurationMinutes', 'calls.confirmHangupWhenConnected', 'ui.staleAfterSeconds'], values: [{ key: 'calls.confirmHangupWhenConnected', value: true }], deployment: { sipDriver: 'simulated', sipDomain: 'sip.wintek.local', atmDialMode: 'asterisk-registrar', webrtcWssUrl: 'wss://mock/ws', nodeId: 'mock' } };
  }
  async putSetting(key: string, value: unknown) {
    await delay();
    return { key, value };
  }
}
