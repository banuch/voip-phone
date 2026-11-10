import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ROLE_LABEL, type Role } from '@wintek/shared';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { PageHeader } from '@/app/AppShell';
import { EmptyState, ErrorState, LoadingSkeleton } from '@/components/States';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input, Label } from '@/components/ui/input';
import { Switch, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/misc';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { relativeTime } from '@/lib/utils';
import { dataService } from '@/services/api';
import { useSession } from '@/stores/session';

function Q<T>({ q, children }: { q: { isLoading: boolean; error: unknown; data?: T; refetch: () => unknown }; children: (d: T) => React.ReactNode }) {
  if (q.isLoading) return <LoadingSkeleton rows={5} />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  return <>{q.data !== undefined && children(q.data)}</>;
}

function NewUser({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ username: '', displayName: '', email: '', password: '', role: 'AUDITOR' as Role });
  const m = useMutation({ mutationFn: () => dataService.createUser({ username: f.username, displayName: f.displayName, email: f.email || undefined, password: f.password, roles: [f.role] }), onSuccess: () => { void qc.invalidateQueries({ queryKey: ['users'] }); onOpenChange(false); } });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="New user" description="Operators and supervisors with a softphone are created under Operators. You can only grant roles whose permissions you hold.">
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
          {(['username', 'displayName', 'email'] as const).map((k) => <div key={k} className="space-y-1"><Label htmlFor={`nu-${k}`}>{k}</Label><Input id={`nu-${k}`} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} required={k !== 'email'} /></div>)}
          <div className="space-y-1"><Label htmlFor="nu-p">Initial password (12+ chars, mixed)</Label><Input id="nu-p" type="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required /></div>
          <div className="space-y-1"><Label htmlFor="nu-r">Role</Label>
            <select id="nu-r" className="h-9 w-full rounded-md border bg-surface px-2 text-sm" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as Role })}>{(['ORG_ADMIN', 'SUPERVISOR', 'OPERATOR', 'AUDITOR'] as Role[]).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</select></div>
          {m.error && <div role="alert" className="text-sm text-danger">{(m.error as Error).message}</div>}
          <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button type="submit" disabled={m.isPending}>Create user</Button></div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CodeNameForm({ kind }: { kind: 'region' | 'group' }) {
  const qc = useQueryClient();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const m = useMutation({ mutationFn: () => (kind === 'region' ? dataService.createRegion({ code, name }) : dataService.createGroup({ code, name })), onSuccess: () => { setCode(''); setName(''); void qc.invalidateQueries({ queryKey: [kind === 'region' ? 'regions' : 'groups'] }); } });
  return (
    <form className="flex gap-2 p-3" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
      <Input className="w-32" placeholder="CODE" value={code} onChange={(e) => setCode(e.target.value)} required aria-label={`${kind} code`} />
      <Input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} required aria-label={`${kind} name`} />
      <Button type="submit" size="sm" disabled={m.isPending}><Plus /> Add</Button>
      {m.error && <span className="text-xs text-danger">{(m.error as Error).message}</span>}
    </form>
  );
}

