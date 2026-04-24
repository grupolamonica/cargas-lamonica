import { useState, useEffect } from "react";
import { CalendarIcon, MapPin, Compass, Truck, Activity, TrendingUp } from "lucide-react";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { Link } from "react-router-dom";
import lamonicaLogo from "@/assets/lamonica-logo.png";
import FilterChip from "@/components/FilterChip";
import LoadCard from "@/components/LoadCard";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cargasDetalhadas } from "@/data/cargas";
import { cn } from "@/lib/utils";

const Index = () => {
  const mockCargas = cargasDetalhadas;
  const [dateFrom, setDateFrom] = useState<Date | undefined>(new Date());
  const [dateTo, setDateTo] = useState<Date | undefined>(new Date());
  const [showStickyBar, setShowStickyBar] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      setShowStickyBar(window.scrollY > 280);
    };

    window.addEventListener("scroll", handleScroll, { passive: true });

    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  return (
    <div className="relative min-h-screen bg-background">
      <div className="relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-primary via-primary/90 to-primary/70" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,hsl(var(--accent)/0.25),transparent_60%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_bottom_left,hsl(var(--primary)/0.4),transparent_50%)]" />

        <div
          className="absolute inset-0 opacity-[0.07]"
          style={{
            backgroundImage:
              "url(\"data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%23ffffff' fill-opacity='1'%3E%3Cpath d='M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E\")",
          }}
        />

        <div className="absolute top-6 right-8 h-32 w-32 rounded-full bg-white/[0.08] blur-2xl animate-pulse" />
        <div className="absolute bottom-4 left-4 h-24 w-24 rounded-full bg-accent/20 blur-2xl" />

        <div className="relative mx-auto max-w-2xl px-4 pt-8 pb-7">
          <div className="mb-6 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="relative">
                <img
                  src={lamonicaLogo}
                  alt="Lamonica Logistica"
                  className="h-11 w-11 rounded-2xl object-cover ring-2 ring-white/25 shadow-lg"
                />
                <div className="absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full border-2 border-primary bg-accent shadow-[0_0_8px_hsl(var(--accent)/0.6)]" />
              </div>
              <div>
                <h1 className="text-lg font-extrabold leading-none tracking-tight text-primary-foreground">
                  Lamonica
                </h1>
                <span className="text-[11px] font-semibold tracking-wide text-primary-foreground/60">
                  LOGISTICA
                </span>
              </div>
            </div>

            <div className="flex items-center gap-1.5 rounded-full border border-white/[0.15] bg-white/[0.12] px-3 py-1.5 backdrop-blur-md">
              <div className="relative flex items-center justify-center">
                <Activity className="h-3 w-3 text-accent" />
                <div className="absolute inset-0 animate-ping">
                  <Activity className="h-3 w-3 text-accent/50" />
                </div>
              </div>
              <span className="text-[11px] font-bold text-primary-foreground/90">Ao vivo</span>
            </div>
          </div>

          <div className="mb-5 grid grid-cols-3 gap-2.5">
            <div className="rounded-2xl border border-white/[0.12] bg-white/[0.1] px-3 py-3 text-center backdrop-blur-md">
              <span className="block text-xl font-extrabold leading-none text-primary-foreground">
                {mockCargas.length}
              </span>
              <span className="mt-1 block text-[10px] font-semibold uppercase tracking-wider text-primary-foreground/55">
                Cargas
              </span>
            </div>
            <div className="rounded-2xl border border-white/[0.12] bg-white/[0.1] px-3 py-3 text-center backdrop-blur-md">
              <div className="flex items-center justify-center gap-1">
                <TrendingUp className="h-3.5 w-3.5 text-accent" />
                <span className="text-xl font-extrabold leading-none text-primary-foreground">+12%</span>
              </div>
              <span className="mt-1 block text-[10px] font-semibold uppercase tracking-wider text-primary-foreground/55">
                vs ontem
              </span>
            </div>
            <div className="rounded-2xl border border-white/[0.12] bg-white/[0.1] px-3 py-3 text-center backdrop-blur-md">
              <span className="block text-xl font-extrabold leading-none text-primary-foreground">4</span>
              <span className="mt-1 block text-[10px] font-semibold uppercase tracking-wider text-primary-foreground/55">
                Estados
              </span>
            </div>
          </div>

          <p className="text-center text-sm font-medium text-primary-foreground/70">
            Cargas disponiveis em tempo real
          </p>

          <div className="mt-5 flex justify-center">
            <Button
              asChild
              variant="outline"
              className="rounded-2xl border-white/15 bg-white/[0.12] text-primary-foreground hover:bg-white/[0.18] hover:text-primary-foreground"
            >
              <Link to="/operador">Abrir painel do operador</Link>
            </Button>
          </div>
        </div>

        <div className="absolute bottom-0 left-0 right-0">
          <svg
            viewBox="0 0 1440 40"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            className="h-5 w-full"
            preserveAspectRatio="none"
          >
            <path d="M0 40V20C360 0 1080 0 1440 20V40H0Z" fill="hsl(var(--background))" />
          </svg>
        </div>
      </div>

      <div className="relative mx-auto max-w-2xl px-3 py-6 sm:px-4 sm:py-10">
        <div className="glass-surface mb-6 rounded-2xl p-2.5 sm:mb-8 sm:rounded-3xl sm:p-3 premium-shadow">
          <div className="grid grid-cols-2 gap-2 sm:flex sm:items-center sm:gap-2.5">
            <FilterChip
              label="Origem"
              value="SP"
              active
              icon={<MapPin className="h-3.5 w-3.5" />}
            />
            <FilterChip
              label="Destino"
              value="RS"
              active
              icon={<Compass className="h-3.5 w-3.5" />}
            />
            <FilterChip
              label="Veiculo"
              value="Carreta"
              icon={<Truck className="h-3.5 w-3.5" />}
            />

            <Popover>
              <PopoverTrigger asChild>
                <button
                  className={cn(
                    "group relative flex items-center gap-2 rounded-xl border border-border/60 bg-card px-3 py-2.5 text-sm transition-all duration-300 ease-out sm:gap-2.5 sm:rounded-2xl sm:px-4 sm:py-3",
                    "hover:-translate-y-0.5 hover:border-primary/25 hover:premium-shadow",
                    "focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/30",
                    "active:translate-y-0 active:shadow-sm",
                  )}
                >
                  <span className="flex h-7 w-7 items-center justify-center rounded-xl bg-badge text-primary transition-colors duration-200 group-hover:bg-primary/15">
                    <CalendarIcon className="h-3.5 w-3.5" />
                  </span>
                  <div className="flex flex-col items-start gap-0.5">
                    <span className="text-[10px] font-semibold uppercase leading-none tracking-widest text-muted-foreground">
                      Periodo
                    </span>
                    <span className="text-xs font-bold leading-none text-card-foreground sm:text-sm">
                      {dateFrom ? format(dateFrom, "dd/MM", { locale: ptBR }) : "Inicio"}
                      {" - "}
                      {dateTo ? format(dateTo, "dd/MM", { locale: ptBR }) : "Fim"}
                    </span>
                  </div>
                </button>
              </PopoverTrigger>
              <PopoverContent
                className="w-auto rounded-2xl border-border/40 p-0 premium-shadow"
                align="start"
                side="bottom"
              >
                <div className="flex flex-col sm:flex-row">
                  <div className="border-b border-border/40 p-2.5 sm:border-b-0 sm:border-r sm:p-3">
                    <p className="mb-1 px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Inicio
                    </p>
                    <Calendar
                      mode="single"
                      selected={dateFrom}
                      onSelect={setDateFrom}
                      initialFocus
                      className={cn("pointer-events-auto p-1.5 sm:p-2")}
                    />
                  </div>
                  <div className="p-2.5 sm:p-3">
                    <p className="mb-1 px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Fim
                    </p>
                    <Calendar
                      mode="single"
                      selected={dateTo}
                      onSelect={setDateTo}
                      className={cn("pointer-events-auto p-1.5 sm:p-2")}
                    />
                  </div>
                </div>
              </PopoverContent>
            </Popover>
          </div>
        </div>

        <div className="mb-6 flex items-center gap-3">
          <h2 className="text-xs font-extrabold uppercase tracking-[0.2em] text-muted-foreground">
            Cargas disponiveis
          </h2>
          <span className="inline-flex h-6 min-w-[28px] items-center justify-center rounded-lg bg-primary/10 px-2 text-xs font-extrabold text-primary">
            {mockCargas.length}
          </span>
          <div className="h-px flex-1 bg-gradient-to-r from-border/60 to-transparent" />
        </div>

        <div className="space-y-5">
          {mockCargas.map((carga, index) => (
            <LoadCard key={carga.id} {...carga} index={index} />
          ))}
        </div>
      </div>

      <div
        className={cn(
          "fixed left-0 right-0 top-0 z-50 flex justify-center py-3 transition-all duration-500 ease-out",
          showStickyBar
            ? "translate-y-0 opacity-100"
            : "pointer-events-none -translate-y-full opacity-0",
        )}
      >
        <div className="flex items-center gap-3 rounded-full border border-border/50 bg-card/80 px-5 py-2.5 backdrop-blur-xl premium-shadow">
          <div className="relative flex items-center justify-center">
            <div className="h-2.5 w-2.5 rounded-full bg-accent" />
            <div className="absolute inset-0 h-2.5 w-2.5 rounded-full bg-accent opacity-50 animate-ping" />
          </div>
          <span className="text-sm font-bold text-foreground">SP</span>
          <div className="flex items-center gap-1.5 text-muted-foreground">
            <div className="h-px w-8 bg-border" />
            <Truck className="h-4 w-4 text-primary" />
            <div className="h-px w-8 bg-border" />
          </div>
          <span className="text-sm font-bold text-foreground">RS</span>
        </div>
      </div>
    </div>
  );
};

export default Index;
