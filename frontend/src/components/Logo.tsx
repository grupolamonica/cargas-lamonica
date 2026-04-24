import lamonicaLogo from "@/assets/lamonica-logo.png";
import { cn } from "@/lib/utils";

interface LogoProps {
  light?: boolean;
  compact?: boolean;
}

const logoContainerTransitionStyle = {
  transitionDuration: "360ms",
  transitionTimingFunction: "cubic-bezier(0.22, 1, 0.36, 1)",
} as const;

const logoLabelTransitionStyle = {
  transitionDuration: "280ms",
  transitionTimingFunction: "cubic-bezier(0.22, 1, 0.36, 1)",
} as const;

const Logo = ({ light = false, compact = false }: LogoProps) => (
  <div className="flex items-center overflow-hidden">
    <div
      style={logoContainerTransitionStyle}
      className={cn(
        "flex items-center justify-center border transition-[width,height,border-radius]",
        compact ? "h-14 w-14 rounded-[18px]" : "h-10 w-10 rounded-[14px]",
        light
          ? "border-white/20 bg-white/10 shadow-[0_10px_24px_rgba(2,36,131,0.24)]"
          : "border-primary/10 bg-primary/10 shadow-[0_10px_24px_rgba(2,36,131,0.12)]",
      )}
    >
      <img
        src={lamonicaLogo}
        alt="Lamonica"
        className={cn("rounded-md object-contain", compact ? "h-11 w-11" : "h-7 w-7")}
      />
    </div>

    <div
      aria-hidden={compact}
      style={logoLabelTransitionStyle}
      className={cn(
        "grid min-w-0 transition-[grid-template-columns,opacity,transform,margin]",
        compact ? "ml-0 grid-cols-[0fr] -translate-x-2 opacity-0" : "ml-3 grid-cols-[1fr] translate-x-0 opacity-100",
      )}
    >
      <div className="overflow-hidden whitespace-nowrap leading-tight">
        <span className={cn("block text-base font-bold tracking-tight", light ? "text-white" : "text-foreground")}>
          Lamonica
        </span>
        <span
          className={cn(
            "block text-[0.65rem] font-semibold uppercase tracking-[0.32em]",
            light ? "text-white/65" : "text-muted-foreground",
          )}
        >
          Logistica
        </span>
      </div>
    </div>
  </div>
);

export default Logo;
