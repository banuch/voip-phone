import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Save, ShieldAlert, Timer, Undo2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input, Label, Select, Textarea } from '@/components/ui/input';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { formatDateTime } from '@/lib/utils';
import { ApiError, dataService } from '@/services/api';
import { useSession } from '@/stores/session';
import type { Assignment, Operator } from '@/types/api';
import { EmptyState, ErrorState, LoadingSkeleton } from './States';

function useOperators() {
  return useQuery({ queryKey: ['operators', 'all'], queryFn: () => dataService.operators({}), staleTime: 30_000 });
}

function Row({ a, ops, canEdit }: { a: Assignment; ops: Operator[]; canEdit: boolean }) {
  const qc = useQueryClient();
  const [p, setP] = useState(a.primaryOperatorId ?? '');
  const [b, setB] = useState(a.backupOperatorId ?? '');
  const dirty = p !== (a.primaryOperatorId ?? '') || b !== (a.backupOperatorId ?? '');
  const save = useMutation({
    mutationFn: () => dataService.setAssignment(a.atmId, { primaryOperatorId: p || null, backupOperatorId: b || null, expectedVersion: a.version }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['assignments'] }),
  });
  const err = save.error as ApiError | null;
  return (
    <TR>
      <TD className="font-mono text-xs">{a.atmCode}</TD>
      <TD className="max-w-[220px] truncate">{a.atmName}</TD>
      <TD className="text-muted">{a.regionName}</TD>
      <TD>
        <Select aria-label={`Primary operator for ${a.atmCode}`} value={p} disabled={!canEdit} onChange={(e) => setP(e.target.value)} className="w-48">
          <option value="">— dynamic —</option>
          {ops.map((o) => <option key={o.id} value={o.id} disabled={o.id === b}>{o.name}</option>)}
        </Select>
      </TD>
      <TD>
        <Select aria-label={`Backup operator for ${a.atmCode}`} value={b} disabled={!canEdit} onChange={(e) => setB(e.target.value)} className="w-48">
          <option value="">— none —</option>
          {ops.map((o) => <option key={o.id} value={o.id} disabled={o.id === p}>{o.name}</option>)}
        </Select>
      </TD>
      <TD className="text-right">
        {err && <span className="mr-2 text-xs text-danger" role="alert">{err.code === 'STALE_VERSION' ? 'Changed by someone else — reload' : err.message}</span>}
        {dirty && (
          <>
            <Button size="icon-sm" variant="ghost" onClick={() => { setP(a.primaryOperatorId ?? ''); setB(a.backupOperatorId ?? ''); }} aria-label="Undo"><Undo2 /></Button>
            <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}><Save /> Save</Button>
          </>
        )}
      </TD>
    </TR>
  );
}

/** Static primary/backup assignments with optimistic-concurrency saves. */
export function AssignmentManager({ filter }: { filter?: string }) {
  const can = useSession((s) => s.can);
  const q = useQuery({ queryKey: ['assignments'], queryFn: () => dataService.assignments({}) });
  const ops = useOperators();
  const rows = useMemo(() => {
    const f = filter?.toLowerCase();
    return (q.data ?? []).filter((a) => !f || a.atmCode.toLowerCase().includes(f) || a.atmName.toLowerCase().includes(f) || a.primaryOperatorName?.toLowerCase().includes(f));
  }, [q.data, filter]);
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (q.isLoading || ops.isLoading) return <LoadingSkeleton rows={10} />;
  if (!rows.length) return <EmptyState title="No assignments match" />;
  const operators = (ops.data?.items ?? []).filter((o) => o.status === 'ACTIVE');
  return (
    <Table>
      <THead><TR><TH>ATM ID</TH><TH>Name</TH><TH>Region</TH><TH>Primary</TH><TH>Backup</TH><TH /></TR></THead>
      <TBody>
        {rows.slice(0, 200).map((a) => <Row key={`${a.atmId}-${a.version}`} a={a} ops={operators} canEdit={can('assignment:manage')} />)}
      </TBody>
    </Table>
  );
}

