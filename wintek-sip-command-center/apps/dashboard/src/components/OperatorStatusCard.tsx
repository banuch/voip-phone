import { Headset, MapPin, PhoneCall } from 'lucide-react';
import type { Operator } from '@/types/api';
import { cn, formatDuration, relativeTime } from '@/lib/utils';
import { useNow } from '@/hooks/useNow';
import { AvailabilityBadge, CallStateBadge } from './StatusBadges';

export function OperatorStatusCard({ op, onClick }: { op: Operator; onClick?: () => void }) {
  const now = useNow(1000);
  const initials = op.name.split(' ').map((p) => p[0]).slice(0, 2).join('');
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn('panel flex w-full items-start gap-3 p-3 text-left transition-colors hover:bg-elevated/40', op.currentCall && 'border-primary/40')}
    >
      <div className="relative">
        <div className="grid size-10 place-items-center rounded-full bg-elevated text-sm font-semibold">{initials}</div>
        <span
          className={cn(
            'absolute -bottom-0.5 -right-0.5 size-3 rounded-full border-2 border-card',
            op.availability === 'AVAILABLE' ? 'bg-success' : op.availability === 'BUSY' ? 'bg-primary' : op.availability === 'OFFLINE' ? 'bg-neutral' : op.availability === 'FAULT' ? 'bg-danger' : 'bg-warning',
          )}
        />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <div className="truncate text-sm font-medium">{op.name}</div>
          <AvailabilityBadge value={op.availability} />
        </div>
        <div className="mt-0.5 flex items-center gap-3 text-xs text-muted">
          <span className="flex items-center gap-1"><MapPin className="size-3" />{op.regions.map((r) => r.name).join(', ') || '—'}</span>
          <span className="flex items-center gap-1"><Headset className="size-3" />{op.sipRegistered ? 'console online' : 'no console'}</span>
        </div>
        {op.currentCall ? (
          <div className="mt-2 flex items-center gap-2 text-xs">
            <PhoneCall className="size-3 text-primary" />
            <CallStateBadge state={op.currentCall.state} />
            {op.currentCall.answeredAt && <span className="num text-muted">{formatDuration(now - +new Date(op.currentCall.answeredAt))}</span>}
          </div>
        ) : (
          <div className="mt-2 text-xs text-subtle">
            {op.primaryAssignments} primary · {op.backupAssignments} backup · {op.onShift ? 'on shift' : 'off shift'} · seen {relativeTime(op.lastHeartbeatAt, now)}
          </div>
        )}
      </div>
    </button>
  );
}
