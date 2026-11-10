import { useQuery } from '@tanstack/react-query';
import { Download, Table2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { PageHeader } from '@/app/AppShell';
import { ErrorState, LoadingSkeleton } from '@/components/States';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/misc';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { formatDuration } from '@/lib/utils';
import { dataService } from '@/services/api';
import { INK, SERIES, STATUS, axisProps, dayLabel, hourLabel, legendProps, tooltipProps } from '@/utils/chartTheme';

const RANGES = { '24h': 1, '7d': 7, '30d': 30 } as const;

function toCsv(rows: Record<string, unknown>[]) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]!);
  const cell = (v: unknown) => { let s = String(v ?? ''); if (/^[=+\-@]/.test(s)) s = `'${s}`; return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n');
}
function download(name: string, rows: Record<string, unknown>[]) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([toCsv(rows)], { type: 'text/csv' }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function ReportsPage() {
  const [range, setRange] = useState<keyof typeof RANGES>('7d');
  const [table, setTable] = useState(false);
  const win = useMemo(() => {
    const to = new Date();
    return { from: new Date(to.getTime() - RANGES[range] * 86_400_000).toISOString(), to: to.toISOString(), bucket: range === '24h' ? ('hour' as const) : ('day' as const) };
  }, [range]);
  const calls = useQuery({ queryKey: ['callsReport', win], queryFn: () => dataService.callsReport(win) });
  const avail = useQuery({ queryKey: ['availReport', win], queryFn: () => dataService.availabilityReport(win) });
  const fmt = win.bucket === 'hour' ? hourLabel : dayLabel;
  const r = calls.data;
  return (
    <div className="space-y-4 px-6 pb-24">
      <PageHeader
        title="Reports"
        description="Call and device metadata. No audio is recorded."
        actions={
          <>
            <Tabs value={range} onValueChange={(v) => setRange(v as keyof typeof RANGES)}><TabsList>{Object.keys(RANGES).map((k) => <TabsTrigger key={k} value={k}>{k}</TabsTrigger>)}</TabsList></Tabs>
            <Button variant={table ? 'secondary' : 'ghost'} onClick={() => setTable((t) => !t)} aria-pressed={table}><Table2 /> Table view</Button>
            {r && <Button variant="outline" onClick={() => download(`calls-${range}.csv`, r.series)}><Download /> CSV</Button>}
          </>
        }
      />
      {calls.isLoading ? <LoadingSkeleton rows={10} /> : calls.error ? <ErrorState error={calls.error} onRetry={() => calls.refetch()} /> : r && (
        <>
          <div className="grid gap-4 xl:grid-cols-2">
            <Card>
              <CardHeader><CardTitle>Calls per {win.bucket}</CardTitle></CardHeader>
              <CardContent className="h-72">
                {table ? <SeriesTable rows={r.series.map((s) => ({ when: fmt(s.bucket), initiated: s.total, connected: s.connected, failed: s.failed }))} /> : (
                  <ResponsiveContainer>
                    <BarChart data={r.series} barGap={2} margin={{ left: -18, right: 4 }}>
                      <CartesianGrid vertical={false} stroke={INK.grid} />
                      <XAxis dataKey="bucket" tickFormatter={fmt} {...axisProps} minTickGap={20} />
                      <YAxis allowDecimals={false} {...axisProps} />
                      <Tooltip {...tooltipProps} labelFormatter={(v) => fmt(String(v))} />
                      <Legend {...legendProps} />
                      <Bar dataKey="connected" name="Connected" fill={SERIES[0]} radius={[4, 4, 0, 0]} maxBarSize={18} />
                      <Bar dataKey="failed" name="Failed / no answer" fill={STATUS.critical} radius={[4, 4, 0, 0]} maxBarSize={18} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle>Device availability events</CardTitle></CardHeader>
              <CardContent className="h-72">
                {avail.isLoading ? <LoadingSkeleton rows={5} /> : table ? <SeriesTable rows={(avail.data ?? []).map((p) => ({ when: fmt(p.bucket), registrations: p.registrations, disconnects: p.disconnects, faults: p.faults }))} /> : (
                  <ResponsiveContainer>
                    <LineChart data={avail.data ?? []} margin={{ left: -18, right: 4 }}>
                      <CartesianGrid vertical={false} stroke={INK.grid} />
                      <XAxis dataKey="bucket" tickFormatter={fmt} {...axisProps} minTickGap={20} />
                      <YAxis allowDecimals={false} {...axisProps} />
                      <Tooltip {...tooltipProps} labelFormatter={(v) => fmt(String(v))} />
                      <Legend {...legendProps} />
                      <Line type="monotone" dataKey="registrations" name="Registrations" stroke={SERIES[0]} strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
                      <Line type="monotone" dataKey="disconnects" name="Disconnects" stroke={SERIES[1]} strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
                      <Line type="monotone" dataKey="faults" name="Faults" stroke={SERIES[2]} strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
                    </LineChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>
          </div>
          <div className="grid gap-4 xl:grid-cols-2">
            <Card>
              <CardHeader><CardTitle>Calls per region</CardTitle></CardHeader>
              <CardContent className="h-72">
                {table ? <SeriesTable rows={r.byRegion} /> : (
                  <ResponsiveContainer>
                    <BarChart data={r.byRegion} layout="vertical" barGap={2} margin={{ left: 10, right: 16 }}>
                      <CartesianGrid horizontal={false} stroke={INK.grid} />
                      <XAxis type="number" allowDecimals={false} {...axisProps} />
                      <YAxis type="category" dataKey="region" width={90} {...axisProps} />
                      <Tooltip {...tooltipProps} />
                      <Legend {...legendProps} />
                      <Bar dataKey="connected" name="Connected" fill={SERIES[0]} radius={[0, 4, 4, 0]} maxBarSize={14} />
                      <Bar dataKey="failed" name="Failed / no answer" fill={STATUS.critical} radius={[0, 4, 4, 0]} maxBarSize={14} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle>Operator activity</CardTitle></CardHeader>
              <div className="max-h-72 overflow-y-auto">
                <Table>
                  <THead><TR><TH>Operator</TH><TH className="text-right">Calls</TH><TH className="text-right">Connected</TH><TH className="text-right">Talk time</TH></TR></THead>
                  <TBody>{r.byOperator.map((o) => <TR key={o.operator}><TD>{o.operator}</TD><TD className="num text-right">{o.calls}</TD><TD className="num text-right">{o.connected}</TD><TD className="num text-right">{formatDuration(o.talkTimeSec * 1000)}</TD></TR>)}</TBody>
                </Table>
              </div>
            </Card>
          </div>
          <Card>
            <CardHeader><CardTitle>Failed call attempts by cause</CardTitle></CardHeader>
            <Table>
              <THead><TR><TH>Result</TH><TH>Reason</TH><TH>SIP code</TH><TH className="text-right">Count</TH></TR></THead>
              <TBody>{r.failures.map((f, i) => <TR key={i}><TD>{f.state}</TD><TD className="text-muted">{f.reason || '—'}</TD><TD className="font-mono text-xs">{f.sipCode ?? '—'}</TD><TD className="num text-right">{f.count}</TD></TR>)}</TBody>
            </Table>
          </Card>
        </>
      )}
    </div>
  );
}

function SeriesTable({ rows }: { rows: Record<string, unknown>[] }) {
  if (!rows.length) return null;
  const cols = Object.keys(rows[0]!);
  return (
    <div className="h-full overflow-auto">
      <Table>
        <THead><TR>{cols.map((c) => <TH key={c}>{c}</TH>)}</TR></THead>
        <TBody>{rows.map((r, i) => <TR key={i}>{cols.map((c) => <TD key={c} className="num">{String(r[c])}</TD>)}</TR>)}</TBody>
      </Table>
    </div>
  );
}
