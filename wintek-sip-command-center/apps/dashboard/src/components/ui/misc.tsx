import * as DM from '@radix-ui/react-dropdown-menu';
import * as SliderP from '@radix-ui/react-slider';
import * as SwitchP from '@radix-ui/react-switch';
import * as TabsP from '@radix-ui/react-tabs';
import * as TooltipP from '@radix-ui/react-tooltip';
import * as React from 'react';
import { cn } from '@/lib/utils';

export const Skeleton = ({ className, ...p }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('animate-pulse rounded-md bg-elevated', className)} {...p} />
);

export const Separator = ({ className, vertical }: { className?: string; vertical?: boolean }) => (
  <div role="separator" className={cn(vertical ? 'w-px self-stretch' : 'h-px w-full', 'bg-border', className)} />
);

export const TooltipProvider = TooltipP.Provider;
export function Tooltip({ content, children, side = 'top' }: { content: React.ReactNode; children: React.ReactNode; side?: 'top' | 'bottom' | 'left' | 'right' }) {
  return (
    <TooltipP.Root delayDuration={250}>
      <TooltipP.Trigger asChild>{children}</TooltipP.Trigger>
      <TooltipP.Portal>
        <TooltipP.Content side={side} sideOffset={6} className="z-[60] max-w-xs rounded-md border bg-elevated px-2.5 py-1.5 text-xs text-foreground shadow-lg">
          {content}
        </TooltipP.Content>
      </TooltipP.Portal>
    </TooltipP.Root>
  );
}

export const Tabs = TabsP.Root;
export const TabsList = ({ className, ...p }: TabsP.TabsListProps) => (
  <TabsP.List className={cn('inline-flex h-9 items-center gap-1 rounded-md border bg-surface p-1', className)} {...p} />
);
export const TabsTrigger = ({ className, ...p }: TabsP.TabsTriggerProps) => (
  <TabsP.Trigger
    className={cn('rounded px-3 py-1 text-sm text-muted transition-colors hover:text-foreground data-[state=active]:bg-elevated data-[state=active]:text-foreground', className)}
    {...p}
  />
);
export const TabsContent = ({ className, ...p }: TabsP.TabsContentProps) => <TabsP.Content className={cn('mt-4 focus-visible:outline-none', className)} {...p} />;

export const Switch = ({ className, ...p }: SwitchP.SwitchProps) => (
  <SwitchP.Root className={cn('relative h-5 w-9 rounded-full border bg-elevated transition-colors data-[state=checked]:bg-primary', className)} {...p}>
    <SwitchP.Thumb className="block size-4 translate-x-0.5 rounded-full bg-foreground transition-transform data-[state=checked]:translate-x-[18px]" />
  </SwitchP.Root>
);

export const Slider = ({ className, ...p }: SliderP.SliderProps) => (
  <SliderP.Root className={cn('relative flex h-5 w-full touch-none select-none items-center', className)} {...p}>
    <SliderP.Track className="relative h-1.5 grow rounded-full bg-elevated">
      <SliderP.Range className="absolute h-full rounded-full bg-primary" />
    </SliderP.Track>
    <SliderP.Thumb className="block size-4 rounded-full border-2 border-primary bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={p['aria-label']} />
  </SliderP.Root>
);

export const DropdownMenu = DM.Root;
export const DropdownMenuTrigger = DM.Trigger;
export function DropdownMenuContent({ className, ...p }: DM.DropdownMenuContentProps) {
  return (
    <DM.Portal>
      <DM.Content sideOffset={6} className={cn('z-50 min-w-48 rounded-md border bg-elevated p-1 shadow-xl animate-fade-in', className)} {...p} />
    </DM.Portal>
  );
}
export const DropdownMenuItem = ({ className, ...p }: DM.DropdownMenuItemProps) => (
  <DM.Item className={cn('flex cursor-pointer select-none items-center gap-2 rounded px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-surface data-[disabled]:opacity-50 [&_svg]:size-4', className)} {...p} />
);
export const DropdownMenuLabel = ({ className, ...p }: DM.DropdownMenuLabelProps) => <DM.Label className={cn('px-2 py-1.5 text-xs text-muted', className)} {...p} />;
export const DropdownMenuSeparator = () => <DM.Separator className="my-1 h-px bg-border" />;
