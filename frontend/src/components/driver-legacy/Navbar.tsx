import { BellRing } from "lucide-react";
import lamonicaLogoBlue from "@/assets/lamonica-logo-blue.png";

interface DriverLegacyNavbarProps {
  cadastroHref: string;
  onDuvidasClick: () => void;
  onNotificationsClick: () => void;
  notificationCount: number;
}

export default function DriverLegacyNavbar({
  cadastroHref,
  onDuvidasClick,
  onNotificationsClick,
  notificationCount,
}: DriverLegacyNavbarProps) {
  return (
    <header className="grid grid-cols-3 items-center gap-3 rounded-2xl bg-white px-4 py-3 shadow-md sm:px-8 sm:py-4">
      <div className="-ml-1 flex items-center gap-3 justify-self-start sm:-ml-3">
        <img
          src={lamonicaLogoBlue}
          alt="Lamonica Logistica"
          className="h-10 w-auto object-contain sm:h-12"
        />
        <span aria-hidden className="hidden h-6 w-px bg-gray-200 sm:block" />
        <p className="hidden text-[10px] font-semibold uppercase tracking-[0.22em] text-gray-500 sm:block">
          Portal do motorista
        </p>
      </div>

      <nav className="hidden justify-center gap-8 justify-self-center font-medium text-gray-600 md:flex md:-translate-x-6 lg:gap-12 lg:-translate-x-12">
        <a
          href={cadastroHref}
          target="_blank"
          rel="noreferrer"
          className="transition-colors hover:text-[hsl(224_94%_37%)]"
        >
          Cadastro
        </a>
        <button
          type="button"
          className="transition-colors hover:text-[hsl(224_94%_37%)]"
        >
          Suporte
        </button>
        <button
          type="button"
          onClick={onDuvidasClick}
          className="transition-colors hover:text-[hsl(224_94%_37%)]"
        >
          Dúvidas
        </button>
      </nav>

      <button
        type="button"
        onClick={onNotificationsClick}
        className="relative inline-flex h-10 w-10 items-center justify-center justify-self-end rounded-full text-gray-600 transition-colors hover:bg-gray-100"
        aria-label="Notificações"
      >
        <BellRing className="h-5 w-5" />
        {notificationCount > 0 ? (
          <span className="absolute -right-0.5 -top-0.5 inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-red-500 px-1.5 text-[11px] font-bold text-white">
            {notificationCount}
          </span>
        ) : null}
      </button>
    </header>
  );
}
