import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { PageHeader } from '@/app/AppShell';
import { PriorityQueuePanel, useQueue } from '@/components/PriorityQueuePanel';
import { PriorityBadge } from '@/components/StatusBadges';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input, Label, Select } from '@/components/ui/input';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { formatDateTime } from '@/lib/utils';
import { dataService } from '@/services/api';
import { useSession } from '@/stores/session';

function NewRequest({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const atms = useQuery({ queryKey: ['atms', 'queue-search', search], queryFn: () => dataService.atms({ q: search, pageSize: 20 }), enabled: open });
  const [atmId, setAtmId] = useState('');
  const [priority, setPriority] = useState<'P1' | 'P2' | 'P3' | 'P4'>('P2');
  const [reason, setReason] = useState('');
  const [ref, setRef] = useState('');
  const m = useMutation({ mutationFn: () => dataService.enqueue({ atmId, priority, reason: reason || undefined, externalRef: ref || undefined }), onSuccess: () => { void qc.invalidateQueries({ queryKey: ['queue'] }); onOpenChange(false); } });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="New call request" description="Routes the request to an eligible operator, who places the call. Never interrupts a call in progress.">
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
          <div className="space-y-1"><Label htmlFor="qr-s">ATM</Label><Input id="qr-s" placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} />
            <Select aria-label="ATM" size={4} className="w-full" value={atmId} onChange={(e) => setAtmId(e.target.value)}>{atms.data?.items.map((a) => <option key={a.id} value={a.id}>{a.atmCode} — {a.name}</option>)}</Select></div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1"><Label htmlFor="qr-p">Priority</Label><Select id="qr-p" className="w-full" value={priority} onChange={(e) => setPriority(e.target.value as 'P1')}><option value="P1">P1 · Critical</option><option value="P2">P2 · High</option><option value="P3">P3 · Normal</option><option value="P4">P4 · Low</option></Select></div>
            <div className="space-y-1"><Label htmlFor="qr-r">External incident ref</Label><Input id="qr-r" value={ref} onChange={(e) => setRef(e.target.value)} placeholder="VMS-2026-…" /></div>
          </div>
          <div className="space-y-1"><Label htmlFor="qr-reason">Reason</Label><Input id="qr-reason" value={reason} onChange={(e) => setReason(e.target.value)} /></div>
          {m.error && <div role="alert" className="text-sm text-danger">{(m.error as Error).message}</div>}
          <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button type="submit" disabled={!atmId || m.isPending}>Queue request</Button></div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function QueuePage() {
  const can = useSession((s) => s.can);
  const all = useQueue(true);
  const [open, setOpen] = useState(false);
  const closed = (all.data ?? []).filter((i) => !['WAITING', 'OFFERED'].includes(i.state));
  return (
    <div className="space-y-4 px-6 pb-24">
      <PageHeader inset={false} title="Call queue" description="Priority order: P1 first, FIFO within a priority; long waits are aged up (never to P1) so low priority requests can't starve." actions={can('queue:manage') && <Button onClick={() => setOpen(true)}><Plus /> New request</Button>} />
      <PriorityQueuePanel items={all.data} />
      <Card>
        <CardHeader><CardTitle>Closed in the last 24 h</CardTitle></CardHeader>
        <Table>
          <THead><TR><TH>ATM</TH><TH>Priority</TH><TH>Outcome</TH><TH>Source</TH><TH>Requested</TH><TH>Closed</TH><TH>Reason</TH></TR></THead>
          <TBody>
            {closed.map((i) => (
              <TR key={i.id}><TD className="font-mono text-xs">{i.atmCode}</TD><TD><PriorityBadge p={i.priority} /></TD>
                <TD><Badge tone={i.state === 'FULFILLED' ? 'success' : i.state === 'EXPIRED' ? 'danger' : 'neutral'}>{i.state.toLowerCase()}</Badge></TD>
                <TD className="text-xs">{i.source.toLowerCase()}</TD><TD className="text-xs">{formatDateTime(i.enqueuedAt)}</TD><TD className="text-xs">{formatDateTime(i.closedAt)}</TD><TD className="text-xs text-muted">{i.closeReason}</TD></TR>
            ))}
          </TBody>
        </Table>
      </Card>
      <NewRequest open={open} onOpenChange={setOpen} />
    </div>
  );
}