/** Supervisor temporary override: reason and expiry are mandatory; audited server-side. */
export function OverrideDialog({ open, onOpenChange, atmId: initialAtm }: { open: boolean; onOpenChange: (o: boolean) => void; atmId?: string }) {
  const qc = useQueryClient();
  const ops = useOperators();
  const [atmSearch, setAtmSearch] = useState('');
  const atms = useQuery({ queryKey: ['atms', 'override-search', atmSearch], queryFn: () => dataService.atms({ q: atmSearch, pageSize: 20 }), enabled: open && !initialAtm });
  const [atmId, setAtmId] = useState(initialAtm ?? '');
  const [operatorId, setOperatorId] = useState('');
  const [reason, setReason] = useState('');
  const [hours, setHours] = useState(8);
  const m = useMutation({
    mutationFn: () => dataService.createOverride({ atmId, operatorId, reason, endsAt: new Date(Date.now() + hours * 3_600_000).toISOString() }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['overrides'] });
      void qc.invalidateQueries({ queryKey: ['atms'] });
      onOpenChange(false);
      setReason('');
    },
  });
  const valid = atmId && operatorId && reason.trim().length >= 5 && hours > 0 && hours <= 168;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Temporary assignment override" description="Routes this ATM to another operator until the override expires. Replaces the primary operator while active.">
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (valid) m.mutate(); }}>
          {!initialAtm && (
            <div className="space-y-1">
              <Label htmlFor="ov-atm">ATM</Label>
              <Input id="ov-atm" placeholder="Search ATM ID or site…" value={atmSearch} onChange={(e) => setAtmSearch(e.target.value)} />
              <Select aria-label="ATM" className="w-full" value={atmId} onChange={(e) => setAtmId(e.target.value)} size={4}>
                {atms.data?.items.map((a) => <option key={a.id} value={a.id}>{a.atmCode} — {a.name}</option>)}
              </Select>
            </div>
          )}
          <div className="space-y-1">
            <Label htmlFor="ov-op">Operator</Label>
            <Select id="ov-op" className="w-full" value={operatorId} onChange={(e) => setOperatorId(e.target.value)} required>
              <option value="">Choose operator…</option>
              {ops.data?.items.filter((o) => o.status === 'ACTIVE').map((o) => <option key={o.id} value={o.id}>{o.name} — {o.availability.toLowerCase()}</option>)}
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="ov-reason">Reason (required, audited)</Label>
            <Textarea id="ov-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Primary operator on leave; incident follow-up" minLength={5} required />
          </div>
          <div className="space-y-1">
            <Label htmlFor="ov-hours"><Timer className="mr-1 inline size-3" />Duration (hours, max 168)</Label>
            <Input id="ov-hours" type="number" min={1} max={168} value={hours} onChange={(e) => setHours(Number(e.target.value))} className="w-32" />
            <div className="text-xs text-subtle">Expires {formatDateTime(new Date(Date.now() + hours * 3_600_000).toISOString())}</div>
          </div>
          {m.error && <div role="alert" className="flex items-center gap-2 text-sm text-danger"><ShieldAlert className="size-4" />{(m.error as Error).message}</div>}
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={!valid || m.isPending}>Apply override</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function OverridesList() {
  const qc = useQueryClient();
  const can = useSession((s) => s.can);
  const q = useQuery({ queryKey: ['overrides'], queryFn: () => dataService.overrides(true), refetchInterval: 30_000 });
  const revoke = useMutation({ mutationFn: (id: string) => dataService.revokeOverride(id), onSettled: () => { void qc.invalidateQueries({ queryKey: ['overrides'] }); void qc.invalidateQueries({ queryKey: ['atms'] }); } });
  if (q.isLoading) return <LoadingSkeleton rows={3} />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data?.length) return <EmptyState title="No active overrides" description="Static assignments are in effect for every ATM." />;
  return (
    <Table>
      <THead><TR><TH>ATM</TH><TH>Operator</TH><TH>Reason</TH><TH>By</TH><TH>Until</TH><TH /></TR></THead>
      <TBody>
        {q.data.map((o) => (
          <TR key={o.id}>
            <TD><span className="font-mono text-xs">{o.atmCode}</span> <span className="text-muted">{o.atmName}</span></TD>
            <TD>{o.operatorName} {o.active && <Badge tone="warning">active</Badge>}</TD>
            <TD className="max-w-xs truncate text-muted" title={o.reason}>{o.reason}</TD>
            <TD className="text-muted">{o.createdByName}</TD>
            <TD className="text-xs">{formatDateTime(o.endsAt)}</TD>
            <TD className="text-right">{can('assignment:override') && <Button size="sm" variant="outline" onClick={() => revoke.mutate(o.id)}>Revoke</Button>}</TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}
