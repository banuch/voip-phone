import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Fragment, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { formatDateTime } from '@/lib/utils';
import type { AuditEntry, Page } from '@/types/api';
import { EmptyState, ErrorState, LoadingSkeleton } from './States';

const outcomeTone = { SUCCESS: 'success', FAILURE: 'warning', DENIED: 'danger' } as const;

export function AuditLogTable({ page, loading, error, onRetry, onPage }: { page?: Page<AuditEntry>; loading?: boolean; error?: unknown; onRetry?: () => void; onPage: (p: number) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  if (error) return <ErrorState error={error} onRetry={onRetry} />;
  if (loading && !page) return <LoadingSkeleton rows={12} />;
  if (!page?.items.length) return <EmptyState title="No audit records match" />;
  const pages = Math.max(1, Math.ceil(page.total / page.pageSize));
  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-auto">
        <Table>
          <THead>
            <TR>
              <TH>Time</TH><TH>Actor</TH><TH>Action</TH><TH>Outcome</TH><TH>Entity</TH><TH>IP</TH><TH>Correlation</TH>
            </TR>
          </THead>
          <TBody>
            {page.items.map((e) => (
              <Fragment key={e.id}>
                <TR className="cursor-pointer" onClick={() => setOpen(open === e.id ? null : e.id)} aria-expanded={open === e.id}>
                  <TD className="whitespace-nowrap text-xs">{formatDateTime(e.occurredAt)}</TD>
                  <TD>{e.actorUsername ?? <span className="text-subtle">system</span>}</TD>
                  <TD className="font-mono text-xs">{e.action}</TD>
                  <TD><Badge tone={outcomeTone[e.outcome]}>{e.outcome.toLowerCase()}</Badge></TD>
                  <TD className="text-xs text-muted">{e.entityType} <span className="font-mono">{e.entityId?.slice(0, 13)}</span></TD>
                  <TD className="font-mono text-xs text-muted">{e.ip ?? '—'}</TD>
                  <TD className="font-mono text-[11px] text-subtle">{e.correlationId?.slice(0, 8) ?? '—'}</TD>
                </TR>
                {open === e.id && (
                  <TR className="bg-surface hover:bg-surface">
                    <TD colSpan={7}>
                      <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-background p-3 font-mono text-xs text-muted">{JSON.stringify({ ...e.detail, entityId: e.entityId, correlationId: e.correlationId }, null, 2)}</pre>
                    </TD>
                  </TR>
                )}
              </Fragment>
            ))}
          </TBody>
        </Table>
      </div>
      <div className="flex items-center justify-between border-t px-3 py-2 text-xs text-muted">
        <span className="num">{page.total.toLocaleString()} records</span>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon-sm" disabled={page.page <= 1} onClick={() => onPage(page.page - 1)} aria-label="Previous page"><ChevronLeft /></Button>
          <span className="num px-1">{page.page} / {pages}</span>
          <Button variant="ghost" size="icon-sm" disabled={page.page >= pages} onClick={() => onPage(page.page + 1)} aria-label="Next page"><ChevronRight /></Button>
        </div>
      </div>
    </div>
  );
}
