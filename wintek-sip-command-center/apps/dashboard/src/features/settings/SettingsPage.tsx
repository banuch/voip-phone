import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { PageHeader } from '@/app/AppShell';
import { DeviceSelectors } from '@/components/CallControlBar';
import { SystemHealthWidget } from '@/components/SystemHealthWidget';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/misc';
import { supportsOutputSelection } from '@/services/sip/phone';
import { dataService } from '@/services/api';
import { useConsole } from '@/stores/console';
import { useSession } from '@/stores/session';

export function SettingsPage() {
  const [params, setParams] = useSearchParams();
  const can = useSession((s) => s.can);
  const user = useSession((s) => s.user);
  const c = useConsole();
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => dataService.settings(), enabled: can('system:read') });
  const put = useMutation({ mutationFn: ({ k, v }: { k: string; v: unknown }) => dataService.putSetting(k, v), onSettled: () => qc.invalidateQueries({ queryKey: ['settings'] }) });
  const confirmHangup = settings.data?.values.find((v) => v.key === 'calls.confirmHangupWhenConnected')?.value === true;
  return (
    <div className="px-6 pb-24">
      <PageHeader inset={false} title="Settings" />
      <Tabs value={params.get('tab') ?? 'audio'} onValueChange={(t) => setParams({ tab: t }, { replace: true })}>
        <TabsList><TabsTrigger value="audio">Audio & console</TabsTrigger>{can('system:read') && <TabsTrigger value="system">System</TabsTrigger>}<TabsTrigger value="browser">Browser support</TabsTrigger></TabsList>
        <TabsContent value="audio" className="grid gap-4 lg:grid-cols-2">
          <Card><CardHeader><CardTitle>Audio devices</CardTitle></CardHeader><CardContent><DeviceSelectors /></CardContent></Card>
          <Card><CardHeader><CardTitle>Softphone</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div>Registration: <Badge tone={c.registration === 'registered' ? 'success' : 'warning'}>{c.registration}</Badge> {c.phone && <span className="text-muted">({c.phone.kind})</span>}</div>
              <div>Microphone permission: <Badge tone={c.micPermission === 'granted' ? 'success' : 'danger'}>{c.micPermission}</Badge></div>
              <div>Operator identity: <span className="font-mono">{user?.operatorId ? user.username : 'not an operator'}</span></div>
              <p className="text-xs text-muted">Credentials are issued per session and kept in memory only. Signing out unregisters the softphone.</p>
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="system" className="grid gap-4 lg:grid-cols-2">
          <SystemHealthWidget />
          <Card><CardHeader><CardTitle>Organization settings</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm">
              <label className="flex items-center justify-between gap-3">Confirm before hanging up a connected call
                <Switch checked={confirmHangup} disabled={!can('system:manage')} onCheckedChange={(v) => put.mutate({ k: 'calls.confirmHangupWhenConnected', v })} aria-label="Confirm hang-up" /></label>
              {!can('system:manage') && <p className="text-xs text-muted">Read-only: changing system settings requires system:manage.</p>}
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="browser">
          <Card><CardContent className="space-y-2 p-5 text-sm">
            <p><strong>Supported:</strong> current Chrome, Edge and Firefox on Windows, macOS and Linux desktops; Safari 17+ (macOS) for calling. Tablets (iPadOS/Android Chrome) are supported for supervisory screens.</p>
            <p><strong>Speaker selection</strong> uses <span className="font-mono">HTMLMediaElement.setSinkId</span>: {supportsOutputSelection() ? <Badge tone="success">available here</Badge> : <Badge tone="warning">not available in this browser — system default output is used</Badge>}</p>
            <p><strong>Requirements:</strong> HTTPS (WebRTC and microphone access need a secure context), microphone permission, UDP or TURN reachability for media.</p>
            <p className="text-muted">Reloading the page during a call drops the browser's audio leg; the server ends that call and the console offers to place it again.</p>
          </CardContent></Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
