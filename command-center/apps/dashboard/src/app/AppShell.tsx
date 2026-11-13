import { ACTIVE_CALL_STATES } from '@wintek/shared';
import {
  Activity, BarChart3, Bell, Building2, CalendarClock, ChevronsLeft, ChevronsRight, FileClock, Headset, LayoutDashboard, ListOrdered,
  LogOut, Monitor, PhoneCall, Search, Settings, Shield, UserCog, Users,
} from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { ActiveCallPanel } from '@/components/ActiveCallPanel';
import { PresenceControl } from '@/components/PresenceControl';
import { StaleBanner, StaleIndicator } from '@/components/StaleIndicator';
import { useHealth } from '@/components/SystemHealthWidget';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, Tooltip } from '@/components/ui/misc';
import { useHotkeys } from '@/hooks/useHotkeys';
import { useRealtimeSync } from '@/hooks/useRealtimeSync';
import { cn, relativeTime } from '@/lib/utils';
import { isMock } from '@/services/api';
import { useConsole } from '@/stores/console';
import { useRealtime } from '@/stores/realtime';
import { useSession } from '@/stores/session';
import { ROLE_LABEL } from '@wintek/shared';

export const NAV = [
  { to: '/', label: 'Overview', icon: LayoutDashboard, perm: 'atm:read', end: true },
  { to: '/atms', label: 'ATM Monitoring', icon: Monitor, perm: 'atm:read' },
  { to: '/console', label: 'Operator Console', icon: Headset, perm: 'call:initiate' },
  { to: '/calls', label: 'Active Calls', icon: PhoneCall, perm: 'call:read' },
  { to: '/queue', label: 'Call Queue', icon: ListOrdered, perm: 'queue:read' },
  { to: '/operators', label: 'Operators', icon: Users, perm: 'operator:read' },
  { to: '/assignments', label: 'Assignments', icon: UserCog, perm: 'assignment:read' },
  { to: '/shifts', label: 'Shifts', icon: CalendarClock, perm: 'shift:read' },
  { to: '/reports', label: 'Reports', icon: BarChart3, perm: 'report:read' },
  { to: '/audit', label: 'Audit Logs', icon: FileClock, perm: 'audit:read' },
  { to: '/admin', label: 'Administration', icon: Shield, perm: 'user:read' },
  { to: '/settings', label: 'Settings', icon: Settings, perm: null },
] as const;

function Logo({ collapsed }: { collapsed: boolean }) {
  return (
    <div className="flex h-14 items-center gap-2.5 border-b px-4">
      <svg viewBox="0 0 32 32" className="size-7 shrink-0" aria-hidden>
        <rect width="32" height="32" rx="7" fill="hsl(var(--elevated))" />
        <path d="M6 9l4.2 14h1.6L16 12.5 20.2 23h1.6L26 9h-2.6l-2.7 9.6L17 9h-2l-3.7 9.6L8.6 9z" fill="hsl(var(--primary))" />
      </svg>
      {!collapsed && (
        <div className="leading-tight">
          <div className="text-sm font-semibold tracking-wide">WINTEK</div>
          <div className="text-[10px] uppercase tracking-[0.18em] text-muted">SIP Command Center</div>
        </div>
      )}
    </div>
  );
}

function Sidebar() {
  const can = useSession((s) => s.can);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('wintek.sidebar') === '1');
  const callState = useConsole((s) => s.call?.state);
  const inCall = !!callState && ACTIVE_CALL_STATES.has(callState);
  useEffect(() => {
    try {
      localStorage.setItem('wintek.sidebar', collapsed ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [collapsed]);
  return (
    <aside className={cn('flex shrink-0 flex-col border-r bg-surface transition-[width]', collapsed ? 'w-[60px]' : 'w-60')} aria-label="Main navigation">
      <Logo collapsed={collapsed} />
      <nav className="flex-1 space-y-0.5 overflow-y-auto p-2">
        {NAV.filter((n) => !n.perm || can(n.perm)).map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={'end' in n}
            className={({ isActive }) =>
              cn(
                'group flex h-9 items-center gap-3 rounded-md px-2.5 text-sm text-muted transition-colors hover:bg-elevated hover:text-foreground',
                isActive && 'bg-primary/10 text-foreground shadow-[inset_2px_0_0_hsl(var(--primary))]',
              )
            }
            title={collapsed ? n.label : undefined}
          >
            <n.icon className="size-4 shrink-0" aria-hidden />
            {!collapsed && <span className="truncate">{n.label}</span>}
            {!collapsed && n.to === '/console' && inCall && <span className="ml-auto size-2 rounded-full bg-success animate-pulse" aria-label="in call" />}
          </NavLink>
        ))}
      </nav>
      <button onClick={() => setCollapsed((c) => !c)} className="flex h-10 items-center gap-2 border-t px-4 text-xs text-muted hover:text-foreground" aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
        {collapsed ? <ChevronsRight className="size-4" /> : <><ChevronsLeft className="size-4" /> Collapse</>}
      </button>
    </aside>
  );
}

