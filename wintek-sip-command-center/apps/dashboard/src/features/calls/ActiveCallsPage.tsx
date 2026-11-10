import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, PhoneOff } from 'lucide-react';
import { useState } from 'react';
import { PageHeader } from '@/app/AppShell';
import { CallStateBadge, PriorityBadge } from '@/components/StatusBadges';
import { EmptyState, ErrorState, LoadingSkeleton } from '@/components/States';
import { ConfirmationDialog } from '@/components/ConfirmationDialog';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Select } from '@/components/ui/input';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { useNow } from '@/hooks/useNow';
import { formatDateTime, formatDuration, formatTime } from '@/lib/utils';
import { dataService } from '@/services/api';
import { useSession } from '@/stores/session';
import type { CallView } from '@/types/api';

export function ActiveCallsPage() {
  const can = useSession((s) => s.can);
  const now = useNow(1000);
  const active = useQuery({ queryKey: ['activeCalls'], queryFn: () => dataService.activeCalls(), refetchInterval: 10_000 });
  const [page, setPage] = useState(1);
  const [state, setState] = useState('');
  const hist = useQuery({ queryKey: ['callHistory', page, state], queryFn: () => dataService.callHistory({ page, pageSize: 25, state: state || undefined }), placeholderData: keepPreviousData });
  const [ending, setEnding] = useState<CallView | null>(null);
  const hangup = useMutation({ mutationFn: (id: string) => dataService.hangup(id) });
  const pages = hist.data ? Math.max(1, Math.ceil(hist.data.total / hist.data.pageSize)) : 1;
  return (
    <div className="space-y-4 px-6 pb-24">
      <PageHeader inset={false} title="Active calls" description="Every call in progress across your organization. Supervisors can end calls." />
      <Card>
        <CardHeader><CardTitle>In progress ({active.data?.length ?? 0})</CardTitle></CardHeader>
        {active.isLoading ? <LoadingSkeleton rows={4} /> : active.error ? <ErrorState error={active.error} onRetry={() => active.refetch()} /> : !active.data?.length ? <EmptyState title="No calls in progress" /> : (
          <Table>
            <THead><TR><TH>State</TH><TH>ATM</TH><TH>Region</TH><TH>Operator</TH><TH>Priority</TH><TH>Started</TH><TH>Connected for</TH><TH>Node</TH><TH /></TR></THead>
            <TBody>
              {active.data.map((c) => (
                <TR key={c.id}>
                  <TD><CallStateBadge state={c.state} /></TD>
                  <TD><span className="font-mono text-xs">{c.atmCode}</span> <span className="text-muted">{c.atmName}</span></TD>
                  <TD>{c.regionName}</TD><TD>{c.operatorName}</TD><TD><PriorityBadge p={c.priority} /></TD>
                  <TD className="text-xs">{formatTime(c.requestedAt)}</TD>
                  <TD className="num">{c.answeredAt ? formatDuration(now - +new Date(c.answeredAt)) : '—'}</TD>
                  <TD className="font-mono text-xs text-muted">{c.mediaNode ?? '—'}</TD>
                  <TD className="text-right">{can('call:hangup:any') && <Button size="sm" variant="danger" onClick={() => setEnding(c)}><PhoneOff /> End</Button>}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Call history (metadata only — no audio is recorded)</CardTitle>
          <Select aria-label="Result filter" value={state} onChange={(e) => { setState(e.target.value); setPage(1); }}>
            <option value="">All results</option>{['COMPLETED', 'TIMEOUT', 'FAILED', 'BUSY', 'CANCELLED'].map((s) => <option key={s}>{s}</option>)}
          </Select>
        </CardHeader>
        {hist.isLoading ? <LoadingSkeleton rows={8} /> : hist.error ? <ErrorState error={hist.error} /> : (
          <>
            <Table>
              <THead><TR><TH>Requested</TH><TH>ATM</TH><TH>Operator</TH><TH>Result</TH><TH>Priority</TH><TH>Routing</TH><TH>Duration</TH><TH>SIP</TH><TH>Reason</TH></TR></THead>
              <TBody>
                {hist.data?.items.map((c) => (
                  <TR key={c.id}>
                    <TD className="whitespace-nowrap text-xs">{formatDateTime(c.requestedAt)}</TD>
                    <TD><span className="font-mono text-xs">{c.atmCode}</span></TD><TD>{c.operatorName}</TD>
                    <TD><CallStateBadge state={c.state} /></TD><TD><PriorityBadge p={c.priority} /></TD>
                    <TD className="text-xs text-muted">{c.routingDecision?.toLowerCase()}</TD>
                    <TD className="num">{formatDuration(c.durationMs)}</TD>
                    <TD className="font-mono text-xs">{c.sipCode ?? '—'}</TD>
                    <TD className="max-w-xs truncate text-xs text-muted">{c.failureReason ?? ''}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            <div className="flex items-center justify-end gap-1 border-t px-3 py-2 text-xs text-muted">
              <span className="num mr-2">{hist.data?.total.toLocaleString()} calls</span>
              <Button variant="ghost" size="icon-sm" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label="Previous page"><ChevronLeft /></Button>
              <span className="num">{page} / {pages}</span>
              <Button variant="ghost" size="icon-sm" disabled={page >= pages} onClick={() => setPage(page + 1)} aria-label="Next page"><ChevronRight /></Button>
            </div>
          </>
        )}
      </Card>
      <ConfirmationDialog open={!!ending} onOpenChange={(o) => !o && setEnding(null)} title={`End call on ${ending?.atmCode}?`} description={`${ending?.operatorName} will be disconnected. This is recorded in the audit log as a supervisor hang-up.`} confirmLabel="End call" onConfirm={() => hangup.mutateAsync(ending!.id)} />
    </div>
  );
}
