import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ACTIVE_CALL_STATES } from '@wintek/shared';
import { ExternalLink, Headset, Mic, Phone, PhoneCall, Search } from 'lucide-react';
import { useState } from 'react';
import { PageHeader } from '@/app/AppShell';
import { DeviceSelectors } from '@/components/CallControlBar';
import { PriorityQueuePanel } from '@/components/PriorityQueuePanel';
import { ATMStatusBadge, AvailabilityBadge, CallStateBadge, HealthBadge } from '@/components/StatusBadges';
import { EmptyState, ErrorState, LoadingSkeleton } from '@/components/States';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, Select } from '@/components/ui/input';
import { useNow } from '@/hooks/useNow';
import { cn, relativeTime } from '@/lib/utils';
import { dataService } from '@/services/api';
import { useConsole } from '@/stores/console';
import { callErrorText } from '@/utils/status';

/**
 * The operator's workstation: their ATMs on the left, the selected ATM with a
 * single large CALL action on the right. The CALL button is disabled unless
 * the server-side rules would accept the call, and is guarded against double
 * clicks (one requestId per click; the server dedupes retries).
 */
export function OperatorConsolePage() {
  const [q, setQ] = useState('');
  const [onlineOnly, setOnlineOnly] = useState(true);
  const [sel, setSel] = useState<string | null>(null);
  const [priority, setPriority] = useState<'P1' | 'P2' | 'P3'>('P3');
  const now = useNow(10_000);
  const c = useConsole();
  const list = useQuery({
    queryKey: ['atms', 'console', q, onlineOnly],
    queryFn: () => dataService.atms({ mine: true, q: q || undefined, registration: onlineOnly ? 'REGISTERED' : undefined, pageSize: 100, sort: 'atmCode' }),
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  });
  const detail = useQuery({ queryKey: ['atm', sel], queryFn: () => dataService.atm(sel!), enabled: !!sel });
  const a = detail.data;
  const myActive = !!c.call && ACTIVE_CALL_STATES.has(c.call.state);
  const reasons: string[] = [];
  if (c.registration !== 'registered') reasons.push('softphone not registered');
  if (c.micPermission === 'denied') reasons.push('microphone permission denied');
  if (c.effective !== 'AVAILABLE' && !myActive) reasons.push(`you are ${c.effective.toLowerCase()}`);
  if (myActive) reasons.push('you are already in a call');
  if (a && a.registrationStatus !== 'REGISTERED') reasons.push('ATM offline');
  if (a && a.status !== 'ACTIVE') reasons.push(`ATM ${a.status.toLowerCase()}`);
  if (a?.activeCallId && a.activeCallId !== c.call?.id) reasons.push('ATM busy');
  const callable = !!a && reasons.length === 0 && !c.placing;
  const atmBusyOnly = !!a && reasons.length === 1 && reasons[0] === 'ATM busy';

  return (
    <div className="pb-24">
      <PageHeader
        title="Operator console"
        description="Select an ATM and call. The intercom answers automatically."
        actions={
          <div className="flex items-center gap-3 text-sm">
            <span className="flex items-center gap-2"><Headset className="size-4 text-muted" /> Softphone <Badge tone={c.registration === 'registered' ? 'success' : c.registration === 'failed' ? 'danger' : 'warning'}>{c.registration}</Badge></span>
            <span className="flex items-center gap-2"><Mic className="size-4 text-muted" /> Mic <Badge tone={c.micPermission === 'granted' ? 'success' : c.micPermission === 'unknown' ? 'neutral' : 'danger'}>{c.micPermission}</Badge></span>
            <AvailabilityBadge value={c.effective} />
          </div>
        }
      />
      {c.registrationDetail && c.registration === 'failed' && <div className="mx-6 mb-3 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">Softphone: {c.registrationDetail}</div>}
      <div className="grid gap-4 px-6 lg:grid-cols-[380px_1fr]">
        <Card className="flex max-h-[calc(100vh-190px)] flex-col">
          <CardHeader className="flex-col items-stretch gap-2">
            <div className="flex items-center justify-between"><CardTitle>My ATMs</CardTitle><span className="num text-xs text-muted">{list.data?.total.toLocaleString() ?? '…'}</span></div>
            <div className="relative"><Search className="absolute left-2.5 top-2.5 size-4 text-subtle" /><Input className="pl-8" placeholder="Filter by ID, site, city" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter my ATMs" /></div>
            <label className="flex items-center gap-2 text-xs text-muted"><input type="checkbox" checked={onlineOnly} onChange={(e) => setOnlineOnly(e.target.checked)} /> Online only</label>
          </CardHeader>
          <div className="flex-1 overflow-y-auto" role="listbox" aria-label="ATMs">
            {list.isLoading ? <LoadingSkeleton rows={8} /> : list.error ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : !list.data?.items.length ? <EmptyState title="No ATMs" description="No ATMs are assigned to you or match the filter." /> : (
              list.data.items.map((x) => (
                <button key={x.id} role="option" aria-selected={sel === x.id} onClick={() => setSel(x.id)}
                  className={cn('flex w-full items-center gap-3 border-b px-4 py-2.5 text-left hover:bg-elevated/50', sel === x.id && 'bg-primary/10 shadow-[inset_2px_0_0_hsl(var(--primary))]')}>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2"><span className="font-mono text-xs">{x.atmCode}</span>{x.overrideOperatorId && <Badge tone="warning">override</Badge>}</div>
                    <div className="truncate text-sm text-muted">{x.name}</div>
                  </div>
                  {x.activeCallState ? <CallStateBadge state={x.activeCallState} /> : <ATMStatusBadge registration={x.registrationStatus} status={x.status} />}
                </button>
              ))
            )}
          </div>
        </Card>

        <div className="space-y-4">
          <Card>
            {!sel ? <EmptyState icon={<Phone className="size-6" />} title="Select an ATM to call" description="Use the list on the left. Press / to search all ATMs." /> : detail.isLoading ? <LoadingSkeleton rows={6} /> : detail.error ? <ErrorState error={detail.error} /> : a && (
              <CardContent className="space-y-5 p-6">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <div className="font-mono text-sm text-muted">{a.atmCode}</div>
                    <h2 className="text-2xl font-semibold">{a.name}</h2>
                    <div className="mt-1 text-sm text-muted">{[a.site, a.city, a.state].filter(Boolean).join(' · ')} · {a.regionName}</div>
                    <div className="mt-3 flex flex-wrap gap-2"><ATMStatusBadge registration={a.registrationStatus} status={a.status} inCall={!!a.activeCallId} /><HealthBadge health={a.health} /><Badge>fw {a.firmwareVersion}</Badge><Badge>seen {relativeTime(a.lastSeenAt, now)}</Badge></div>
                  </div>
                  {a.vmsLink && <Button variant="secondary" asChild><a href={a.vmsLink} target="_blank" rel="noopener noreferrer"><ExternalLink /> Camera (VMS)</a></Button>}
                </div>
                <div className="grid gap-3 text-sm sm:grid-cols-3">
                  <div><div className="text-[11px] uppercase tracking-wider text-subtle">Assigned</div>{a.overrideOperatorName ?? a.primaryOperatorName ?? '—'}</div>
                  <div><div className="text-[11px] uppercase tracking-wider text-subtle">Backup</div>{a.backupOperatorName ?? '—'}</div>
                  <div><div className="text-[11px] uppercase tracking-wider text-subtle">Current call</div>{a.activeCallState ? <span><CallStateBadge state={a.activeCallState} /> {a.activeCallOperatorName}</span> : 'none'}</div>
                </div>
                <div className="flex flex-wrap items-center gap-3 border-t pt-5">
                  <Select aria-label="Priority" value={priority} onChange={(e) => setPriority(e.target.value as 'P1')}>
                    <option value="P1">P1 · Critical</option><option value="P2">P2 · High</option><option value="P3">P3 · Normal</option>
                  </Select>
                  {atmBusyOnly ? (
                    <Button size="xl" variant="warning" onClick={() => void c.placeCall(a.id, { priority, queueIfBusy: true })} disabled={c.placing}><PhoneCall /> Queue call (ATM busy)</Button>
                  ) : (
                    <Button size="xl" variant="success" disabled={!callable} onClick={() => void c.placeCall(a.id, { priority })} className="min-w-48">
                      <Phone /> {c.placing ? 'Calling…' : 'CALL'}
                    </Button>
                  )}
                  {reasons.length > 0 && !c.placing && <span className="text-sm text-muted">Unavailable: {reasons.join(' · ')}</span>}
                  {c.error && <span role="alert" className="text-sm text-danger">{callErrorText[c.error.code] ?? c.error.message}</span>}
                </div>
              </CardContent>
            )}
          </Card>
          <div className="grid gap-4 xl:grid-cols-2">
            <PriorityQueuePanel compact />
            <Card><CardHeader><CardTitle>Audio devices</CardTitle></CardHeader><CardContent><DeviceSelectors /></CardContent></Card>
          </div>
        </div>
      </div>
    </div>
  );
}
