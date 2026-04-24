import * as React from "react";
import { ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";

interface FilterChipProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  value: string;
  active?: boolean;
  className?: string;
  icon?: React.ReactNode;
}

const FilterChip = React.forwardRef<HTMLButtonElement, FilterChipProps>(
  ({ label, value, active, className, icon, type = "button", ...buttonProps }, ref) => {
    return (
      <button
        ref={ref}
        type={type}
        title={value}
        className={cn(
          "group relative flex min-h-[70px] w-full min-w-0 items-center gap-2 rounded-xl border border-border/60 bg-card px-3 py-2.5 text-sm transition-all duration-300 ease-out sm:gap-2.5 sm:rounded-2xl sm:px-4 sm:py-3",
          "hover:-translate-y-0.5 hover:border-primary/25 hover:premium-shadow",
          "focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/30",
          "active:translate-y-0 active:shadow-sm",
          active && "border-primary/30 premium-shadow bg-gradient-to-b from-card to-badge/30",
          className,
        )}
        {...buttonProps}
      >
        {icon ? (
          <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-badge text-primary transition-colors duration-200 group-hover:bg-primary/15 sm:h-7 sm:w-7 sm:rounded-xl">
            {icon}
          </span>
        ) : null}
        <div className="min-w-0 flex-1">
          <span className="block text-[10px] font-semibold uppercase tracking-widest leading-none text-muted-foreground">
            {label}
          </span>
          <span className="mt-1 block truncate whitespace-nowrap text-sm font-bold leading-none text-card-foreground">
            {value}
          </span>
        </div>
        <ChevronDown className="ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground/60 transition-transform duration-200 group-hover:translate-y-0.5 group-hover:text-primary/60 sm:ml-1" />
      </button>
    );
  },
);

FilterChip.displayName = "FilterChip";

export default FilterChip;
