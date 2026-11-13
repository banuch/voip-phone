import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CircleOff, Headset, PhoneCall, PhoneOutgoing, Radio, Server, UserCheck, UserMinus, Wifi } from 'lucide-react';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { PageHeader } from '@/app/AppShell';
import { DashboardStatCard } from '@/components/DashboardStatCard';
import { PriorityQueuePanel } from '@/components/PriorityQueuePanel';
import { CallStateBadge } from '@/components/StatusBadges';
import { EmptyState, ErrorState, LoadingSkeleton } from '@/components/States';
import { SystemHealthWidget } from '@/components/SystemHealthWidget';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useNow } from '@/hooks/useNow';
import { cn, formatDuration, relativeTime } from '@/lib/utils';
import { dataService } from '@/services/api';
import { useRealtime } from '@/stores/realtime';
import { useSession } from '@/stores/session';
import { INK, SERIES, STATUS, axisProps, hourLabel, legendProps, tooltipProps } from '@/utils/chartTheme';

export function OverviewPage() {
  const can = useSession((s) => s.can);
  const summary = useQuery({ queryKey: ['summary'], queryFn: () => dataService.summary(), refetchInterval: 30_000 });
  const regions = useQuery({ queryKey: ['regionStats'], queryFn: () => dataService.regionStats(), refetchInterval: 60_000 });
  const report = useQuery({ queryKey: ['callsReport', '24h'], queryFn: () => dataService.callsReport({ bucket: 'hour' }), enabled: can('report:read'), refetchInterval: 120_000 });
  const avail = useQuery({ queryKey: ['availReport', '24h'], queryFn: () => dataService.availabilityReport({ bucket: 'hour' }), enabled: can('report:read'), refetchInterval: 120_000 });
  const active = useQuery({ queryKey: ['activeCalls'], queryFn: () => dataService.activeCalls(), refetchInterval: 15_000, enabled: can('call:read') });
  const activity = useQuery({ queryKey: ['activity'], queryFn: () => dataService.activity(30), refetchInterval: 30_000 });
  const s = summary.data;
  const L = summary.isLoading;
  const now = useNow(1000);
  const recent = useRealtime((r) => r.recent);
  const live = recent.slice(0, 8);

  return (
    <div className="pb-24">
      <PageHeader title="Operations overview" description={s ? `As of ${new Date(s.asOf).toLocaleTimeString()} · updates live` : 'Loading…'} />
      {summary.error && <div className="px-6"><ErrorState compact error={summary.error} onRetry={() => summary.refetch()} /></div>}
      <div className="grid grid-cols-2 gap-3 px-6 md:grid-cols-3 xl:grid-cols-5">
        <DashboardStatCard label="Registered ATMs" value={s?.totalAtms} icon={Server} loading={L} to="/atms" hint={s && `${s.provisionedSipDevices.toLocaleString()} SIP identities provisioned`} />
        <DashboardStatCard label="Online ATMs" value={s?.onlineAtms} icon={Wifi} tone="success" loading={L} to="/atms?registration=REGISTERED" hint={s && `${((s.onlineAtms / Math.max(1, s.totalAtms)) * 100).toFixed(1)}% availability`} />
        <DashboardStatCard label="Offline ATMs" value={s?.offlineAtms} icon={CircleOff} tone="danger" emphasis loading={L} to="/atms?registration=UNREGISTERED" />
        <DashboardStatCard label="SIP registered" value={s?.registeredSipDevices} icon={Radio} tone="info" loading={L} hint="live registrar contacts" />
        <DashboardStatCard label="Active calls" value={s?.activeCalls} icon={PhoneCall} tone="primary" emphasis loading={L} to="/calls" hint={s && `${s.connectedCalls} connected`} />
        <DashboardStatCard label="Available operators" value={s?.availableOperators} icon={UserCheck} tone="success" loading={L} to="/operators" />
        <DashboardStatCard label="Busy operators" value={s?.busyOperators} icon={Headset} tone="primary" loading={L} to="/operators" />
        <DashboardStatCard label="Unavailable operators" value={s?.unavailableOperators} icon={UserMinus} tone="warning" loading={L} hint={s && `${s.offlineOperators} offline`} />
        <DashboardStatCard label="Devices with faults" value={s?.faultyDevices} icon={AlertTriangle} tone="danger" emphasis loading={L} to="/atms?health=FAULT" />
        <DashboardStatCard label="Calls today" value={s?.callsToday} icon={PhoneOutgoing} tone="neutral" loading={L} hint={s && `${s.failedCallsToday} failed · ${s.queuedRequests} queued`} />
      </div>

      <div className="mt-4 grid gap-4 px-6 xl:grid-cols-3">
        {can('report:read') && <Card className={can('system:read') ? 'xl:col-span-2' : 'xl:col-span-3'}>
          <CardHeader><CardTitle>Calls per hour · last 24 h</CardTitle><span className="text-xs text-muted">initiated vs failed</span></CardHeader>
          <CardContent className="h-64">
            {!can('report:read') ? <EmptyState title="Reports not available for your role" /> : report.isLoading ? <LoadingSkeleton rows={5} /> : report.error ? <ErrorState compact error={report.error} /> : (
              <ResponsiveContainer>
                <BarChart data={report.data!.series} barGap={2} margin={{ left: -18, right: 4, top: 4 }}>
                  <CartesianGrid vertical={false} stroke={INK.grid} />
                  <XAxis dataKey="bucket" tickFormatter={hourLabel} {...axisProps} minTickGap={24} />
                  <YAxis allowDecimals={false} {...axisProps} />
                  <Tooltip {...tooltipProps} labelFormatter={(v) => hourLabel(String(v))} />
                  <Legend {...legendProps} />
                  <Bar dataKey="total" name="Initiated" fill={SERIES[0]} radius={[4, 4, 0, 0]} maxBarSize={14} />
                  <Bar dataKey="failed" name="Failed / no answer" fill={STATUS.critical} radius={[4, 4, 0, 0]} maxBarSize={14} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>}
        <SystemHealthWidget />
      </div>

      <div className="mt-4 grid gap-4 px-6 xl:grid-cols-3">
        <Card>
          <CardHeader><CardTitle>Regional availability</CardTitle></CardHeader>
          {regions.isLoading ? <LoadingSkeleton rows={4} /> : regions.error ? <ErrorState compact error={regions.error} /> : (
            <ul className="divide-y">
              {regions.data!.map((r) => {
                const pct = (r.online / Math.max(1, r.total)) * 100;
                return (
                  <li key={r.id} className="px-4 py-3">
                    <div className="flex items-center justify-between text-sm"><span className="font-medium">{r.name}</span><span className="num text-muted">{r.online.toLocaleString()} / {r.total.toLocaleString()} online</span></div>
                    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-elevated" role="meter" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label={`${r.name} availability`}>
                      <div className={cn('h-full rounded-full', pct >= 95 ? 'bg-success' : pct >= 85 ? 'bg-warning' : 'bg-danger')} style={{ width: `${pct}%` }} />
                    </div>
                    <div className="mt-1.5 flex gap-4 text-xs text-muted"><span>{pct.toFixed(1)}%</span><span>{r.faults} faults</span><span>{r.activeCalls} in call</span><span>{r.availableOperators} operators available</span></div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
        {can('report:read') && <Card>
          <CardHeader><CardTitle>Device connectivity · 24 h</CardTitle><span className="text-xs text-muted">registrations vs disconnects</span></CardHeader>
          <CardContent className="h-64">
            {!can('report:read') ? <EmptyState title="Reports not available for your role" /> : avail.isLoading ? <LoadingSkeleton rows={5} /> : (
              <ResponsiveContainer>
                <AreaChart data={avail.data ?? []} margin={{ left: -18, right: 4, top: 4 }}>
                  <CartesianGrid vertical={false} stroke={INK.grid} />
                  <XAxis dataKey="bucket" tickFormatter={hourLabel} {...axisProps} minTickGap={24} />
                  <YAxis allowDecimals={false} {...axisProps} />
                  <Tooltip {...tooltipProps} labelFormatter={(v) => hourLabel(String(v))} />
                  <Legend {...legendProps} />
                  <Area type="monotone" dataKey="registrations" name="Registrations" stroke={SERIES[0]} fill={SERIES[0]} fillOpacity={0.12} strokeWidth={2} dot={false} />
                  <Area type="monotone" dataKey="disconnects" name="Disconnects" stroke={SERIES[1]} fill={SERIES[1]} fillOpacity={0.1} strokeWidth={2} dot={false} />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>}
        <PriorityQueuePanel compact />
      </div>

      <div className="mt-4 grid gap-4 px-6 xl:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Active calls</CardTitle><Badge tone={active.data?.length ? 'primary' : 'neutral'}>{active.data?.length ?? 0}</Badge></CardHeader>
          {!active.data?.length ? <EmptyState title="No calls in progress" /> : (
            <ul className="divide-y">
              {active.data.map((c) => (
                <li key={c.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                  <CallStateBadge state={c.state} />
                  <span className="font-mono text-xs">{c.atmCode}</span>
                  <span className="flex-1 truncate text-muted">{c.atmName}</span>
                  <span>{c.operatorName}</span>
                  <span className="num w-14 text-right text-muted">{c.answeredAt ? formatDuration(now - +new Date(c.answeredAt)) : '—'}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card>
          <CardHeader><CardTitle>Recent events</CardTitle><span className="text-xs text-muted">{live.length ? 'live' : 'last 24 h'}</span></CardHeader>
          {activity.isLoading ? <LoadingSkeleton rows={6} /> : (
            <ul className="max-h-80 divide-y overflow-y-auto">
              {live.map((e) => (
                <li key={e.id} className="flex items-center gap-3 px-4 py-2 text-sm animate-fade-in">
                  <Badge tone="info">live</Badge>
                  <span className="font-mono text-xs">{e.type}</span>
                  <span className="flex-1 truncate text-muted">{(e.data as any)?.atmCode ?? (e.data as any)?.operatorId ?? e.entityId}</span>
                  <span className="text-xs text-subtle">{relativeTime(e.ts, now)}</span>
                </li>
              ))}
              {activity.data?.map((a) => (
                <li key={`${a.kind}-${a.id}`} className="flex items-center gap-3 px-4 py-2 text-sm">
                  <Badge tone={a.severity === 'critical' ? 'danger' : a.severity === 'warning' ? 'warning' : 'neutral'}>{a.kind}</Badge>
                  <span className="text-xs">{a.type.toLowerCase()}</span>
                  <span className="font-mono text-xs">{a.atmCode}</span>
                  <span className="flex-1 truncate text-muted">{a.operatorName ?? a.atmName}</span>
                  <span className="text-xs text-subtle">{relativeTime(a.at, now)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
