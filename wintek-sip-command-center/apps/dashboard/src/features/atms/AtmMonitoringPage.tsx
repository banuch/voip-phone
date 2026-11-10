import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Columns3, Plus, RotateCcw, Upload } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PageHeader } from '@/app/AppShell';
import { ALL_ATM_COLUMNS, ATMDataTable, DEFAULT_ATM_COLUMNS, type AtmColumn } from '@/components/ATMDataTable';
import { DeviceDetailDrawer } from '@/components/DeviceDetailDrawer';
import { GroupFilter, RegionFilter } from '@/components/RegionFilter';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/misc';
import { dataService } from '@/services/api';
import { useConsole } from '@/stores/console';
import { useSession } from '@/stores/session';
import type { Atm, AtmFilters } from '@/types/api';
import { AddAtmDialog, ImportDialog } from './ProvisioningDialogs';

export function AtmMonitoringPage() {
  const [params, setParams] = useSearchParams();
  const can = useSession((s) => s.can);
  const qc = useQueryClient();
  const { placeCall, call, effective } = useConsole();
  const filters: AtmFilters = useMemo(() => ({
    q: params.get('q') ?? undefined,
    regionId: params.get('region') ?? undefined,
    groupId: params.get('group') ?? undefined,
    registration: (params.get('registration') as AtmFilters['registration']) ?? undefined,
    health: (params.get('health') as AtmFilters['health']) ?? undefined,
    status: params.get('status') ?? undefined,
    mine: params.get('mine') === '1' || undefined,
    sort: params.get('sort') ?? 'atmCode',
    page: Number(params.get('page') ?? 1),
    pageSize: 50,
  }), [params]);
  const set = (k: string, v: string | undefined) => {
    const p = new URLSearchParams(params);
    if (v) p.set(k, v);
    else p.delete(k);
    if (k !== 'page') p.delete('page');
    setParams(p, { replace: true });
  };
  const q = useQuery({ queryKey: ['atms', filters], queryFn: () => dataService.atms(filters), placeholderData: keepPreviousData, refetchInterval: 30_000 });
  const [open, setOpen] = useState<string | null>(null);
  const [selected, setSelected] = useState(new Set<string>());
  const [cols, setCols] = useState<AtmColumn[]>(() => { try { return JSON.parse(localStorage.getItem('wintek.atmCols') ?? '') } catch { return DEFAULT_ATM_COLUMNS; } });
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const bulk = useMutation({ mutationFn: (action: string) => dataService.bulkAtms({ atmIds: [...selected], action }), onSuccess: () => { setSelected(new Set()); void qc.invalidateQueries({ queryKey: ['atms'] }); } });
  const canCall = (a: Atm) => can('call:initiate') && a.status === 'ACTIVE' && a.registrationStatus === 'REGISTERED' && !a.activeCallId && effective === 'AVAILABLE' && !call;
  const toggleCol = (c: AtmColumn) => {
    const next = cols.includes(c) ? cols.filter((x) => x !== c) : ALL_ATM_COLUMNS.map((x) => x.id).filter((x) => x === c || cols.includes(x));
    setCols(next);
    try { localStorage.setItem('wintek.atmCols', JSON.stringify(next)); } catch { /* ignore */ }
  };

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="ATM monitoring"
        description="Inventory, SIP registration and live call status for every intercom."
        actions={can('atm:manage') && (
          <>
            <Button variant="secondary" onClick={() => setImporting(true)}><Upload /> Import CSV</Button>
            <Button onClick={() => setAdding(true)}><Plus /> Add ATM</Button>
          </>
        )}
      />
      <div className="flex flex-wrap items-center gap-2 px-6 pb-3">
        <Input className="w-64" placeholder="Search ATM ID, name, city, SIP user" defaultValue={filters.q} onKeyDown={(e) => e.key === 'Enter' && set('q', (e.target as HTMLInputElement).value || undefined)} aria-label="Search ATMs" />
        <RegionFilter value={filters.regionId} onChange={(v) => set('region', v)} />
        <GroupFilter value={filters.groupId} onChange={(v) => set('group', v)} />
        <Select aria-label="Registration" value={filters.registration ?? ''} onChange={(e) => set('registration', e.target.value || undefined)}>
          <option value="">Any registration</option><option value="REGISTERED">Online</option><option value="UNREGISTERED">Offline</option><option value="EXPIRED">Expired</option><option value="UNKNOWN">Unknown</option>
        </Select>
        <Select aria-label="Health" value={filters.health ?? ''} onChange={(e) => set('health', e.target.value || undefined)}>
          <option value="">Any health</option><option value="OK">Healthy</option><option value="DEGRADED">Degraded</option><option value="FAULT">Fault</option>
        </Select>
        <Select aria-label="Status" value={filters.status ?? ''} onChange={(e) => set('status', e.target.value || undefined)}>
          <option value="">Any status</option><option value="ACTIVE">Active</option><option value="MAINTENANCE">Maintenance</option><option value="DISABLED">Disabled</option>
        </Select>
        {can('call:initiate') && (
          <label className="flex items-center gap-2 text-sm text-muted"><input type="checkbox" checked={!!filters.mine} onChange={(e) => set('mine', e.target.checked ? '1' : undefined)} className="accent-[hsl(var(--primary))]" /> My ATMs</label>
        )}
        <Button variant="ghost" size="sm" onClick={() => setParams({}, { replace: true })}><RotateCcw /> Reset</Button>
        <div className="ml-auto flex items-center gap-2">
          {selected.size > 0 && can('atm:manage') && (
            <>
              <span className="text-sm text-muted">{selected.size} selected</span>
              <Button size="sm" variant="secondary" onClick={() => bulk.mutate('MAINTENANCE')}>Maintenance</Button>
              <Button size="sm" variant="secondary" onClick={() => bulk.mutate('ENABLE')}>Enable</Button>
              <Button size="sm" variant="danger" onClick={() => bulk.mutate('DISABLE')}>Disable</Button>
            </>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button variant="ghost" size="sm"><Columns3 /> Columns</Button></DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-96 overflow-y-auto">
              <DropdownMenuLabel>Visible columns</DropdownMenuLabel>
              {ALL_ATM_COLUMNS.filter((c) => c.id !== 'actions').map((c) => (
                <label key={c.id} className="flex items-center gap-2 px-2 py-1 text-sm"><input type="checkbox" checked={cols.includes(c.id)} onChange={() => toggleCol(c.id)} />{c.label}</label>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <div className="mx-6 mb-6 min-h-0 flex-1 panel">
        <ATMDataTable
          page={q.data}
          loading={q.isFetching}
          error={q.error}
          onRetry={() => q.refetch()}
          columns={cols}
          sort={filters.sort}
          onSort={(s) => set('sort', s)}
          onPage={(p) => set('page', String(p))}
          onOpen={(a) => setOpen(a.id)}
          onCall={can('call:initiate') ? (a) => void placeCall(a.id) : undefined}
          canCall={canCall}
          selected={can('atm:manage') ? selected : undefined}
          onToggle={(id) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; })}
          onToggleAll={(ids, on) => setSelected((s) => { const n = new Set(s); ids.forEach((i) => (on ? n.add(i) : n.delete(i))); return n; })}
        />
      </div>
      <DeviceDetailDrawer atmId={open} onClose={() => setOpen(null)} />
      <AddAtmDialog open={adding} onOpenChange={setAdding} />
      <ImportDialog open={importing} onOpenChange={setImporting} />
    </div>
  );
}
