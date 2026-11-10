import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, KeyRound, Phone, Route, Wrench } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Sheet } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/misc';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { useNow } from '@/hooks/useNow';
import { formatDateTime, formatDuration, relativeTime } from '@/lib/utils';
import { dataService } from '@/services/api';
import { useConsole } from '@/stores/console';
import { useSession } from '@/stores/session';
import type { SipCredential } from '@/types/api';
import { ConfirmationDialog } from './ConfirmationDialog';
import { CredentialReveal } from './CredentialReveal';
import { ATMStatusBadge, CallStateBadge, HealthBadge } from './StatusBadges';
import { EmptyState, ErrorState, LoadingSkeleton } from './States';

const Field = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="space-y-0.5">
    <div className="text-[11px] uppercase tracking-wider text-subtle">{label}</div>
    <div className="text-sm">{children ?? '—'}</div>
  </div>
);

export function DeviceDetailDrawer({ atmId, onClose }: { atmId: string | null; onClose: () => void }) {
  const qc = useQueryClient();
  const now = useNow(5000);
  const can = useSession((s) => s.can);
  const { placeCall, call, effective } = useConsole();
  const q = useQuery({ queryKey: ['atm', atmId], queryFn: () => dataService.atm(atmId!), enabled: !!atmId, refetchInterval: 15_000 });
  const trace = useQuery({ queryKey: ['resolve', atmId], queryFn: () => dataService.resolve(atmId!), enabled: !!atmId && can('assignment:read') });
  const [cred, setCred] = useState<SipCredential | null>(null);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const rotate = useMutation({ mutationFn: () => dataService.rotateCredentials(atmId!), onSuccess: (r) => setCred(r.credentials) });
  const setStatus = useMutation({ mutationFn: (status: string) => dataService.updateAtm(atmId!, { status }), onSuccess: () => qc.invalidateQueries({ queryKey: ['atm'] }) });
  const a = q.data;
  const callable = !!a && a.status === 'ACTIVE' && a.registrationStatus === 'REGISTERED' && !a.activeCallId && can('call:initiate') && effective === 'AVAILABLE' && !call;

  return (
    <Sheet
      open={!!atmId}
      onOpenChange={(o) => !o && onClose()}
      title={a ? `${a.atmCode} · ${a.name}` : 'ATM'}
      description={a && <span className="flex items-center gap-2"><ATMStatusBadge registration={a.registrationStatus} status={a.status} inCall={!!a.activeCallId} /><HealthBadge health={a.health} /><span>{a.regionName} · {a.city}</span></span>}
    >
      {q.isLoading ? (
        <LoadingSkeleton rows={8} />
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : a ? (
        <div className="space-y-5 p-5">
          <div className="flex flex-wrap gap-2">
            {can('call:initiate') && (
              <Button variant="success" disabled={!callable} onClick={() => void placeCall(a.id)} title={callable ? 'Call this ATM' : 'Unavailable: check ATM and your status'}>
                <Phone /> Call ATM
              </Button>
            )}
            {a.vmsLink && (
              <Button variant="secondary" asChild>
                <a href={a.vmsLink} target="_blank" rel="noopener noreferrer"><ExternalLink /> Open camera (VMS)</a>
              </Button>
            )}
            {can('atm:credentials') && (
              <Button variant="outline" onClick={() => setConfirmRotate(true)}><KeyRound /> Rotate SIP credentials</Button>
            )}
            {can('atm:manage') && (
              <Button variant="ghost" onClick={() => setStatus.mutate(a.status === 'MAINTENANCE' ? 'ACTIVE' : 'MAINTENANCE')}>
                <Wrench /> {a.status === 'MAINTENANCE' ? 'End maintenance' : 'Set maintenance'}
              </Button>
            )}
          </div>

          <Tabs defaultValue="overview">
            <TabsList>
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="assign">Assignment</TabsTrigger>
              <TabsTrigger value="calls">Calls ({a.recentCalls.length})</TabsTrigger>
              <TabsTrigger value="events">Events {a.faults.length ? <Badge tone="danger" className="ml-1">{a.faults.length}</Badge> : null}</TabsTrigger>
            </TabsList>

            <TabsContent value="overview" className="grid grid-cols-2 gap-x-6 gap-y-4">
              <Field label="ATM ID"><span className="font-mono">{a.atmCode}</span></Field>
              <Field label="Customer">{a.organizationName}</Field>
              <Field label="Site">{a.site}</Field>
              <Field label="City / state">{[a.city, a.state].filter(Boolean).join(', ')}</Field>
              <Field label="Device model">{a.deviceModel}</Field>
              <Field label="Firmware"><span className="font-mono">{a.firmwareVersion}</span></Field>
              <Field label="SIP identity"><span className="font-mono">{a.sip.username ?? 'not provisioned'}@{a.sip.domain}</span></Field>
              <Field label="Credential version">v{a.sip.credentialVersion ?? '—'} {a.credentialsRotatedAt && <span className="text-xs text-muted">· rotated {relativeTime(a.credentialsRotatedAt, now)}</span>}</Field>
              <Field label="Registration"><ATMStatusBadge registration={a.registrationStatus} status={a.status} /></Field>
              <Field label="Last registered">{formatDateTime(a.lastRegisteredAt)}</Field>
              <Field label="Last seen">{relativeTime(a.lastSeenAt, now)}</Field>
              <Field label="Contact">{a.contactIp ? <span className="font-mono">{a.contactIp}{a.contactPort ? `:${a.contactPort}` : ''}</span> : '—'}</Field>
              <Field label="User agent"><span className="text-xs">{a.userAgent}</span></Field>
              <Field label="Camera mapping">{a.vmsCameraRef}</Field>
              <Field label="Groups">{a.groups.map((g) => g.name).join(', ')}</Field>
              <Field label="Active call">{a.activeCallState ? <CallStateBadge state={a.activeCallState} /> : 'None'}</Field>
            </TabsContent>

            <TabsContent value="assign" className="space-y-4">
              <div className="grid grid-cols-3 gap-4">
                <Field label="Primary">{a.primaryOperatorName}</Field>
                <Field label="Backup">{a.backupOperatorName}</Field>
                <Field label="Override">{a.overrideOperatorName ? <span className="text-warning">{a.overrideOperatorName} until {formatDateTime(a.overrideEndsAt)}</span> : 'None'}</Field>
              </div>
              {trace.data && (
                <div className="panel">
                  <div className="flex items-center gap-2 border-b px-3 py-2 text-sm font-medium"><Route className="size-4 text-primary" /> Routing right now: <Badge tone={trace.data.kind === 'ESCALATE' ? 'danger' : 'success'}>{trace.data.kind}</Badge></div>
                  <ol className="divide-y text-sm">
                    {trace.data.trace.map((t, i) => (
                      <li key={i} className="flex items-center gap-3 px-3 py-2">
                        <span className="w-20 text-xs font-semibold text-muted">{t.step}</span>
                        <Badge tone={t.outcome === 'SELECTED' ? 'success' : t.outcome === 'SKIPPED' ? 'warning' : 'neutral'}>{t.outcome.replace('_', ' ').toLowerCase()}</Badge>
                        <span className="text-muted">{t.reason}</span>
                      </li>
                    ))}
                  </ol>
                  <div className="px-3 py-2 text-[11px] text-subtle">Policy: {trace.data.policySource}</div>
                </div>
              )}
            </TabsContent>

            <TabsContent value="calls">
              {a.recentCalls.length ? (
                <Table>
                  <THead><TR><TH>When</TH><TH>Operator</TH><TH>Result</TH><TH>Duration</TH><TH>SIP</TH></TR></THead>
                  <TBody>
                    {a.recentCalls.map((c) => (
                      <TR key={c.id}>
                        <TD className="text-xs">{formatDateTime(c.requestedAt)}</TD>
                        <TD>{c.operatorName}</TD>
                        <TD><CallStateBadge state={c.state} /></TD>
                        <TD className="num">{formatDuration(c.durationMs)}</TD>
                        <TD className="font-mono text-xs text-muted" title={c.failureReason ?? ''}>{c.sipCode ?? '—'}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              ) : (
                <EmptyState title="No calls yet" />
              )}
            </TabsContent>

            <TabsContent value="events">
              {a.deviceEvents.length ? (
                <ol className="space-y-1">
                  {a.deviceEvents.map((e) => (
                    <li key={e.id} className="flex items-center gap-3 rounded-md px-2 py-1.5 text-sm hover:bg-elevated/50">
                      <Badge tone={e.severity === 'critical' ? 'danger' : e.severity === 'warning' ? 'warning' : 'neutral'}>{e.type.toLowerCase().replace('_', ' ')}</Badge>
                      <span className="flex-1 truncate text-xs text-muted">{e.detail ? Object.entries(e.detail).map(([k, v]) => `${k}: ${v}`).join(' · ') : ''}</span>
                      <span className="text-xs text-subtle">{relativeTime(e.occurredAt, now)}</span>
                    </li>
                  ))}
                </ol>
              ) : (
                <EmptyState title="No device events" />
              )}
            </TabsContent>
          </Tabs>
        </div>
      ) : null}
      <ConfirmationDialog
        open={confirmRotate}
        onOpenChange={setConfirmRotate}
        title="Rotate SIP credentials?"
        description="A new password is issued. The intercom stops registering with the old password at its next refresh until it is re-provisioned."
        confirmLabel="Rotate credentials"
        tone="warning"
        onConfirm={() => rotate.mutateAsync()}
      />
      <CredentialReveal cred={cred} onClose={() => setCred(null)} />
    </Sheet>
  );
}
