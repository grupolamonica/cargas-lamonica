import { useAuth } from "@/hooks/useAuth";
import { getOperatorDisplayName, getOperatorInitials } from "@/lib/operatorIdentity";

interface DashboardHeaderProps {
  title: string;
  subtitle?: string;
}

const DashboardHeader = ({ title, subtitle }: DashboardHeaderProps) => {
  const { user } = useAuth();
  const operatorName = getOperatorDisplayName(user?.email);
  const operatorInitials = getOperatorInitials(operatorName);

  return (
    <header className="sticky top-0 z-20">
      <div className="px-6 pt-6 lg:px-8 lg:pt-8">
        <div className="admin-hero-panel relative overflow-hidden px-6 py-5">
          {/* Brilho decorativo */}
          <div className="pointer-events-none absolute right-0 top-0 h-full w-64 bg-[radial-gradient(ellipse_at_top_right,rgba(2,36,131,0.06),transparent_70%)]" />

          <div className="relative flex min-w-0 items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-[0.68rem] font-semibold uppercase tracking-[0.32em] text-primary/56">
                Painel Lamonica
              </p>
              <h1 className="mt-1.5 truncate text-2xl font-semibold tracking-tight text-foreground lg:text-[1.85rem]">
                {title}
              </h1>
              {subtitle && (
                <p className="mt-1 truncate text-sm text-muted-foreground">{subtitle}</p>
              )}
            </div>

            <div className="admin-card-surface flex shrink-0 items-center gap-3 rounded-2xl border px-3.5 py-2.5 shadow-[0_12px_28px_-20px_rgba(2,36,131,0.28)] backdrop-blur-xl">
              <div className="hidden flex-col items-end sm:flex">
                <span className="text-xs font-semibold text-foreground leading-tight">{operatorName}</span>
                <span className="text-[0.65rem] font-medium uppercase tracking-[0.2em] text-muted-foreground">
                  Operador
                </span>
              </div>
              <div className="relative flex h-10 w-10 items-center justify-center rounded-full bg-[linear-gradient(135deg,#3b5fe8,#0d47d9)] text-sm font-bold text-white shadow-[0_8px_18px_rgba(2,36,131,0.22)]">
                {operatorInitials}
                <span className="absolute bottom-0 right-0 h-3 w-3 rounded-full border-2 border-white bg-emerald-500" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </header>
  );
};

export default DashboardHeader;
