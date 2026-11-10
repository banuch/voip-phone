import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Phone } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { Tooltip } from '@/components/ui/misc';
import { useNow } from '@/hooks/useNow';
import { cn, relativeTime } from '@/lib/utils';
import type { Atm, Page } from '@/types/api';
import { ATMStatusBadge, CallStateBadge, HealthBadge } from './StatusBadges';
import { EmptyState, ErrorState, LoadingSkeleton } from './States';

export type AtmColumn =
  | 'atmCode' | 'name' | 'organization' | 'region' | 'state' | 'city' | 'site' | 'sip' | 'model' | 'firmware' | 'registration'
  | 'lastSeen' | 'assigned' | 'primary' | 'backup' | 'call' | 'health' | 'actions';

export const ALL_ATM_COLUMNS: { id: AtmColumn; label: string; sort?: string }[] = [
  { id: 'atmCode', label: 'ATM ID', sort: 'atmCode' },
  { id: 'name', label: 'Name', sort: 'name' },
  { id: 'organization', label: 'Customer' },
  { id: 'region', label: 'Region', sort: 'region' },
  { id: 'state', label: 'State' },
  { id: 'city', label: 'City', sort: 'city' },
  { id: 'site', label: 'Site' },
  { id: 'sip', label: 'SIP identity' },
  { id: 'model', label: 'Model' },
  { id: 'firmware', label: 'Firmware', sort: 'firmware' },
  { id: 'registration', label: 'Registration', sort: 'registration' },
  { id: 'lastSeen', label: 'Last seen', sort: 'lastSeen' },
  { id: 'assigned', label: 'Assigned' },
  { id: 'primary', label: 'Primary' },
  { id: 'backup', label: 'Backup' },
  { id: 'call', label: 'Call' },
  { id: 'health', label: 'Health', sort: 'health' },
  { id: 'actions', label: '' },
];

export const DEFAULT_ATM_COLUMNS: AtmColumn[] = ['atmCode', 'name', 'region', 'city', 'registration', 'lastSeen', 'assigned', 'backup', 'call', 'health', 'firmware', 'actions'];

