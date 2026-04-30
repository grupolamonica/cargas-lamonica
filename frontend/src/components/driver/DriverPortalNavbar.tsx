import { BellRing } from "lucide-react";
import { cn } from "@/lib/utils";
import lamonicaLogo from "@/assets/lamonica-logo.png";

interface DriverPortalNavbarProps {
  notificationCount: number;
  onNotificationsOpen: () => void;
  activeTab: "inicio" | "cargas";
  onTabChange: (tab: "inicio" | "cargas") => void;
  cadastroHref: string;
  onFaqOpen: () => void;
  supportHref: string;
}

export default function DriverPortalNavbar({
  notificationCount,
  onNotificationsOpen,
  activeTab,
  onTabChange,
  cadastroHref,
  onFaqOpen,
  supportHref,
}: DriverPortalNavbarProps) {
  return (
    <nav className="hidden lg:flex items-center justify-between px-6 py-3 bg-[hsl(225_52%_10%)] border-b border-white/[0.10]">
      {/* Left: logo + title */}
      <div className="flex items-center gap-3">
        <img
          src={lamonicaLogo}
          alt="Lamonica Logistica"
          className="h-9 w-9 rounded-xl object-cover"
        />
        <div>
          <span className="block text-[13px] font-bold leading-none text-white">
            LAMONICA LOGISTICA
          </span>
          <span className="block text-[10px] font-medium uppercase tracking-[0.18em] text-white/60 mt-0.5">
            Portal do Motorista
          </span>
        </div>
      </div>

      {/* Center: separator + tabs */}
      <div className="flex items-center gap-1">
        <div className="mr-3 h-4 w-px bg-white/20" />
        <button
          type="button"
          onClick={() => onTabChange("inicio")}
          className={cn(
            "px-4 py-1.5 rounded-full text-sm font-semibold transition-colors",
            activeTab === "inicio"
              ? "bg-white/[0.15] text-white"
              : "text-white/70 hover:text-white hover:bg-white/[0.08]",
          )}
        >
          Inicio
        </button>
        <button
          type="button"
          onClick={() => onTabChange("cargas")}
          className={cn(
            "px-4 py-1.5 rounded-full text-sm font-semibold transition-colors",
            activeTab === "cargas"
              ? "bg-white/[0.15] text-white"
              : "text-white/70 hover:text-white hover:bg-white/[0.08]",
          )}
        >
          Cargas
        </button>
      </div>

      {/* Right: action buttons */}
      <div className="flex items-center gap-2">
        {/* Notification bell */}
        <button
          type="button"
          onClick={onNotificationsOpen}
          className="relative flex h-9 w-9 items-center justify-center rounded-full bg-white/[0.10] hover:bg-white/[0.18] transition-colors border border-white/[0.14]"
          aria-label={
            notificationCount > 0
              ? `Abrir notificacoes (${notificationCount})`
              : "Abrir notificacoes"
          }
        >
          <BellRing className="h-4 w-4 text-white/80" />
          {notificationCount > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-accent text-[9px] font-bold text-white leading-none">
              {notificationCount > 9 ? "9+" : notificationCount}
            </span>
          )}
        </button>

        {/* Cadastro */}
        <a
          href={cadastroHref}
          target="_blank"
          rel="noreferrer"
          className="flex h-8 items-center rounded-full bg-white/[0.12] px-4 text-xs font-semibold text-white/90 hover:bg-white/[0.20] hover:text-white transition-colors border border-white/[0.18]"
        >
          Cadastro
        </a>

        {/* Suporte */}
        <a
          href={supportHref}
          target="_blank"
          rel="noreferrer"
          className="flex h-8 items-center rounded-full bg-white/[0.12] px-4 text-xs font-semibold text-white/90 hover:bg-white/[0.20] hover:text-white transition-colors border border-white/[0.18]"
        >
          Suporte
        </a>

        {/* Duvidas */}
        <button
          type="button"
          onClick={onFaqOpen}
          className="flex h-8 items-center rounded-full bg-white/[0.12] px-4 text-xs font-semibold text-white/90 hover:bg-white/[0.20] hover:text-white transition-colors border border-white/[0.18]"
        >
          Duvidas
        </button>
      </div>
    </nav>
  );
}