function Notifications() {
  const { alerts, markAlertsRead } = useRealtime();
  const unread = alerts.filter((a) => !a.read).length;
  return (
    <DropdownMenu onOpenChange={(o) => !o && markAlertsRead()}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" aria-label={`Notifications (${unread} unread)`}>
          <Bell />
          {unread > 0 && <span className="num absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-danger px-1 text-[10px] font-bold text-danger-foreground">{unread}</span>}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-96">
        <DropdownMenuLabel>System alerts</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {alerts.length === 0 ? (
          <div className="px-3 py-6 text-center text-sm text-muted">No alerts</div>
        ) : (
          alerts.slice(0, 12).map((a) => (
            <div key={a.id} className="flex gap-2 px-2 py-1.5 text-sm">
              <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', a.severity === 'critical' ? 'bg-danger' : a.severity === 'warning' ? 'bg-warning' : 'bg-info')} />
              <div className="flex-1">
                <div className={cn(!a.read && 'font-medium')}>{a.message}</div>
                <div className="text-xs text-subtle">{relativeTime(a.ts)}</div>
              </div>
            </div>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TopBar() {
  const { user, logout, can } = useSession();
  const nav = useNavigate();
  const health = useHealth();
  const [q, setQ] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  useHotkeys({ '/': () => searchRef.current?.focus() });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (q.trim()) nav(`/atms?q=${encodeURIComponent(q.trim())}`);
  };
  const h = health.data?.status;
  return (
    <header className="flex h-14 shrink-0 items-center gap-4 border-b bg-surface/80 px-4 backdrop-blur">
      <div className="flex items-center gap-2 text-sm">
        <Building2 className="size-4 text-muted" aria-hidden />
        <span className="font-medium">{user?.organizationName ?? 'All organizations'}</span>
      </div>
      <form onSubmit={submit} className="relative max-w-md flex-1" role="search">
        <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-subtle" aria-hidden />
        <Input ref={searchRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search ATM ID, site, city…  ( / )" className="pl-8" aria-label="Search ATMs" />
      </form>
      <div className="ml-auto flex items-center gap-3">
        {isMock && <Badge tone="warning" title="VITE_DATA_SOURCE=mock — simulated data">Demo data</Badge>}
        <StaleIndicator />
        {can('system:read') && (
          <Tooltip content={`System ${h ?? 'unknown'} — open health`}>
            <Button variant="ghost" size="icon" onClick={() => nav('/settings?tab=system')} aria-label={`System health ${h ?? 'unknown'}`}>
              <Activity className={cn(h === 'up' ? 'text-success' : h === 'degraded' ? 'text-warning' : h === 'down' ? 'text-danger' : 'text-muted')} />
            </Button>
          </Tooltip>
        )}
        <Notifications />
        {user?.operatorId && can('presence:self') && <PresenceControl />}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-elevated" aria-label="User menu">
              <div className="grid size-8 place-items-center rounded-full bg-primary/20 text-xs font-semibold text-primary">{user?.displayName.split(' ').map((p) => p[0]).slice(0, 2).join('')}</div>
              <div className="hidden text-left leading-tight lg:block">
                <div className="text-sm">{user?.displayName}</div>
                <div className="text-[11px] text-muted">{user?.roles.map((r) => ROLE_LABEL[r]).join(', ')}</div>
              </div>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>{user?.username}</DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => nav('/settings')}><Settings /> Settings</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={async () => {
                await useConsole.getState().stopConsole();
                await logout();
              }}
            >
              <LogOut /> Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}

export function AppShell() {
  useRealtimeSync();
  const user = useSession((s) => s.user);
  const { call, hangup, setMuted, muted, startConsole, recover } = useConsole();
  const inCall = !!call && ACTIVE_CALL_STATES.has(call.state);

  // Operators get their softphone and presence heartbeat as soon as they sign in,
  // so they are reachable from any page; recover a call after a reload.
  useEffect(() => {
    if (user?.operatorId && user.permissions.includes('call:initiate')) {
      void startConsole().catch((e) => useConsole.setState({ error: { code: 'CONSOLE_START', message: `Softphone failed to start: ${e.message}` } }));
      void recover();
    }
  }, [user?.operatorId, user?.permissions, startConsole, recover]);

  // A reload drops the audio leg; warn before leaving mid-call.
  useEffect(() => {
    if (!inCall) return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [inCall]);

  useHotkeys({ 'alt+h': () => inCall && void hangup(), m: () => inCall && setMuted(!muted) }, inCall);

  return (
    <div className="flex h-full">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-primary focus:px-3 focus:py-1 focus:text-primary-foreground">Skip to content</a>
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <StaleBanner />
        <main id="main" className="min-h-0 flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
      <ActiveCallPanel />
    </div>
  );
}

/** `inset` adds the page gutter; pass false when the page already pads its content. */
export function PageHeader({ title, description, actions, inset = true }: { title: string; description?: string; actions?: React.ReactNode; inset?: boolean }) {
  return (
    <div className={cn('flex flex-wrap items-end justify-between gap-3 pb-4 pt-5', inset && 'px-6')}>
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
