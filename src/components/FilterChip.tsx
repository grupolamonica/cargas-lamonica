import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

interface FilterChipProps {
  label: string;
  value: string;
  onClick?: () => void;
  active?: boolean;
  className?: string;
  icon?: React.ReactNode;
}

const FilterChip = ({ label, value, onClick, active, className, icon }: FilterChipProps) => {
  return (
    <button
      onClick={onClick}
      className={cn(
        "group relative flex items-center gap-2 sm:gap-2.5 rounded-xl sm:rounded-2xl bg-card border border-border/60 px-3 sm:px-4 py-2.5 sm:py-3 text-sm w-full sm:w-auto",
        "transition-all duration-300 ease-out",
        "hover:premium-shadow hover:border-primary/25 hover:-translate-y-0.5",
        "focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/30",
        "active:translate-y-0 active:shadow-sm",
        active && "border-primary/30 premium-shadow bg-gradient-to-b from-card to-badge/30",
        className
      )}
    >
      {icon && (
        <span className="flex items-center justify-center h-6 w-6 sm:h-7 sm:w-7 rounded-lg sm:rounded-xl bg-badge text-primary transition-colors duration-200 group-hover:bg-primary/15">
          {icon}
        </span>
      )}
      <div className="flex flex-col items-start gap-0.5 min-w-0 flex-1">
        <span className="text-muted-foreground text-[10px] font-semibold uppercase tracking-widest leading-none">{label}</span>
        <span className="font-bold text-card-foreground text-sm leading-none truncate">{value}</span>
      </div>
      <ChevronDown className="h-3.5 w-3.5 text-muted-foreground/60 transition-transform duration-200 group-hover:text-primary/60 group-hover:translate-y-0.5 ml-auto sm:ml-1 flex-shrink-0" />
    </button>
  );
};

export default FilterChip;
