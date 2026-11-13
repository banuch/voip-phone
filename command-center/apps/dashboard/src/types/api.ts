import type { Availability, CallState, DeviceHealth, DeviceRegistration, Priority, Role } from '@wintek/shared';

export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export interface SessionUser {
  id: string;
  username: string;
  displayName: string;
  organizationId: string | null;
  organizationName: string | null;
  roles: Role[];
  permissions: string[];
  operatorId: string | null;
}

export interface Session {
  accessToken: string;
  accessExpiresIn: number;
  user: SessionUser;
}

export interface Ref {
  id: string;
  name: string;
}

export interface Atm {
  id: string;
  atmCode: string;
  name: string;
  organizationId: string;
  organizationName: string;
  regionId: string;
  regionName: string;
  state: string | null;
  city: string | null;
  site: string | null;
  address?: string | null;
  sipUsername: string | null;
  deviceModel: string;
  firmwareVersion: string | null;
  serialNumber?: string | null;
  status: 'ACTIVE' | 'DISABLED' | 'MAINTENANCE';
  registrationStatus: DeviceRegistration;
  health: DeviceHealth;
  lastRegisteredAt: string | null;
  lastSeenAt: string | null;
  contactIp?: string | null;
  contactPort?: number | null;
  userAgent?: string | null;
  vmsCameraRef?: string | null;
  vmsDeepLink?: string | null;
  primaryOperatorId: string | null;
  primaryOperatorName: string | null;
  backupOperatorId: string | null;
  backupOperatorName: string | null;
  overrideOperatorId: string | null;
  overrideOperatorName: string | null;
  overrideEndsAt: string | null;
  assignedOperatorId: string | null;
  assignedOperatorName: string | null;
  activeCallId: string | null;
  activeCallState: CallState | null;
  activeCallOperatorName: string | null;
  queueItemId: string | null;
  queuePriority: Priority | null;
  groups: Ref[];
  credentialVersion?: number | null;
  credentialsRotatedAt?: string | null;
  version: number;
}

export interface CallSummary {
  id: string;
  state: CallState;
  priority: Priority;
  routingDecision?: string;
  operatorName: string;
  atmCode?: string;
  atmName?: string;
  requestedAt: string;
  answeredAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  sipCode: number | null;
  failureReason: string | null;
}

export interface DeviceEvent {
  id: string;
  type: string;
  severity: 'info' | 'warning' | 'critical';
  detail: Record<string, unknown> | null;
  occurredAt: string;
}

export interface AtmDetail extends Atm {
  vmsLink: string | null;
  sip: { username: string | null; domain: string; realm: string; credentialVersion: number | null };
  recentCalls: CallSummary[];
  faults: DeviceEvent[];
  deviceEvents: DeviceEvent[];
}

export interface AtmFilters {
  q?: string;
  regionId?: string;
  groupId?: string;
  registration?: DeviceRegistration;
  health?: DeviceHealth;
  status?: string;
  inCall?: boolean;
  mine?: boolean;
  operatorId?: string;
  sort?: string;
  page?: number;
  pageSize?: number;
}

export interface SipCredential {
  sipUsername: string;
  sipPassword: string;
  realm: string;
  domain: string;
  credentialVersion: number;
}

export interface Operator {
  id: string;
  organizationId: string;
  organizationName: string;
  userId: string;
  username: string;
  name: string;
  email: string | null;
  accountStatus: string;
  lastLoginAt: string | null;
  employeeCode: string | null;
  routingPriority: number;
  status: 'ACTIVE' | 'DISABLED';
  selectedAvailability: Availability;
  availability: Availability;
  sipRegistered: boolean | null;
  lastHeartbeatAt: string | null;
  sipUsername: string | null;
  roles: Role[];
  regions: Ref[];
  groups: Ref[];
  primaryAssignments: number;
  backupAssignments: number;
  currentCall: { id: string; atmId: string; state: CallState; answeredAt: string | null } | null;
  onShift: boolean;
  version: number;
}

export interface CallView {
  id: string;
  organizationId: string;
  atmId: string;
  atmCode: string;
  atmName: string;
  regionName: string;
  operatorId: string;
  operatorName: string;
  state: CallState;
  priority: Priority;
  routingDecision: string;
  correlationId: string;
  requestId?: string;
  sipCode: number | null;
  failureReason: string | null;
  hangupBy: string | null;
  mediaNode: string | null;
  requestedAt: string;
  reservedAt?: string | null;
  dialingAt?: string | null;
  ringingAt?: string | null;
  answeredAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  stateChangedAt?: string;
  queueItemId?: string | null;
  version: number;
  events?: { from: CallState | null; to: CallState; source: string; sipCode: number | null; at: string }[];
}

export interface DialInfo {
  target: string;
  headers: Record<string, string>;
  expiresInMs: number;
}

export type InitiateResult =
  | { queued: false; call: CallView; dial: DialInfo | null; replayed: boolean }
  | { queued: true; queueItem: { id: string; priority: Priority; state: string } };

