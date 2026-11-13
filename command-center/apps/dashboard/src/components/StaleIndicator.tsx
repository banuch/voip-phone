import { WifiOff } from 'lucide-react';
import { useNow } from '@/hooks/useNow';
import { useRealtime } from '@/stores/realtime';
import { cn } from '@/lib/utils';

/**
 * Live-data indicator. Green while the event stream is open, amber while
 * reconnecting, red when offline. Data on screen is then explicitly marked
 * as possibly stale so nobody acts on old status without knowing.
 */
export function StaleIndicator({ className }: { className?: string }) {
  const { connection, detail, lastEventAt } = useRealtime();
  const now = useNow(5000);
  const label = connection === 'open' ? 'Live' : connection === 'connecting' ? 'Connecting' : connection === 'reconnecting' ? 'Reconnecting' : 'Offline';
  const tone = connection === 'open' ? 'text-success' : connection === 'offline' ? 'text-danger' : 'text-warning';
  return (
    <div className={cn('flex items-center gap-2 text-xs', className)} title={detail ?? undefined} role="status" aria-live="polite">
      {connection === 'offline' ? <WifiOff className={cn('size-3.5', tone)} /> : <span className={cn('relative flex size-2')}><span className={cn('absolute inline-flex size-full rounded-full opacity-60', connection === 'open' ? 'animate-ping bg-success' : 'bg-warning')} /><span className={cn('relative inline-flex size-2 rounded-full', connection === 'open' ? 'bg-success' : 'bg-warning')} /></span>}
      <span className={tone}>{label}</span>
      {lastEventAt && connection === 'open' && <span className="hidden text-subtle xl:inline">· last event {Math.max(0, Math.round((now - lastEventAt) / 1000))}s ago</span>}
    </div>
  );
}

/** Banner over data views while the stream is down. */
export function StaleBanner() {
  const connection = useRealtime((s) => s.connection);
  if (connection === 'open' || connection === 'connecting') return null;
  return (
    <div role="alert" className="flex items-center gap-2 border-b border-warning/30 bg-warning/10 px-4 py-1.5 text-xs text-warning">
      <WifiOff className="size-3.5" />
      Real-time updates interrupted — statuses shown may be out of date. Reconnecting automatically.
    </div>
  );
}
