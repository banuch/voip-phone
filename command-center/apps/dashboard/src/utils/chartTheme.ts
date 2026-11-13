/**
 * Chart colours (dark surface #111a27). Categorical slots in fixed order,
 * validated with the dataviz palette validator (all checks pass, worst
 * adjacent CVD ΔE 9.4). Status colours are separate and carry labels.
 */
export const SERIES = ['#3987e5', '#d95926', '#199e70'] as const;
export const STATUS = { good: '#2fbf71', warning: '#f0a020', critical: '#eb5757' } as const;
export const INK = { primary: '#e2e8f2', secondary: '#9aa6ba', muted: '#6b778c', grid: '#1f2b40', surface: '#111a27' } as const;

export const axisProps = {
  stroke: INK.grid,
  tick: { fill: INK.muted, fontSize: 11 },
  tickLine: false,
  axisLine: false,
} as const;

export const tooltipProps = {
  cursor: { stroke: INK.secondary, strokeWidth: 1, fill: 'rgba(148,163,184,0.06)' },
  contentStyle: { background: '#17233a', border: `1px solid ${INK.grid}`, borderRadius: 8, fontSize: 12, color: INK.primary },
  labelStyle: { color: INK.secondary, marginBottom: 4 },
  itemStyle: { color: INK.primary, padding: 0 },
} as const;

export const legendProps = { iconType: 'circle' as const, iconSize: 8, wrapperStyle: { fontSize: 12, color: INK.secondary } };

export const hourLabel = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
export const dayLabel = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
