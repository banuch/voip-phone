import { ACTIVE_CALL_STATES } from '@wintek/shared';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ExternalLink, Minimize2, Phone, Signal, X } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useNow } from '@/hooks/useNow';
import { cn, formatDuration } from '@/lib/utils';
import { dataService } from '@/services/api';
import { useConsole } from '@/stores/console';
import { useSession } from '@/stores/session';
import { callErrorText } from '@/utils/status';
import { CallControlBar } from './CallControlBar';
import { ConfirmationDialog } from './ConfirmationDialog';
import { ATMStatusBadge, CallStateBadge, PriorityBadge } from './StatusBadges';

const STEPS = ['RESERVED', 'DIALING', 'RINGING', 'CONNECTED'] as const;

function QualityMeter() {
  const q = useConsole((s) => s.quality);
  const media = useConsole((s) => s.media);
  if (!q) return <span className="text-xs text-subtle">{media === 'established' ? 'measuring…' : 'audio idle'}</span>;
  const bars = q.score >= 4.2 ? 4 : q.score >= 3.6 ? 3 : q.score >= 3 ? 2 : 1;
  const tone = bars >= 3 ? 'bg-success' : bars === 2 ? 'bg-warning' : 'bg-danger';
  return (
    <span className="flex items-center gap-2 text-xs text-muted" title={`MOS ${q.score} · loss ${q.packetLossPct}% · jitter ${q.jitterMs} ms · RTT ${q.rttMs ?? '—'} ms · ${q.codec ?? ''}`}>
      <span className="flex items-end gap-0.5" aria-label={`audio quality ${bars} of 4`}>
        {[1, 2, 3, 4].map((b) => (
          <span key={b} className={cn('w-1 rounded-sm', b <= bars ? tone : 'bg-elevated')} style={{ height: 4 + b * 3 }} />
        ))}
      </span>
      MOS {q.score.toFixed(1)} · {q.packetLossPct}% loss · {q.jitterMs} ms jitter
    </span>
  );
}

/**
 * The operator's current call. Rendered by the app shell, so it stays on
 * screen while the operator navigates between pages. State comes from the
 * server (CONNECTED only after the ATM really answered); duration counts
 * from the server's answer time.
 */
