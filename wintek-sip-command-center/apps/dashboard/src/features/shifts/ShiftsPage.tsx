import { PageHeader } from '@/app/AppShell';
import { ShiftScheduler } from '@/components/ShiftScheduler';

export function ShiftsPage() {
  return (
    <div className="px-6 pb-24">
      <PageHeader inset={false} title="Shifts" description="Shift membership decides which operators routing considers on duty. Times are evaluated in each shift's own time zone." />
      <ShiftScheduler />
    </div>
  );
}
