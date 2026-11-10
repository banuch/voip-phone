import { ShieldPlus } from 'lucide-react';
import { useState } from 'react';
import { PageHeader } from '@/app/AppShell';
import { AssignmentManager, OverrideDialog, OverridesList } from '@/components/AssignmentManager';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useSession } from '@/stores/session';

const PRECEDENCE = [
  ['1', 'Override', 'An unexpired supervisor override replaces the primary operator.'],
  ['2', 'Primary', 'The static primary operator, if available, on shift and not busy.'],
  ['3', 'Backup', 'The static backup operator, under the same conditions.'],
  ['4', 'Dynamic pool', 'Best eligible operator in the same organization and region: group match, then lowest workload, routing priority, longest idle.'],
  ['5', 'Escalate', 'Nobody eligible: supervisors are alerted; the request keeps waiting.'],
];

export function AssignmentsPage() {
  const can = useSession((s) => s.can);
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-4 px-6 pb-24">
      <PageHeader inset={false} title="Assignments" description="Hybrid model: static primary/backup assignments with dynamic fallback and supervisor overrides." actions={can('assignment:override') && <Button onClick={() => setOpen(true)}><ShieldPlus /> Temporary override</Button>} />
      <Card>
        <CardHeader><CardTitle>Routing precedence</CardTitle></CardHeader>
        <CardContent className="grid gap-2 md:grid-cols-5">
          {PRECEDENCE.map(([n, t, d]) => (
            <div key={n} className="rounded-md border bg-surface p-3"><div className="text-xs font-semibold text-primary">{n} · {t}</div><p className="mt-1 text-xs text-muted">{d}</p></div>
          ))}
        </CardContent>
      </Card>
      <Card><CardHeader><CardTitle>Active overrides</CardTitle></CardHeader><OverridesList /></Card>
      <Card>
        <CardHeader><CardTitle>Static assignments</CardTitle><Input className="w-64" placeholder="Filter ATM or operator" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter assignments" /></CardHeader>
        <AssignmentManager filter={filter} />
      </Card>
      <OverrideDialog open={open} onOpenChange={setOpen} />
    </div>
  );
}