export function ActiveCallPanel() {
  const { call, hangup, error, notice, clearError, media, registration } = useConsole();
  const confirmSetting = useQuery({ queryKey: ['settings'], queryFn: () => dataService.settings(), staleTime: 600_000, enabled: useSession.getState().can('system:read') });
  const now = useNow(500);
  const [confirm, setConfirm] = useState(false);
  const [min, setMin] = useState(false);
  const atm = useQuery({ queryKey: ['atm', call?.atmId], queryFn: () => dataService.atm(call!.atmId), enabled: !!call?.atmId, staleTime: 10_000 });

  if (!call && !error && !notice) return null;

  const active = !!call && ACTIVE_CALL_STATES.has(call.state);
  const connected = call?.state === 'CONNECTED';
  const confirmWhenConnected = (confirmSetting.data?.values.find((v) => v.key === 'calls.confirmHangupWhenConnected')?.value as boolean | undefined) ?? false;
  const doHangup = () => (connected && confirmWhenConnected ? setConfirm(true) : void hangup());
  const duration = call?.answeredAt ? (call.endedAt ? +new Date(call.endedAt) : now) - +new Date(call.answeredAt) : null;

  if (min && call) {
    return (
      <button onClick={() => setMin(false)} className={cn('fixed bottom-4 right-4 z-30 flex items-center gap-3 rounded-full border bg-card px-4 py-2 shadow-2xl', connected && 'border-success/50 animate-pulse-ring')}>
        <Phone className="size-4 text-success" />
        <span className="text-sm font-medium">{call.atmCode}</span>
        <CallStateBadge state={call.state} />
        <span className="num text-sm">{formatDuration(duration)}</span>
      </button>
    );
  }

  return (
    <section aria-label="Active call" className={cn('fixed bottom-4 right-4 z-30 w-[400px] rounded-xl border bg-card shadow-2xl animate-fade-in', connected && 'border-success/40')}>
      {call && (
        <>
          <header className="flex items-start gap-3 border-b px-4 py-3">
            <div className={cn('mt-0.5 grid size-9 shrink-0 place-items-center rounded-full', connected ? 'bg-success/15 text-success animate-pulse-ring' : active ? 'bg-primary/15 text-primary' : 'bg-elevated text-muted')}>
              <Phone className="size-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate font-semibold">{call.atmName}</span>
              </div>
              <div className="flex items-center gap-2 whitespace-nowrap text-xs text-muted">
                <span className="font-mono">{call.atmCode}</span>·<span className="truncate">{call.regionName}</span>
                {atm.data && <ATMStatusBadge registration={atm.data.registrationStatus} status={atm.data.status} />}
              </div>
            </div>
            <div className="flex gap-1">
              <Button variant="ghost" size="icon-sm" onClick={() => setMin(true)} aria-label="Minimise call panel"><Minimize2 /></Button>
              {!active && <Button variant="ghost" size="icon-sm" onClick={() => useConsole.setState({ call: null, error: null, notice: null })} aria-label="Dismiss"><X /></Button>}
            </div>
          </header>
          <div className="space-y-3 px-4 py-3">
            <div className="flex items-center justify-between">
              <CallStateBadge state={call.state} />
              <span className={cn('num text-2xl font-semibold tabular-nums', connected ? 'text-foreground' : 'text-subtle')} aria-label="Call duration">{formatDuration(duration ?? 0)}</span>
            </div>
            <ol className="grid grid-cols-4 gap-1" aria-label="Call progress">
              {STEPS.map((s) => {
                const order = STEPS.indexOf(s);
                const cur = STEPS.indexOf(call.state as (typeof STEPS)[number]);
                const reached = cur >= order || (!active && call.answeredAt && true) || (call.state === 'TERMINATING' && order <= 3 && !!call.answeredAt);
                return (
                  <li key={s} className="space-y-1">
                    <div className={cn('h-1 rounded-full', reached ? (s === 'CONNECTED' ? 'bg-success' : 'bg-primary') : 'bg-elevated')} />
                    <div className="text-[10px] uppercase tracking-wide text-subtle">{s.toLowerCase()}</div>
                  </li>
                );
              })}
            </ol>
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
              <PriorityBadge p={call.priority} />
              <span>Routing: {call.routingDecision?.toLowerCase()}</span>
              <span className="flex items-center gap-1"><Signal className="size-3" /> console {registration}</span>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
              <QualityMeter />
            {!active && (
              <div className="rounded-md bg-elevated px-3 py-2 text-xs text-muted">
                Ended {call.hangupBy ? `by ${call.hangupBy.toLowerCase()}` : ''} {call.failureReason ? `— ${call.failureReason}` : ''} {call.sipCode ? `(SIP ${call.sipCode})` : ''}
              </div>
            )}
              {atm.data?.vmsLink && (
                <a href={atm.data.vmsLink} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
                  <ExternalLink className="size-3" /> Open camera in VMS
                </a>
              )}
            </div>
            <CallControlBar inCall={media === 'established' || connected} canHangup={active} onHangup={doHangup} />
          </div>
        </>
      )}
      {(error || notice) && (
        <div role="alert" className={cn('flex items-start gap-2 border-t px-4 py-2.5 text-sm', error ? 'text-danger' : 'text-info', !call && 'rounded-xl border-t-0')}>
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span className="flex-1">{error ? callErrorText[error.code] ?? error.message : notice}</span>
          <button className="text-muted hover:text-foreground" onClick={clearError} aria-label="Dismiss message"><X className="size-4" /></button>
        </div>
      )}
      <ConfirmationDialog open={confirm} onOpenChange={setConfirm} title="End this call?" description={`You are connected to ${call?.atmCode}. The person at the ATM will no longer hear you.`} confirmLabel="Hang up" onConfirm={() => hangup()} />
    </section>
  );
}
