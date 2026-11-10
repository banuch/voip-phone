import type { Availability, CallState, DeviceHealth, DeviceRegistration, Priority } from '@wintek/shared';
import { PRIORITY_LABEL } from '@wintek/shared';
import { Badge } from '@/components/ui/badge';
import { availabilityLabel, availabilityTone, callLabel, callTone, healthTone, priorityTone, registrationLabel, registrationTone } from '@/utils/status';

/** Registration + in-call state of an ATM intercom in one badge. */
export function ATMStatusBadge({ registration, status, inCall }: { registration: DeviceRegistration; status?: string; inCall?: boolean }) {
  if (status && status !== 'ACTIVE') return <Badge tone="neutral">{status === 'MAINTENANCE' ? 'Maintenance' : 'Disabled'}</Badge>;
  if (inCall) return <Badge tone="primary" dot pulse>In call</Badge>;
  return (
    <Badge tone={registrationTone[registration]} dot>
      {registrationLabel[registration]}
    </Badge>
  );
}

export const HealthBadge = ({ health }: { health: DeviceHealth }) => <Badge tone={healthTone[health]}>{health === 'OK' ? 'Healthy' : health.toLowerCase()}</Badge>;

export const AvailabilityBadge = ({ value }: { value: Availability }) => (
  <Badge tone={availabilityTone[value]} dot pulse={value === 'BUSY'}>
    {availabilityLabel[value]}
  </Badge>
);

export const CallStateBadge = ({ state }: { state: CallState }) => (
  <Badge tone={callTone[state]} dot pulse={state === 'RINGING' || state === 'DIALING'}>
    {callLabel[state]}
  </Badge>
);

export const PriorityBadge = ({ p }: { p: Priority }) => (
  <Badge tone={priorityTone[p]} title={PRIORITY_LABEL[p]}>
    {p} · {PRIORITY_LABEL[p]}
  </Badge>
);
