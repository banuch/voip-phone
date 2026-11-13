import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Users } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input, Label } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { dataService } from '@/services/api';
import { useSession } from '@/stores/session';
import type { Shift } from '@/types/api';
import { EmptyState, ErrorState, LoadingSkeleton } from './States';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const COLORS = ['bg-primary/70', 'bg-info/70', 'bg-success/60', 'bg-warning/70', 'bg-danger/60'];
const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/** Segments [startMin, endMin) on a given ISO day (1..7), splitting shifts that cross midnight. */
export function shiftSegments(s: Pick<Shift, 'daysOfWeek' | 'startTime' | 'endTime'>, day: number): [number, number][] {
  const a = toMin(s.startTime);
  const b = toMin(s.endTime);
  const prev = day === 1 ? 7 : day - 1;
  const out: [number, number][] = [];
  if (a < b) {
    if (s.daysOfWeek.includes(day)) out.push([a, b]);
  } else {
    if (s.daysOfWeek.includes(day)) out.push([a, 1440]);
    if (s.daysOfWeek.includes(prev)) out.push([0, b]);
  }
  return out;
}

function ShiftEditor({ shift, open, onOpenChange }: { shift?: Shift; open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(shift?.name ?? '');
  const [days, setDays] = useState<number[]>(shift?.daysOfWeek ?? [1, 2, 3, 4, 5]);
  const [start, setStart] = useState(shift?.startTime ?? '09:00');
  const [end, setEnd] = useState(shift?.endTime ?? '17:00');
  const [tz, setTz] = useState(shift?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  const m = useMutation({
    mutationFn: () => dataService.saveShift({ id: shift?.id, name, daysOfWeek: days, startTime: start, endTime: end, timezone: tz, regionId: shift?.regionId ?? null }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['shifts'] });
      onOpenChange(false);
    },
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={shift ? `Edit ${shift.name}` : 'New shift'} description="An end time earlier than the start time means the shift runs past midnight.">
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
          <div className="space-y-1"><Label htmlFor="sh-name">Name</Label><Input id="sh-name" value={name} onChange={(e) => setName(e.target.value)} required /></div>
          <fieldset className="space-y-1">
            <legend className="text-xs font-medium text-muted">Days</legend>
            <div className="flex gap-1">
              {DAYS.map((d, i) => (
                <button type="button" key={d} aria-pressed={days.includes(i + 1)} onClick={() => setDays((x) => (x.includes(i + 1) ? x.filter((y) => y !== i + 1) : [...x, i + 1].sort()))}
                  className={cn('h-8 w-11 rounded-md border text-xs', days.includes(i + 1) ? 'border-primary bg-primary/15 text-primary' : 'text-muted')}>{d}</button>
              ))}
            </div>
          </fieldset>
          <div className="grid grid-cols-3 gap-2">
            <div className="space-y-1"><Label htmlFor="sh-s">Start</Label><Input id="sh-s" type="time" value={start} onChange={(e) => setStart(e.target.value)} /></div>
            <div className="space-y-1"><Label htmlFor="sh-e">End</Label><Input id="sh-e" type="time" value={end} onChange={(e) => setEnd(e.target.value)} /></div>
            <div className="space-y-1"><Label htmlFor="sh-tz">Time zone</Label><Input id="sh-tz" value={tz} onChange={(e) => setTz(e.target.value)} /></div>
          </div>
          {m.error && <div role="alert" className="text-sm text-danger">{(m.error as Error).message}</div>}
          <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button type="submit" disabled={!name || !days.length || m.isPending}>Save shift</Button></div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function MembersEditor({ shift, open, onOpenChange }: { shift: Shift; open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const ops = useQuery({ queryKey: ['operators', 'all'], queryFn: () => dataService.operators({}) });
  const [sel, setSel] = useState(new Set(shift.members.map((m) => m.operatorId)));
  const m = useMutation({ mutationFn: () => dataService.setShiftMembers(shift.id, [...sel]), onSuccess: () => { void qc.invalidateQueries({ queryKey: ['shifts'] }); onOpenChange(false); } });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={`Operators on ${shift.name}`}>
        <div className="max-h-80 space-y-1 overflow-y-auto">
          {ops.data?.items.map((o) => (
            <label key={o.id} className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-elevated">
              <input type="checkbox" checked={sel.has(o.id)} onChange={() => setSel((s) => { const n = new Set(s); n.has(o.id) ? n.delete(o.id) : n.add(o.id); return n; })} className="accent-[hsl(var(--primary))]" />
              {o.name} <span className="text-xs text-muted">{o.regions.map((r) => r.name).join(', ')}</span>
            </label>
          ))}
        </div>
        <div className="mt-4 flex justify-end gap-2"><Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button onClick={() => m.mutate()} disabled={m.isPending}>Save members ({sel.size})</Button></div>
      </DialogContent>
    </Dialog>
  );
}

/** Weekly coverage grid plus shift list with member editing. */
export function ShiftScheduler() {
  const can = useSession((s) => s.can);
  const q = useQuery({ queryKey: ['shifts'], queryFn: () => dataService.shifts() });
  const [editing, setEditing] = useState<Shift | 'new' | null>(null);
  const [members, setMembers] = useState<Shift | null>(null);
  if (q.isLoading) return <LoadingSkeleton rows={8} />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const shifts = q.data ?? [];
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Weekly coverage</CardTitle>
          {can('shift:manage') && <Button size="sm" onClick={() => setEditing('new')}><Plus /> New shift</Button>}
        </CardHeader>
        <CardContent>
          {!shifts.length ? <EmptyState title="No shifts defined" description="Without shifts, routing policies that require an active shift will escalate." /> : (
            <div className="space-y-1.5" role="table" aria-label="Weekly shift coverage">
              <div className="ml-12 flex justify-between text-[10px] text-subtle" aria-hidden>{[0, 3, 6, 9, 12, 15, 18, 21, 24].map((h) => <span key={h}>{String(h).padStart(2, '0')}</span>)}</div>
              {DAYS.map((d, di) => (
                <div key={d} className="flex items-center gap-2" role="row">
                  <span className="w-10 text-xs text-muted" role="rowheader">{d}</span>
                  <div className="relative h-7 flex-1 rounded bg-surface" role="cell">
                    {shifts.flatMap((s, si) =>
                      shiftSegments(s, di + 1).map(([a, b], k) => (
                        <div key={`${s.id}-${k}`} className={cn('absolute top-0.5 h-6 rounded-sm px-1.5 text-[10px] leading-6 text-background', COLORS[si % COLORS.length])}
                          style={{ left: `${(a / 1440) * 100}%`, width: `${((b - a) / 1440) * 100}%`, top: 2 + (si % 2) * 0 }} title={`${s.name} ${s.startTime}–${s.endTime} ${s.timezone}`}>
                          <span className="truncate font-semibold">{s.name}</span>
                        </div>
                      )),
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {shifts.map((s, si) => (
          <Card key={s.id}>
            <CardHeader>
              <div className="flex items-center gap-2"><span className={cn('size-2.5 rounded-sm', COLORS[si % COLORS.length])} /><CardTitle>{s.name}</CardTitle></div>
              <span className="text-xs text-muted">{s.startTime}–{s.endTime} · {s.timezone}</span>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap gap-1">{DAYS.map((d, i) => <Badge key={d} tone={s.daysOfWeek.includes(i + 1) ? 'primary' : 'neutral'}>{d}</Badge>)}</div>
              <div className="text-sm"><Users className="mr-1 inline size-4 text-muted" />{s.members.length} operator(s): <span className="text-muted">{s.members.slice(0, 5).map((m) => m.name).join(', ')}{s.members.length > 5 ? '…' : ''}</span></div>
              {can('shift:manage') && (
                <div className="flex gap-2"><Button size="sm" variant="outline" onClick={() => setEditing(s)}>Edit</Button><Button size="sm" variant="outline" onClick={() => setMembers(s)}>Members</Button></div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
      {editing && <ShiftEditor shift={editing === 'new' ? undefined : editing} open onOpenChange={(o) => !o && setEditing(null)} />}
      {members && <MembersEditor shift={members} open onOpenChange={(o) => !o && setMembers(null)} />}
    </div>
  );
}