export function ATMDataTable({ page, loading, error, onRetry, columns = DEFAULT_ATM_COLUMNS, sort, onSort, onPage, onOpen, onCall, canCall, selected, onToggle, onToggleAll, extraActions }: {
  page: Page<Atm> | undefined;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  columns?: AtmColumn[];
  sort?: string;
  onSort?: (s: string) => void;
  onPage?: (p: number) => void;
  onOpen?: (a: Atm) => void;
  onCall?: (a: Atm) => void;
  canCall?: (a: Atm) => boolean;
  selected?: Set<string>;
  onToggle?: (id: string) => void;
  onToggleAll?: (ids: string[], on: boolean) => void;
  extraActions?: (a: Atm) => ReactNode;
}) {
  const now = useNow(10_000);
  if (error) return <ErrorState error={error} onRetry={onRetry} />;
  if (loading && !page) return <LoadingSkeleton rows={10} />;
  if (!page?.items.length) return <EmptyState title="No ATMs match these filters" description="Clear a filter or search for a different ATM ID, city or site." />;
  const cols = ALL_ATM_COLUMNS.filter((c) => columns.includes(c.id));
  const allOn = !!selected && page.items.every((a) => selected.has(a.id));
  const pages = Math.max(1, Math.ceil(page.total / page.pageSize));

  const cell = (a: Atm, c: AtmColumn): ReactNode => {
    switch (c) {
      case 'atmCode':
        return <span className="font-mono text-xs">{a.atmCode}</span>;
      case 'name':
        return <span className="block max-w-[220px] truncate" title={a.name}>{a.name}</span>;
      case 'organization':
        return a.organizationName;
      case 'region':
        return a.regionName;
      case 'state':
        return a.state ?? '—';
      case 'city':
        return a.city ?? '—';
      case 'site':
        return <span className="block max-w-[160px] truncate">{a.site ?? '—'}</span>;
      case 'sip':
        return <span className="font-mono text-xs text-muted">{a.sipUsername ?? 'not provisioned'}</span>;
      case 'model':
        return <span className="text-xs text-muted">{a.deviceModel}</span>;
      case 'firmware':
        return <span className="font-mono text-xs">{a.firmwareVersion ?? '—'}</span>;
      case 'registration':
        return <ATMStatusBadge registration={a.registrationStatus} status={a.status} />;
      case 'lastSeen':
        return <span className="num text-xs text-muted" title={a.lastSeenAt ?? ''}>{relativeTime(a.lastSeenAt, now)}</span>;
      case 'assigned':
        return a.overrideOperatorName ? (
          <Tooltip content={`Supervisor override until ${new Date(a.overrideEndsAt!).toLocaleString()}`}>
            <span className="text-warning">{a.overrideOperatorName} ⟲</span>
          </Tooltip>
        ) : (
          a.primaryOperatorName ?? <span className="text-subtle">dynamic</span>
        );
      case 'primary':
        return a.primaryOperatorName ?? '—';
      case 'backup':
        return <span className="text-muted">{a.backupOperatorName ?? '—'}</span>;
      case 'call':
        return a.activeCallState ? (
          <span className="flex items-center gap-1.5"><CallStateBadge state={a.activeCallState} /><span className="hidden text-xs text-muted 2xl:inline">{a.activeCallOperatorName}</span></span>
        ) : a.queueItemId ? (
          <span className="text-xs text-warning">queued {a.queuePriority}</span>
        ) : (
          <span className="text-subtle">—</span>
        );
      case 'health':
        return <HealthBadge health={a.health} />;
      case 'actions':
        return (
          <div className="flex items-center justify-end gap-1">
            {extraActions?.(a)}
            {onCall && (
              <Button
                size="sm"
                variant="success"
                disabled={!canCall?.(a)}
                onClick={(e) => {
                  e.stopPropagation();
                  onCall(a);
                }}
                aria-label={`Call ${a.atmCode}`}
              >
                <Phone /> Call
              </Button>
            )}
          </div>
        );
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-auto">
        <Table>
          <THead>
            <TR className="hover:bg-transparent">
              {selected && (
                <TH className="w-8">
                  <input type="checkbox" aria-label="Select page" checked={allOn} onChange={(e) => onToggleAll?.(page.items.map((a) => a.id), e.target.checked)} className="accent-[hsl(var(--primary))]" />
                </TH>
              )}
              {cols.map((c) => (
                <TH key={c.id} className={c.id === 'actions' ? 'text-right' : ''} aria-sort={sort?.replace('-', '') === c.sort ? (sort?.startsWith('-') ? 'descending' : 'ascending') : undefined}>
                  {c.sort && onSort ? (
                    <button className="inline-flex items-center gap-1 uppercase hover:text-foreground" onClick={() => onSort(sort === c.sort ? `-${c.sort}` : c.sort!)}>
                      {c.label}
                      {sort === c.sort ? <ArrowUp className="size-3" /> : sort === `-${c.sort}` ? <ArrowDown className="size-3" /> : null}
                    </button>
                  ) : (
                    c.label
                  )}
                </TH>
              ))}
            </TR>
          </THead>
          <TBody>
            {page.items.map((a) => (
              <TR
                key={a.id}
                data-selected={selected?.has(a.id)}
                tabIndex={0}
                className={cn('cursor-pointer', a.activeCallId && 'bg-primary/5')}
                onClick={() => onOpen?.(a)}
                onKeyDown={(e) => e.key === 'Enter' && onOpen?.(a)}
              >
                {selected && (
                  <TD onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" aria-label={`Select ${a.atmCode}`} checked={selected.has(a.id)} onChange={() => onToggle?.(a.id)} className="accent-[hsl(var(--primary))]" />
                  </TD>
                )}
                {cols.map((c) => (
                  <TD key={c.id}>{cell(a, c.id)}</TD>
                ))}
              </TR>
            ))}
          </TBody>
        </Table>
      </div>
      <div className="flex items-center justify-between border-t px-3 py-2 text-xs text-muted">
        <span className="num">
          {((page.page - 1) * page.pageSize + 1).toLocaleString()}–{Math.min(page.total, page.page * page.pageSize).toLocaleString()} of {page.total.toLocaleString()}
          {loading && ' · updating…'}
        </span>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon-sm" disabled={page.page <= 1} onClick={() => onPage?.(page.page - 1)} aria-label="Previous page"><ChevronLeft /></Button>
          <span className="num px-1">{page.page} / {pages}</span>
          <Button variant="ghost" size="icon-sm" disabled={page.page >= pages} onClick={() => onPage?.(page.page + 1)} aria-label="Next page"><ChevronRight /></Button>
        </div>
      </div>
    </div>
  );
}
