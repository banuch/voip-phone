import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertOctagon, Clock, Phone, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { useNow } from '@/hooks/useNow';
import { cn, formatDuration } from '@/lib/utils';
import { dataService } from '@/services/api';
import { useConsole } from '@/stores/console';
import { useSession } from '@/stores/session';
import type { QueueItem } from '@/types/api';
import { PriorityBadge } from './StatusBadges';
import { EmptyState, ErrorState, LoadingSkeleton } from './States';

export function useQueue(includeClosed = false) {
  return useQuery({ queryKey: ['queue', includeClosed], queryFn: () => dataService.queue(includeClosed), refetchInterval: 10_000 });
}

/** Pending call requests in dispatch order. An offer to me shows an Accept (= place the call) action. */
export function PriorityQueuePanel({ compact, items: given }: { compact?: boolean; items?: QueueItem[] }) {
  const q = useQueue();
  const qc = useQueryClient();
  const now = useNow(1000);
  const me = useSession((s) => s.user);
  const can = useSession((s) => s.can);
  const placeCall = useConsole((s) => s.placeCall);
  const cancel = useMutation({ mutationFn: (id: string) => dataService.cancelQueue(id), onSettled: () => qc.invalidateQueries({ queryKey: ['queue'] }) });
  const decline = useMutation({ mutationFn: (id: string) => dataService.declineQueue(id), onSettled: () => qc.invalidateQueries({ queryKey: ['queue'] }) });
  const items = (given ?? q.data ?? []).filter((i) => i.state === 'WAITING' || i.state === 'OFFERED');

  return (
    <Card className="flex flex-col">
      <CardHeader>
        <CardTitle>Call queue</CardTitle>
        <Badge tone={items.some((i) => i.priority === 'P1') ? 'danger' : items.length ? 'warning' : 'neutral'}>{items.length} pending</Badge>
      </CardHeader>
      {q.isLoading && !given ? (
        <LoadingSkeleton rows={3} />
      ) : q.error && !given ? (
        <ErrorState compact error={q.error} onRetry={() => q.refetch()} />
      ) : !items.length ? (
        <EmptyState title="No pending requests" description="Requests appear here when an ATM is busy or a supervisor raises one." />
      ) : (
        <ol className={cn('divide-y', compact && 'max-h-80 overflow-y-auto')}>
          {items.map((i) => {
            const mine = i.offeredOperatorId && i.offeredOperatorId === me?.operatorId;
            const waited = now - +new Date(i.enqueuedAt);
            const left = +new Date(i.expiresAt) - now;
            return (
              <li key={i.id} className={cn('flex items-center gap-3 px-4 py-3', mine && 'bg-primary/10', i.priority === 'P1' && 'border-l-2 border-l-danger')}>
                <span className="num w-6 text-center text-sm font-semibold text-muted">{i.position ?? '–'}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <PriorityBadge p={i.priority} />
                    <span className="truncate text-sm font-medium">{i.atmCode}</span>
                    {i.escalatedAt && <Badge tone="danger"><AlertOctagon className="size-3" />escalated</Badge>}
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 truncate text-xs text-muted">
                    <span className="truncate">{i.atmName}</span>·<span>{i.reason ?? i.source.toLowerCase()}</span>
                    {i.externalRef && <span className="font-mono">#{i.externalRef}</span>}
                  </div>
                  <div className="mt-1 flex items-center gap-3 text-[11px] text-subtle">
                    <span className="flex items-center gap-1"><Clock className="size-3" />waiting {formatDuration(waited)}</span>
                    <span>expires in {formatDuration(Math.max(0, left))}</span>
                    {i.state === 'OFFERED' && <span className="text-primary">offered to {mine ? 'you' : i.offeredOperatorName}</span>}
                    {i.atmBusy && <span className="text-warning">ATM busy</span>}
                  </div>
                </div>
                {mine && (
                  <div className="flex gap-1">
                    <Button size="sm" variant="success" onClick={() => void placeCall(i.atmId, { queueItemId: i.id, priority: i.priority })}><Phone /> Accept</Button>
                    <Button size="sm" variant="ghost" onClick={() => decline.mutate(i.id)}>Pass</Button>
                  </div>
                )}
                {!mine && can('queue:manage') && (
                  <Button size="icon-sm" variant="ghost" onClick={() => cancel.mutate(i.id)} aria-label={`Cancel request for ${i.atmCode}`}><X /></Button>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}
