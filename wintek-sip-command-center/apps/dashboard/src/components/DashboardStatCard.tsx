import type { LucideIcon } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Skeleton } from '@/components/ui/misc';
import { cn, formatNumber } from '@/lib/utils';
import type { Tone } from '@/utils/status';

const toneRing: Record<Tone, string> = {
  success: 'text-success bg-success/10',
  warning: 'text-warning bg-warning/10',
  danger: 'text-danger bg-danger/10',
  info: 'text-info bg-info/10',
  primary: 'text-primary bg-primary/10',
  neutral: 'text-muted bg-elevated',
};

export function DashboardStatCard({ label, value, icon: Icon, tone = 'neutral', hint, to, loading, emphasis }: {
  label: string;
  value: number | null | undefined;
  icon: LucideIcon;
  tone?: Tone;
  hint?: string;
  to?: string;
  loading?: boolean;
  /** Draw attention when the value is non-zero (e.g. faults, active calls). */
  emphasis?: boolean;
}) {
  const body = (
    <div className={cn('panel group relative flex h-full flex-col gap-3 overflow-hidden p-4 transition-colors', to && 'hover:border-primary/40 hover:bg-elevated/40', emphasis && value ? 'border-l-2' : '', emphasis && value && tone === 'danger' && 'border-l-danger', emphasis && value && tone === 'warning' && 'border-l-warning', emphasis && value && tone === 'primary' && 'border-l-primary')}>
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">{label}</span>
        <span className={cn('grid size-8 place-items-center rounded-md', toneRing[tone])}>
          <Icon className="size-4" aria-hidden />
        </span>
      </div>
      {loading ? <Skeleton className="h-8 w-24" /> : <div className="num text-[28px] font-semibold leading-none tracking-tight">{formatNumber(value)}</div>}
      {hint && <div className="text-xs text-subtle">{hint}</div>}
    </div>
  );
  return to ? (
    <Link to={to} className="block focus-visible:rounded-lg" aria-label={`${label}: ${value ?? 'loading'}`}>
      {body}
    </Link>
  ) : (
    body
  );
}
