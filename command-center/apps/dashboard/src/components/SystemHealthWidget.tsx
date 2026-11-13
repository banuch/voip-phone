import { useQuery } from '@tanstack/react-query';
import { Activity, Database, Radio, Server, Wifi } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { dataService } from '@/services/api';
import { useSession } from '@/stores/session';
import { cn } from '@/lib/utils';
import { ErrorState, LoadingSkeleton } from './States';

const icon = (name: string) => (name.startsWith('media') ? Radio : name === 'database' ? Database : name === 'websocket' ? Wifi : name.includes('kamailio') ? Server : Activity);
const dot = { up: 'bg-success', degraded: 'bg-warning', down: 'bg-danger' } as const;

export function useHealth() {
  const allowed = useSession((s) => s.can('system:read'));
  return useQuery({ queryKey: ['health'], queryFn: () => dataService.health(), refetchInterval: 15_000, enabled: allowed });
}

export function SystemHealthWidget() {
  const q = useHealth();
  const allowed = useSession((s) => s.can('system:read'));
  if (!allowed) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>System health</CardTitle>
        {q.data && <Badge tone={q.data.status === 'up' ? 'success' : q.data.status === 'degraded' ? 'warning' : 'danger'}>{q.data.status}</Badge>}
      </CardHeader>
      {q.isLoading ? (
        <LoadingSkeleton rows={4} />
      ) : q.error ? (
        <ErrorState compact error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <CardContent className="space-y-1.5 p-3">
          {q.data!.components.map((c) => {
            const I = icon(c.name);
            return (
              <div key={c.name} className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-elevated/50">
                <I className="size-4 text-muted" aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="text-sm">{c.name}</div>
                  <div className="truncate text-xs text-subtle" title={c.detail}>{c.detail}</div>
                </div>
                {c.latencyMs !== null && <span className="num text-xs text-muted">{c.latencyMs} ms</span>}
                <span className={cn('size-2 rounded-full', dot[c.status])} aria-label={c.status} />
              </div>
            );
          })}
          <div className="px-2 pt-1 text-[11px] text-subtle">
            node {q.data!.node} · driver {q.data!.sipDriver} · v{q.data!.version}
          </div>
        </CardContent>
      )}
    </Card>
  );
}
