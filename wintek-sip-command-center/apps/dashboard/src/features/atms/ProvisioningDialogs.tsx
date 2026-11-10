import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileUp } from 'lucide-react';
import { useState } from 'react';
import { CredentialReveal } from '@/components/CredentialReveal';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input, Label, Select, Textarea } from '@/components/ui/input';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { dataService } from '@/services/api';
import type { ImportResult, SipCredential } from '@/types/api';

export function AddAtmDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const regions = useQuery({ queryKey: ['regions'], queryFn: () => dataService.regions() });
  const [f, setF] = useState({ atmCode: '', name: '', regionId: '', city: '', site: '', state: '', vmsCameraRef: '' });
  const [cred, setCred] = useState<SipCredential | null>(null);
  const m = useMutation({
    mutationFn: () => dataService.createAtm({ ...Object.fromEntries(Object.entries(f).filter(([, v]) => v)), provisionSip: true }),
    onSuccess: (r) => { void qc.invalidateQueries({ queryKey: ['atms'] }); onOpenChange(false); setCred(r.credentials); setF({ atmCode: '', name: '', regionId: '', city: '', site: '', state: '', vmsCameraRef: '' }); },
  });
  const field = (k: keyof typeof f, label: string, req = false) => (
    <div className="space-y-1"><Label htmlFor={`atm-${k}`}>{label}{req && ' *'}</Label><Input id={`atm-${k}`} value={f[k]} required={req} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></div>
  );
  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent title="Add ATM" description="Creates the device record and its SIP identity. The password is shown once.">
          <form className="grid grid-cols-2 gap-3" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
            {field('atmCode', 'ATM ID', true)}
            {field('name', 'Name', true)}
            <div className="space-y-1"><Label htmlFor="atm-region">Region *</Label>
              <Select id="atm-region" className="w-full" required value={f.regionId} onChange={(e) => setF({ ...f, regionId: e.target.value })}>
                <option value="">Choose…</option>{regions.data?.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </Select>
            </div>
            {field('state', 'State')}{field('city', 'City')}{field('site', 'Site / location')}{field('vmsCameraRef', 'VMS camera ref')}
            {m.error && <div role="alert" className="col-span-2 text-sm text-danger">{(m.error as Error).message}</div>}
            <div className="col-span-2 flex justify-end gap-2 pt-2"><Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button type="submit" disabled={m.isPending}>Create and provision</Button></div>
          </form>
        </DialogContent>
      </Dialog>
      <CredentialReveal cred={cred} onClose={() => setCred(null)} />
    </>
  );
}

const TEMPLATE = 'atm_code,name,region_code,state,city,site,group_codes,primary_username,backup_username,vms_camera_ref\nATM-NO-90001,Connaught Place Kiosk,NORTH,Delhi,Delhi,Connaught Place,OFFSITE,operator1,,CAM-90001\n';

export function ImportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const [csv, setCsv] = useState('');
  const [result, setResult] = useState<ImportResult | null>(null);
  const run = useMutation({ mutationFn: (dryRun: boolean) => dataService.importAtms(csv, dryRun), onSuccess: (r) => { setResult(r); if (!r.dryRun) void qc.invalidateQueries({ queryKey: ['atms'] }); } });
  const download = () => {
    if (!result) return;
    const rows = result.results.filter((r) => r.credentials).map((r) => `${r.atmCode},${r.credentials!.sipUsername},${r.credentials!.sipPassword}`);
    const blob = new Blob([`atm_code,sip_username,sip_password\n${rows.join('\n')}\n`], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'wintek-provisioning-credentials.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  };
  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) { setResult(null); setCsv(''); } }}>
      <DialogContent title="Import ATMs from CSV" description="Validate first, then import. Existing ATM IDs are updated; new ones get SIP identities." className="w-[min(94vw,820px)]">
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-sm hover:bg-elevated">
              <FileUp className="size-4" /> Choose file
              <input type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => void e.target.files?.[0]?.text().then(setCsv)} />
            </label>
            <Button variant="link" size="sm" onClick={() => setCsv(TEMPLATE)}>Use template</Button>
          </div>
          <Textarea value={csv} onChange={(e) => setCsv(e.target.value)} className="h-40 font-mono text-xs" placeholder="atm_code,name,region_code,…" aria-label="CSV content" />
          {result && (
            <div className="space-y-2">
              <div className="flex gap-2 text-sm"><Badge tone="primary">{result.dryRun ? 'validation' : 'imported'}</Badge><Badge tone="success">{result.created} new</Badge><Badge tone="info">{result.updated} updated</Badge><Badge tone={result.errors ? 'danger' : 'neutral'}>{result.errors} errors</Badge></div>
              <div className="max-h-48 overflow-auto rounded-md border">
                <Table><THead><TR><TH>Line</TH><TH>ATM ID</TH><TH>Result</TH><TH>Detail</TH></TR></THead>
                  <TBody>{result.results.map((r) => <TR key={r.line}><TD className="num">{r.line}</TD><TD className="font-mono text-xs">{r.atmCode}</TD><TD><Badge tone={r.status === 'ERROR' ? 'danger' : 'success'}>{r.status.toLowerCase()}</Badge></TD><TD className="text-xs text-muted">{r.error ?? (r.credentials ? 'credentials issued' : '')}</TD></TR>)}</TBody>
                </Table>
              </div>
              {!result.dryRun && result.results.some((r) => r.credentials) && <Button variant="warning" onClick={download}>Download credentials (once)</Button>}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" disabled={!csv || run.isPending} onClick={() => run.mutate(true)}>Validate</Button>
            <Button disabled={!csv || run.isPending || !result?.dryRun || result.errors === result.total} onClick={() => run.mutate(false)}>Import {result?.dryRun ? `${result.created + result.updated} rows` : ''}</Button>
          </div>
          {run.error && <div role="alert" className="text-sm text-danger">{(run.error as Error).message}</div>}
        </div>
      </DialogContent>
    </Dialog>
  );
}
