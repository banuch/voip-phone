import { AlertTriangle, Inbox, RefreshCw } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/misc';
import { ApiError } from '@/services/api';

export function EmptyState({ title, description, action, icon = <Inbox className="size-6" /> }: { title: string; description?: string; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <div className="grid size-11 place-items-center rounded-full bg-elevated text-muted">{icon}</div>
      <div className="text-sm font-medium">{title}</div>
      {description && <p className="max-w-sm text-sm text-muted">{description}</p>}
      {action}
    </div>
  );
}

export function ErrorState({ error, onRetry, compact }: { error: unknown; onRetry?: () => void; compact?: boolean }) {
  const e = error as ApiError | Error | undefined;
  const msg = e?.message ?? 'Something went wrong';
  const corr = e instanceof ApiError ? e.correlationId : undefined;
  return (
    <div role="alert" className={compact ? 'flex items-center gap-3 p-3 text-sm' : 'flex flex-col items-center gap-2 px-6 py-10 text-center'}>
      <AlertTriangle className="size-5 shrink-0 text-danger" aria-hidden />
      <div>
        <div className="text-sm font-medium">Couldn’t load this data</div>
        <div className="text-sm text-muted">{msg}</div>
        {corr && <div className="mt-1 font-mono text-[11px] text-subtle">ref {corr}</div>}
      </div>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RefreshCw /> Retry
        </Button>
      )}
    </div>
  );
}

export function LoadingSkeleton({ rows = 6, className }: { rows?: number; className?: string }) {
  return (
    <div className={className ?? 'space-y-2 p-4'} aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-8 w-full" style={{ opacity: 1 - i * 0.1 }} />
      ))}
    </div>
  );
}
