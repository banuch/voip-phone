import { useQuery } from '@tanstack/react-query';
import { Select } from '@/components/ui/input';
import { dataService } from '@/services/api';

export function RegionFilter({ value, onChange, className }: { value?: string; onChange: (v: string | undefined) => void; className?: string }) {
  const { data } = useQuery({ queryKey: ['regions'], queryFn: () => dataService.regions(), staleTime: 300_000 });
  return (
    <Select aria-label="Region" value={value ?? ''} onChange={(e) => onChange(e.target.value || undefined)} className={className}>
      <option value="">All regions</option>
      {data?.map((r) => (
        <option key={r.id} value={r.id}>
          {r.name}
        </option>
      ))}
    </Select>
  );
}

export function GroupFilter({ value, onChange }: { value?: string; onChange: (v: string | undefined) => void }) {
  const { data } = useQuery({ queryKey: ['groups'], queryFn: () => dataService.groups(), staleTime: 300_000 });
  return (
    <Select aria-label="ATM group" value={value ?? ''} onChange={(e) => onChange(e.target.value || undefined)}>
      <option value="">All groups</option>
      {data?.map((g) => (
        <option key={g.id} value={g.id}>
          {g.name}
        </option>
      ))}
    </Select>
  );
}