export interface QueueItem {
  id: string;
  organizationId: string;
  atmId: string;
  atmCode: string;
  atmName: string;
  regionName: string;
  priority: Priority;
  state: 'WAITING' | 'OFFERED' | 'FULFILLED' | 'CANCELLED' | 'EXPIRED';
  source: 'OPERATOR' | 'SUPERVISOR' | 'INTEGRATION';
  reason: string | null;
  externalRef: string | null;
  preferredOperatorId: string | null;
  offeredOperatorId: string | null;
  offeredOperatorName: string | null;
  offerExpiresAt: string | null;
  requestedByName: string | null;
  escalatedAt: string | null;
  enqueuedAt: string;
  expiresAt: string;
  closedAt: string | null;
  closeReason: string | null;
  atmBusy: boolean;
  position: number | null;
  version: number;
}

export interface DashboardSummary {
  totalAtms: number;
  onlineAtms: number;
  offlineAtms: number;
  provisionedSipDevices: number;
  registeredSipDevices: number;
  activeCalls: number;
  connectedCalls: number;
  availableOperators: number;
  busyOperators: number;
  unavailableOperators: number;
  offlineOperators: number;
  faultyDevices: number;
  callsToday: number;
  failedCallsToday: number;
  queuedRequests: number;
  asOf: string;
}

export interface ActivityItem {
  kind: 'call' | 'device';
  id: string;
  at: string;
  type: string;
  severity: 'info' | 'warning' | 'critical';
  atmCode: string;
  atmName: string;
  operatorName: string | null;
  refId: string;
}

export interface RegionStat {
  id: string;
  name: string;
  total: number;
  online: number;
  faults: number;
  activeCalls: number;
  availableOperators: number;
}

export interface CallsReport {
  from: string;
  to: string;
  bucket: 'hour' | 'day';
  series: { bucket: string; total: number; connected: number; failed: number; avgDurationSec: number }[];
  byRegion: { region: string; total: number; connected: number; failed: number }[];
  byOperator: { operator: string; calls: number; connected: number; talkTimeSec: number }[];
  failures: { state: string; reason: string; sipCode: number | null; count: number }[];
}

export interface AvailabilityPoint {
  bucket: string;
  registrations: number;
  disconnects: number;
  faults: number;
}

export interface HealthComponent {
  name: string;
  status: 'up' | 'degraded' | 'down';
  detail: string;
  latencyMs: number | null;
}

export interface SystemHealth {
  status: 'up' | 'degraded' | 'down';
  node: string;
  version: string;
  sipDriver: string;
  uptimeSec: number;
  components: HealthComponent[];
  jobs: { name: string; lastRunAt: string | null; lastDurationMs: number | null; lastError: string | null }[];
  checkedAt: string;
}

export interface AuditEntry {
  id: string;
  organizationId: string | null;
  actorUserId: string | null;
  actorUsername: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  outcome: 'SUCCESS' | 'FAILURE' | 'DENIED';
  ip: string | null;
  correlationId: string | null;
  detail: Record<string, unknown> | null;
  occurredAt: string;
}

export interface AuditFilters {
  action?: string;
  actor?: string;
  outcome?: string;
  entityType?: string;
  entityId?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

export interface Assignment {
  atmId: string;
  atmCode: string;
  atmName: string;
  regionName: string;
  primaryOperatorId: string | null;
  primaryOperatorName: string | null;
  backupOperatorId: string | null;
  backupOperatorName: string | null;
  shiftId: string | null;
  updatedAt: string;
  version: number;
}

export interface Override {
  id: string;
  atmId: string;
  atmCode: string;
  atmName: string;
  operatorId: string;
  operatorName: string;
  reason: string;
  createdByName: string;
  startsAt: string;
  endsAt: string;
  revokedAt: string | null;
  active: boolean;
}

export interface ResolveResult {
  kind: 'OVERRIDE' | 'PRIMARY' | 'BACKUP' | 'DYNAMIC' | 'ESCALATE';
  operatorId: string | null;
  policySource: string;
  trace: { step: string; operatorId: string | null; outcome: string; reason: string }[];
}

export interface Shift {
  id: string;
  name: string;
  regionId: string | null;
  regionName: string | null;
  daysOfWeek: number[];
  startTime: string;
  endTime: string;
  timezone: string;
  members: { operatorId: string; name: string; validFrom: string; validTo: string | null; onShift: boolean }[];
  version: number;
}

export interface RegionRef extends Ref {
  code: string;
  atmCount: number;
  onlineCount?: number;
}

export interface Organization {
  id: string;
  code: string;
  name: string;
  timezone: string;
  status: string;
  atmCount: number;
  operatorCount: number;
}

export interface UserRow {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  status: string;
  organizationId: string | null;
  lastLoginAt: string | null;
  roles: Role[];
  operatorId: string | null;
}

export interface WebRtcConfig {
  wssUrl: string;
  sipUri: string;
  authorizationUsername: string;
  password: string;
  realm: string;
  iceServers: RTCIceServer[];
  driver: 'simulated' | 'ari';
}

export interface ImportResult {
  dryRun: boolean;
  total: number;
  created: number;
  updated: number;
  errors: number;
  results: { line: number; atmCode: string; status: 'CREATED' | 'UPDATED' | 'ERROR'; error?: string; credentials?: SipCredential }[];
}

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  correlationId?: string;
}
