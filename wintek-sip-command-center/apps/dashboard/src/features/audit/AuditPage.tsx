import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { PageHeader } from '@/app/AppShell';
import { AuditLogTable } from '@/components/AuditLogTable';
import { Input, Select } from '@/components/ui/input';
import { dataService } from '@/services/api';
import type { AuditFilters } from '@/types/api';

export function AuditPage() {
  const [f, setF] = useState<AuditFilters>({ page: 1, pageSize: 50 });
  const q = useQuery({ queryKey: ['audit', f], queryFn: () => dataService.audit(f), placeholderData: keepPreviousData });
  const set = (k: keyof AuditFilters, v: string) => setF((x) => ({ ...x, [k]: v || undefined, page: 1 }));
  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Audit logs" description="Append-only record of sign-ins, provisioning, assignments, overrides, calls and configuration changes. Secrets are never logged." />
      <div className="flex flex-wrap gap-2 px-6 pb-3">
        <Input className="w-56" placeholder="Action prefix, e.g. call. or auth." onKeyDown={(e) => e.key === 'Enter' && set('action', (e.target as HTMLInputElement).value)} aria-label="Action" />
        <Input className="w-44" placeholder="Actor username" onKeyDown={(e) => e.key === 'Enter' && set('actor', (e.target as HTMLInputElement).value)} aria-label="Actor" />
        <Select aria-label="Outcome" onChange={(e) => set('outcome', e.target.value)}><option value="">Any outcome</option><option>SUCCESS</option><option>FAILURE</option><option>DENIED</option></Select>
        <Input type="datetime-local" aria-label="From" onChange={(e) => set('from', e.target.value ? new Date(e.target.value).toISOString() : '')} className="w-52" />
        <Input type="datetime-local" aria-label="To" onChange={(e) => set('to', e.target.value ? new Date(e.target.value).toISOString() : '')} className="w-52" />
      </div>
      <div className="mx-6 mb-6 min-h-0 flex-1 panel">
        <AuditLogTable page={q.data} loading={q.isFetching} error={q.error} onRetry={() => q.refetch()} onPage={(page) => setF((x) => ({ ...x, page }))} />
      </div>
    </div>
  );
}
