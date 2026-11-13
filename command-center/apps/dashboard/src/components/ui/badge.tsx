import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';
import { cn } from '@/lib/utils';

export const badgeVariants = cva('inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide whitespace-nowrap', {
  variants: {
    tone: {
      success: 'border-success/30 bg-success/10 text-success',
      warning: 'border-warning/30 bg-warning/10 text-warning',
      danger: 'border-danger/35 bg-danger/10 text-danger',
      info: 'border-info/30 bg-info/10 text-info',
      primary: 'border-primary/30 bg-primary/10 text-primary',
      neutral: 'border-border bg-elevated text-muted',
    },
  },
  defaultVariants: { tone: 'neutral' },
});

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {
  dot?: boolean;
  pulse?: boolean;
}

export function Badge({ className, tone, dot, pulse, children, ...p }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ tone }), className)} {...p}>
      {dot && <span className={cn('size-1.5 rounded-full bg-current', pulse && 'animate-pulse')} aria-hidden />}
      {children}
    </span>
  );
}
