import type { Availability } from '@wintek/shared';
import { ChevronDown, Coffee, PhoneOff, UserCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/misc';
import { useConsole } from '@/stores/console';
import { availabilityLabel } from '@/utils/status';
import { cn } from '@/lib/utils';

const OPTIONS: { v: Availability; icon: typeof UserCheck; hint: string }[] = [
  { v: 'AVAILABLE', icon: UserCheck, hint: 'Ready to place and receive call requests' },
  { v: 'BREAK', icon: Coffee, hint: 'Temporarily away' },
  { v: 'UNAVAILABLE', icon: PhoneOff, hint: 'Signed in, not taking calls' },
];

/** Operator's own availability. The badge shows what the SERVER computed (effective), which may differ from the selection. */
export function PresenceControl() {
  const { selected, effective, setPresence, registration } = useConsole();
  const color = effective === 'AVAILABLE' ? 'bg-success' : effective === 'BUSY' ? 'bg-primary' : effective === 'FAULT' ? 'bg-danger' : effective === 'OFFLINE' ? 'bg-neutral' : 'bg-warning';
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="secondary" size="sm" className="gap-2" aria-label={`Availability: ${availabilityLabel[effective]}`}>
          <span className={cn('size-2 rounded-full', color)} />
          {availabilityLabel[effective]}
          <ChevronDown className="!size-3 text-muted" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>
          Selected: {availabilityLabel[selected]} · Console: {registration}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {OPTIONS.map((o) => (
          <DropdownMenuItem key={o.v} onSelect={() => void setPresence(o.v)} disabled={effective === 'BUSY' && o.v !== selected}>
            <o.icon />
            <div>
              <div>{availabilityLabel[o.v]}</div>
              <div className="text-xs text-muted">{o.hint}</div>
            </div>
          </DropdownMenuItem>
        ))}
        {effective === 'FAULT' && <div className="px-2 pb-1.5 pt-1 text-xs text-danger">The softphone is not registered or the microphone is unavailable. Calls are blocked until it recovers.</div>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