export function AdminPage() {
  const can = useSession((s) => s.can);
  const qc = useQueryClient();
  const orgs = useQuery({ queryKey: ['orgs'], queryFn: () => dataService.organizations() });
  const users = useQuery({ queryKey: ['users'], queryFn: () => dataService.users() });
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => dataService.roles() });
  const regions = useQuery({ queryKey: ['regions'], queryFn: () => dataService.regions() });
  const groups = useQuery({ queryKey: ['groups'], queryFn: () => dataService.groups() });
  const policies = useQuery({ queryKey: ['policies'], queryFn: () => dataService.routingPolicies(), enabled: can('assignment:read') });
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => dataService.settings(), enabled: can('system:read') });
  const savePolicy = useMutation({ mutationFn: (b: Record<string, unknown>) => dataService.saveRoutingPolicy(b), onSettled: () => qc.invalidateQueries({ queryKey: ['policies'] }) });
  const toggleUser = useMutation({ mutationFn: ({ id, status }: { id: string; status: string }) => dataService.updateUser(id, { status }), onSettled: () => qc.invalidateQueries({ queryKey: ['users'] }) });
  const [newUser, setNewUser] = useState(false);

  return (
    <div className="px-6 pb-24">
      <PageHeader inset={false} title="Administration" description="Every change here is validated server-side and written to the audit log." />
      <Tabs defaultValue="users">
        <TabsList className="flex-wrap">
          {['organizations', 'users', 'roles', 'regions', 'routing', 'sip', 'provisioning'].map((t) => <TabsTrigger key={t} value={t} className="capitalize">{t === 'sip' ? 'SIP infrastructure' : t === 'regions' ? 'Regions & groups' : t}</TabsTrigger>)}
        </TabsList>
        <TabsContent value="organizations">
          <Card><Q q={orgs}>{(d) => (
            <Table><THead><TR><TH>Code</TH><TH>Name</TH><TH>Time zone</TH><TH>Status</TH><TH className="text-right">ATMs</TH><TH className="text-right">Operators</TH></TR></THead>
              <TBody>{d.map((o) => <TR key={o.id}><TD className="font-mono text-xs">{o.code}</TD><TD>{o.name}</TD><TD>{o.timezone}</TD><TD><Badge tone={o.status === 'ACTIVE' ? 'success' : 'warning'}>{o.status.toLowerCase()}</Badge></TD><TD className="num text-right">{o.atmCount.toLocaleString()}</TD><TD className="num text-right">{o.operatorCount}</TD></TR>)}</TBody></Table>
          )}</Q></Card>
        </TabsContent>
        <TabsContent value="users">
          <Card>
            <CardHeader><CardTitle>Users</CardTitle>{can('user:manage') && <Button size="sm" onClick={() => setNewUser(true)}><Plus /> New user</Button>}</CardHeader>
            <Q q={users}>{(d) => (
              <Table><THead><TR><TH>Name</TH><TH>Username</TH><TH>Roles</TH><TH>Status</TH><TH>Last login</TH><TH /></TR></THead>
                <TBody>{d.map((u) => (
                  <TR key={u.id}><TD>{u.displayName}</TD><TD className="font-mono text-xs">{u.username}</TD><TD>{u.roles.map((r) => <Badge key={r} className="mr-1">{ROLE_LABEL[r]}</Badge>)}</TD>
                    <TD><Badge tone={u.status === 'ACTIVE' ? 'success' : 'danger'}>{u.status.toLowerCase()}</Badge></TD><TD className="text-xs">{relativeTime(u.lastLoginAt)}</TD>
                    <TD className="text-right">{can('user:manage') && <Button size="sm" variant="ghost" onClick={() => toggleUser.mutate({ id: u.id, status: u.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE' })}>{u.status === 'ACTIVE' ? 'Disable' : 'Enable'}</Button>}</TD></TR>
                ))}</TBody></Table>
            )}</Q>
          </Card>
          <NewUser open={newUser} onOpenChange={setNewUser} />
        </TabsContent>
        <TabsContent value="roles">
          <Q q={roles}>{(d) => (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{d.map((r) => (
              <Card key={r.code}><CardHeader><CardTitle>{r.name}</CardTitle><span className="font-mono text-xs text-muted">{r.code}</span></CardHeader>
                <CardContent className="flex flex-wrap gap-1">{r.permissions.map((p) => <Badge key={p} tone="neutral" className="normal-case">{p}</Badge>)}</CardContent></Card>
            ))}</div>
          )}</Q>
        </TabsContent>
        <TabsContent value="regions" className="grid gap-4 lg:grid-cols-2">
          {([['Regions', regions, 'region'], ['ATM groups', groups, 'group']] as const).map(([title, q, kind]) => (
            <Card key={kind}><CardHeader><CardTitle>{title}</CardTitle></CardHeader>
              {can('atm:manage') && <CodeNameForm kind={kind} />}
              <Q q={q}>{(d) => d.length ? (
                <Table><THead><TR><TH>Code</TH><TH>Name</TH><TH className="text-right">ATMs</TH></TR></THead><TBody>{d.map((x) => <TR key={x.id}><TD className="font-mono text-xs">{x.code}</TD><TD>{x.name}</TD><TD className="num text-right">{x.atmCount.toLocaleString()}</TD></TR>)}</TBody></Table>
              ) : <EmptyState title={`No ${title.toLowerCase()}`} />}</Q>
            </Card>
          ))}
        </TabsContent>
        <TabsContent value="routing">
          <Q q={policies}>{(d) => (
            <div className="space-y-3">{d.map((p: any) => (
              <Card key={p.id}>
                <CardHeader><CardTitle>{p.scope} policy</CardTitle><Badge tone="neutral">active-call preemption: off (V1.1)</Badge></CardHeader>
                <CardContent className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  {([['allowDynamic', 'Dynamic pool fallback'], ['requireActiveShift', 'Require active shift'], ['sameRegionOnly', 'Same region only'], ['preferGroupMatch', 'Prefer ATM-group match'], ['allowQueueWhenBusy', 'Queue requests for busy ATMs']] as const).map(([k, label]) => (
                    <label key={k} className="flex items-center justify-between gap-3 rounded-md border bg-surface px-3 py-2 text-sm">{label}
                      <Switch checked={!!p[k]} disabled={!can('routing:manage')} onCheckedChange={(v) => savePolicy.mutate({ ...p, [k]: v })} aria-label={label} /></label>
                  ))}
                  <div className="rounded-md border bg-surface px-3 py-2 text-sm">Queue timeout: <span className="num font-medium">{p.queueTimeoutSeconds}s</span></div>
                </CardContent>
              </Card>
            ))}</div>
          )}</Q>
        </TabsContent>
        <TabsContent value="sip">
          <Card>
            <CardHeader><CardTitle>SIP infrastructure</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm">
              {settings.data && <div className="grid gap-3 sm:grid-cols-2">{Object.entries(settings.data.deployment).map(([k, v]) => <div key={k}><div className="text-[11px] uppercase tracking-wider text-subtle">{k}</div><div className="font-mono">{v}</div></div>)}</div>}
              <p className="text-muted">Registrar authority, media nodes and transports are configured in the infrastructure layer (Kamailio / Asterisk configuration, see <span className="font-mono">infra/</span> and <span className="font-mono">docs/architecture.md</span>). This page shows the live deployment facts the API is using.</p>
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="provisioning">
          <Card><CardContent className="space-y-2 p-5 text-sm">
            <p>Devices are provisioned from <Link className="text-primary hover:underline" to="/atms">ATM Monitoring</Link> (single device or CSV import). Each provisioning issues a SIP password once; only its digest hash is stored.</p>
            <p className="text-muted">Install the credentials in the intercom with the Wintek setup app over Bluetooth (Server, Extension, Password). Rotating credentials invalidates the old password at the next registration refresh.</p>
          </CardContent></Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
