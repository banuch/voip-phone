import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ShieldOff } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { EmptyState } from '@/components/States';
import { TooltipProvider } from '@/components/ui/misc';
import { ApiError } from '@/services/api';
import { useSession } from '@/stores/session';
import { AdminPage } from '@/features/admin/AdminPage';
import { AssignmentsPage } from '@/features/assignments/AssignmentsPage';
import { AtmMonitoringPage } from '@/features/atms/AtmMonitoringPage';
import { AuditPage } from '@/features/audit/AuditPage';
import { LoginPage } from '@/features/auth/LoginPage';
import { ActiveCallsPage } from '@/features/calls/ActiveCallsPage';
import { OperatorConsolePage } from '@/features/console/OperatorConsolePage';
import { OperatorsPage } from '@/features/operators/OperatorsPage';
import { OverviewPage } from '@/features/overview/OverviewPage';
import { QueuePage } from '@/features/queue/QueuePage';
import { ReportsPage } from '@/features/reports/ReportsPage';
import { SettingsPage } from '@/features/settings/SettingsPage';
import { ShiftsPage } from '@/features/shifts/ShiftsPage';
import { AppShell } from './AppShell';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      refetchOnWindowFocus: true,
      // Don't hammer the API with retries on auth/permission/validation errors.
      retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2,
    },
  },
});

/** UI gating only; the API enforces every permission independently. */
function Guard({ perm, children }: { perm: string | null; children: ReactNode }) {
  const can = useSession((s) => s.can);
  if (perm && !can(perm)) return <EmptyState icon={<ShieldOff className="size-6" />} title="Not available for your role" description={`This screen needs the ${perm} permission.`} />;
  return <>{children}</>;
}

function Home() {
  const can = useSession((s) => s.can);
  return can('atm:read') ? <OverviewPage /> : <Navigate to="/settings" replace />;
}

function Root() {
  const { status, bootstrap } = useSession();
  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);
  if (status === 'unknown') return <div className="grid h-full place-items-center text-sm text-muted" aria-busy>Restoring session…</div>;
  if (status === 'signedOut') return <LoginPage />;
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Home />} />
        <Route path="atms" element={<Guard perm="atm:read"><AtmMonitoringPage /></Guard>} />
        <Route path="console" element={<Guard perm="call:initiate"><OperatorConsolePage /></Guard>} />
        <Route path="calls" element={<Guard perm="call:read"><ActiveCallsPage /></Guard>} />
        <Route path="queue" element={<Guard perm="queue:read"><QueuePage /></Guard>} />
        <Route path="operators" element={<Guard perm="operator:read"><OperatorsPage /></Guard>} />
        <Route path="assignments" element={<Guard perm="assignment:read"><AssignmentsPage /></Guard>} />
        <Route path="shifts" element={<Guard perm="shift:read"><ShiftsPage /></Guard>} />
        <Route path="reports" element={<Guard perm="report:read"><ReportsPage /></Guard>} />
        <Route path="audit" element={<Guard perm="audit:read"><AuditPage /></Guard>} />
        <Route path="admin" element={<Guard perm="user:read"><AdminPage /></Guard>} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<EmptyState title="Page not found" />} />
      </Route>
    </Routes>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <Root />
        </BrowserRouter>
      </TooltipProvider>
    </QueryClientProvider>
  );
}
