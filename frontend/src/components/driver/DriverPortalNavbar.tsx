import { BellRing } from "lucide-react";
import lamonicaLogo from "@/assets/lamonica-logo-blue.png";

interface DriverPortalNavbarProps {
  notificationCount: number;
  onNotificationsOpen: () => void;
  onCadastroClick: () => void;
  onFaqOpen: () => void;
  supportHref: string;
}

export default function DriverPortalNavbar({
  notificationCount,
  onNotificationsOpen,
  onCadastroClick,
  onFaqOpen,
  supportHref,
}: DriverPortalNavbarProps) {
  return (
    <div className="hidden lg:block px-4 lg:px-6 pt-4 pb-2">
      <header className="mx-auto max-w-7xl grid grid-cols-3 items-center gap-3 rounded-2xl bg-white px-6 py-3.5 shadow-md">
        {/* Left: logo + separator + subtitle */}
        <div className="-ml-1 flex items-center gap-3 justify-self-start">
          <img
            src={lamonicaLogo}
            alt="Lamonica Logistica"
            className="h-10 w-auto object-contain sm:h-12"
          />
          <span aria-hidden className="h-6 w-px bg-gray-200" />
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-gray-500">
            Portal do motorista
          </p>
        </div>

        {/* Center: nav links */}
        <nav className="flex justify-center gap-8 font-medium text-gray-600">
          <button
            type="button"
            onClick={onCadastroClick}
            className="transition-colors hover:text-[hsl(224,94%,37%)]"
          >
            Cadastro
          </button>
          <a
            href={supportHref}
            target="_blank"
            rel="noreferrer"
            className="transition-colors hover:text-[hsl(224,94%,37%)]"
          >
            Suporte
          </a>
          <button
            type="button"
            onClick={onFaqOpen}
            className="transition-colors hover:text-[hsl(224,94%,37%)]"
          >
            Dúvidas
          </button>
        </nav>

        {/* Right: notification bell */}
        <button
          type="button"
          onClick={onNotificationsOpen}
          className="relative inline-flex h-10 w-10 items-center justify-center justify-self-end rounded-full text-gray-600 transition-colors hover:bg-gray-100"
          aria-label={notificationCount > 0 ? `Notificações (${notificationCount})` : "Notificações"}
        >
          <BellRing className="h-5 w-5" />
          {notificationCount > 0 ? (
            <span className="absolute -right-0.5 -top-0.5 inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-red-500 px-1.5 text-[11px] font-bold text-white">
              {notificationCount > 9 ? "9+" : notificationCount}
            </span>
          ) : null}
        </button>
      </header>
    </div>
  );
}
