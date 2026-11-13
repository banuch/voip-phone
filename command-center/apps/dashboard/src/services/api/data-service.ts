import type { Availability, EventEnvelope, Priority } from '@wintek/shared';
import type {
  Assignment, Atm, AtmDetail, AtmFilters, AuditEntry, AuditFilters, AvailabilityPoint, CallView, CallsReport, DashboardSummary,
  ActivityItem, ImportResult, InitiateResult, Operator, Organization, Override, Page, QueueItem, RegionRef, RegionStat,
  ResolveResult, Session, SessionUser, Shift, SipCredential, SystemHealth, UserRow, WebRtcConfig, Ref,
} from '@/types/api';

/**
 * The only way UI code reaches data. Two implementations:
 *  - HttpDataService: the real REST API + WebSocket events,
 *  - MockDataService: realistic in-browser simulation for UI development.
 * Pages never import either directly (see services/api/index.ts).
 */
export interface DataService {
  readonly kind: 'api' | 'mock';

  // auth
  login(username: string, password: string): Promise<Session>;
  refresh(): Promise<Session>;
  logout(): Promise<void>;
  me(): Promise<SessionUser>;

  // dashboard
  summary(): Promise<DashboardSummary>;
  activity(limit?: number): Promise<ActivityItem[]>;
  regionStats(): Promise<RegionStat[]>;
  callsReport(range: { from?: string; to?: string; bucket?: 'hour' | 'day' }): Promise<CallsReport>;
  availabilityReport(range: { from?: string; to?: string; bucket?: 'hour' | 'day' }): Promise<AvailabilityPoint[]>;
  health(): Promise<SystemHealth>;

  // ATMs
  atms(f: AtmFilters): Promise<Page<Atm>>;
  atm(id: string): Promise<AtmDetail>;
  regions(): Promise<RegionRef[]>;
  groups(): Promise<RegionRef[]>;
  createAtm(body: Record<string, unknown>): Promise<{ atm: Atm; credentials: SipCredential | null }>;
  updateAtm(id: string, body: Record<string, unknown>): Promise<Atm>;
  rotateCredentials(id: string): Promise<{ credentials: SipCredential; notice: string }>;
  bulkAtms(body: { atmIds: string[]; action: string; targetId?: string | null }): Promise<{ affected: number }>;
  importAtms(csv: string, dryRun: boolean): Promise<ImportResult>;

  // operators & presence
  operators(f?: { q?: string; availability?: string; regionId?: string }): Promise<Page<Operator>>;
  operator(id: string): Promise<Operator>;
  setPresence(a: Availability): Promise<{ effective: Availability; selected: Availability }>;
  heartbeat(sipRegistered: boolean, mediaFault: boolean): Promise<void>;
  webrtcCredentials(): Promise<WebRtcConfig>;

  // assignments
  assignments(f: { atmId?: string; operatorId?: string }): Promise<Assignment[]>;
  setAssignment(atmId: string, body: { primaryOperatorId?: string | null; backupOperatorId?: string | null; expectedVersion?: number }): Promise<unknown>;
  overrides(activeOnly?: boolean): Promise<Override[]>;
  createOverride(body: { atmId: string; operatorId: string; reason: string; endsAt: string; startsAt?: string }): Promise<unknown>;
  revokeOverride(id: string): Promise<void>;
  resolve(atmId: string): Promise<ResolveResult>;

  // shifts
  shifts(): Promise<Shift[]>;
  saveShift(body: Omit<Shift, 'id' | 'members' | 'regionName' | 'version'> & { id?: string }): Promise<unknown>;
  setShiftMembers(id: string, operatorIds: string[]): Promise<unknown>;

  // calls
  initiateCall(body: { atmId: string; requestId: string; priority?: Priority; queueIfBusy?: boolean; queueItemId?: string }): Promise<InitiateResult>;
  hangup(callId: string): Promise<CallView>;
  call(callId: string): Promise<CallView>;
  activeCalls(): Promise<CallView[]>;
  myCall(): Promise<CallView | null>;
  callHistory(f: { atmId?: string; operatorId?: string; state?: string; page?: number; pageSize?: number; from?: string; to?: string }): Promise<Page<CallView>>;

  // queue
  queue(includeClosed?: boolean): Promise<QueueItem[]>;
  enqueue(body: { atmId: string; priority: Priority; reason?: string; externalRef?: string }): Promise<unknown>;
  cancelQueue(id: string): Promise<void>;
  declineQueue(id: string): Promise<void>;

  // audit & admin
  audit(f: AuditFilters): Promise<Page<AuditEntry>>;
  organizations(): Promise<Organization[]>;
  users(): Promise<UserRow[]>;
  roles(): Promise<{ code: string; name: string; permissions: string[] }[]>;
  createUser(body: Record<string, unknown>): Promise<unknown>;
  updateUser(id: string, body: Record<string, unknown>): Promise<unknown>;
  createRegion(body: { code: string; name: string }): Promise<unknown>;
  createGroup(body: { code: string; name: string; description?: string }): Promise<unknown>;
  routingPolicies(): Promise<Record<string, unknown>[]>;
  saveRoutingPolicy(body: Record<string, unknown>): Promise<unknown>;
  settings(): Promise<{ keys: string[]; values: { key: string; value: unknown }[]; deployment: Record<string, string> }>;
  putSetting(key: string, value: unknown): Promise<unknown>;

  // realtime
  subscribe(handlers: RealtimeHandlers): () => void;
}

export type ConnectionState = 'connecting' | 'open' | 'reconnecting' | 'offline';

export interface RealtimeHandlers {
  onEvent: (e: EventEnvelope) => void;
  onState: (s: ConnectionState, detail?: string) => void;
  /** Server can't fill a gap: refetch snapshots. */
  onResync: (reason: string) => void;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
    readonly correlationId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export type { Ref };
