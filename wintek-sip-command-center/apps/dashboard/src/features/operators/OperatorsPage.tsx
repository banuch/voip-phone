import { useQuery } from '@tanstack/react-query';
import { LayoutGrid, List } from 'lucide-react';
import { useState } from 'react';
import { PageHeader } from '@/app/AppShell';
import { OperatorStatusCard } from '@/components/OperatorStatusCard';
import { RegionFilter } from '@/components/RegionFilter';
import { AvailabilityBadge, CallStateBadge } from '@/components/StatusBadges';
import { EmptyState, ErrorState, LoadingSkeleton } from '@/components/States';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { relativeTime } from '@/lib/utils';
import { dataService } from '@/services/api';
import { ROLE_LABEL } from '@wintek/shared';

export function OperatorsPage() {
  const [q, setQ] = useState('');
  const [availability, setAvailability] = useState('');
  const [regionId, setRegion] = useState<string | undefined>();
  const [view, setView] = useState<'cards' | 'table'>('cards');
  const ops = useQuery({ queryKey: ['operators', q, availability, regionId], queryFn: () => dataService.operators({ q: q || undefined, availability: availability || undefined, regionId }), refetchInterval: 15_000 });
  const items = ops.data?.items ?? [];
  const counts = items.reduce<Record<string, number>>((m, o) => ({ ...m, [o.availability]: (m[o.availability] ?? 0) + 1 }), {});
  return (
    <div className="px-6 pb-24">
      <PageHeader inset={false} title="Operators" description={`Availability is computed by the server from heartbeats, softphone registration and real call state. ${Object.entries(counts).map(([k, v]) => `${v} ${k.toLowerCase()}`).join(' · ')}`} />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input className="w-56" placeholder="Search name or username" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search operators" />
        <RegionFilter value={regionId} onChange={setRegion} />
        <Select aria-label="Availability" value={availability} onChange={(e) => setAvailability(e.target.value)}>
          <option value="">Any availability</option>{['AVAILABLE', 'BUSY', 'BREAK', 'UNAVAILABLE', 'FAULT', 'OFFLINE'].map((a) => <option key={a}>{a}</option>)}
        </Select>
        <div className="ml-auto flex gap-1">
          <Button variant={view === 'cards' ? 'secondary' : 'ghost'} size="icon" onClick={() => setView('cards')} aria-label="Card view"><LayoutGrid /></Button>
          <Button variant={view === 'table' ? 'secondary' : 'ghost'} size="icon" onClick={() => setView('table')} aria-label="Table view"><List /></Button>
        </div>
      </div>
      {ops.isLoading ? <LoadingSkeleton rows={8} /> : ops.error ? <ErrorState error={ops.error} onRetry={() => ops.refetch()} /> : !items.length ? <EmptyState title="No operators match" /> : view === 'cards' ? (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">{items.map((o) => <OperatorStatusCard key={o.id} op={o} />)}</div>
      ) : (
        <div className="panel">
          <Table>
            <THead><TR><TH>Name</TH><TH>Username</TH><TH>Role</TH><TH>Regions</TH><TH>Availability</TH><TH>Selected</TH><TH>Current call</TH><TH>Shift</TH><TH>Primary/backup</TH><TH>SIP identity</TH><TH>Last login</TH><TH>Account</TH></TR></THead>
            <TBody>
              {items.map((o) => (
                <TR key={o.id}>
                  <TD className="font-medium">{o.name}</TD><TD className="font-mono text-xs">{o.username}</TD><TD className="text-xs">{o.roles?.map((r) => ROLE_LABEL[r]).join(', ')}</TD>
                  <TD className="text-xs">{o.regions.map((r) => r.name).join(', ')}</TD><TD><AvailabilityBadge value={o.availability} /></TD>
                  <TD className="text-xs text-muted">{o.selectedAvailability.toLowerCase()}</TD><TD>{o.currentCall ? <CallStateBadge state={o.currentCall.state} /> : '—'}</TD>
                  <TD className="text-xs">{o.onShift ? 'on shift' : 'off'}</TD><TD className="num text-xs">{o.primaryAssignments} / {o.backupAssignments}</TD>
                  <TD className="font-mono text-xs text-muted">{o.sipUsername}</TD><TD className="text-xs">{relativeTime(o.lastLoginAt)}</TD><TD className="text-xs">{o.status.toLowerCase()}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
      )}
    </div>
  );
}
