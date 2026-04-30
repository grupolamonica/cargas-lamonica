import { BellRing } from "lucide-react";
import lamonicaLogo from "@/assets/lamonica-logo-navbar.png";

interface DriverPortalNavbarProps {
  notificationCount: number;
  onNotificationsOpen: () => void;
  cadastroHref: string;
  onFaqOpen: () => void;
  supportHref: string;
}

export default function DriverPortalNavbar({
  notificationCount,
  onNotificationsOpen,
  cadastroHref,
  onFaqOpen,
  supportHref,
}: DriverPortalNavbarProps) {
  return (
    <div className="relative z-10 hidden lg:block px-4 lg:px-6 pt-4">
      <nav className="mx-auto max-w-7xl flex items-center justify-between px-6 py-3.5 relative overflow-hidden rounded-2xl bg-gradient-to-r from-[#1128b8] via-[#1635cc] to-[#1e42d4] shadow-[0_12px_48px_rgba(3,3,181,0.5),0_2px_10px_rgba(0,0,0,0.3),inset_0_1px_0_rgba(255,255,255,0.14)] ring-1 ring-white/[0.1]">

        {/* top edge highlight */}
        <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/50 to-transparent" />

        {/* bottom edge shadow line */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-black/20" />

        {/* Left: logo + separator */}
        <div className="flex items-center gap-6">
          <img
            src={lamonicaLogo}
            alt="Lamonica Logistica"
            className="h-10 w-auto object-contain drop-shadow-[0_1px_4px_rgba(0,0,0,0.25)]"
          />
          <div className="h-6 w-px bg-white/[0.15]" />
        </div>

        {/* Center: nav links inside frosted pill */}
        <div className="flex items-center gap-0.5 rounded-full bg-white/[0.07] px-1 py-1 ring-1 ring-white/[0.08]">
          <a
            href={cadastroHref}
            target="_blank"
            rel="noreferrer"
            className="px-4 py-1.5 rounded-full text-[13px] font-medium tracking-wide transition-all duration-150 text-white/70 hover:text-white hover:bg-white/[0.13]"
          >
            Cadastro
          </a>
          <a
            href={supportHref}
            target="_blank"
            rel="noreferrer"
            className="px-4 py-1.5 rounded-full text-[13px] font-medium tracking-wide transition-all duration-150 text-white/70 hover:text-white hover:bg-white/[0.13]"
          >
            Suporte
          </a>
          <button
            type="button"
            onClick={onFaqOpen}
            className="px-4 py-1.5 rounded-full text-[13px] font-medium tracking-wide transition-all duration-150 text-white/70 hover:text-white hover:bg-white/[0.13]"
          >
            Dúvidas
          </button>
        </div>

        {/* Right: notification button — distinct solid pill */}
        <button
          type="button"
          onClick={onNotificationsOpen}
          aria-label={
            notificationCount > 0
              ? `Notificações (${notificationCount})`
              : "Notificações"
          }
          className="relative flex items-center gap-2 rounded-full bg-white/[0.12] pl-3.5 pr-5 py-2 text-[13px] font-semibold tracking-wide text-white ring-1 ring-white/[0.18] transition-all duration-150 hover:bg-white/[0.22] hover:ring-white/[0.28] hover:shadow-[0_0_16px_rgba(255,255,255,0.15)]"
        >
          <BellRing className="h-4 w-4 shrink-0" />
          <span>Notificações</span>
          {notificationCount > 0 && (
            <span className="absolute -right-1 -top-1 flex h-[18px] w-[18px] items-center justify-center rounded-full bg-red-500 text-[9px] font-bold text-white leading-none shadow-[0_0_8px_rgba(239,68,68,0.6)]">
              {notificationCount > 9 ? "9+" : notificationCount}
            </span>
          )}
        </button>
      </nav>
    </div>
  );
}
