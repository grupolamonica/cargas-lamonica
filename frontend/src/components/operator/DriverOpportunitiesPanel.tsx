import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Calendar,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  MessageCircle,
  Sparkles,
  Truck,
} from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { buildWhatsAppAppUrl, shouldPreferDirectWhatsAppAppNavigation } from "@/lib/whatsappLinks";
import {
  fetchDriverOpportunities,
  type DriverOpportunity,
  type DriverOpportunityTrigger,
} from "@/services/readModels";

const TRIGGER_LABELS: Record<DriverOpportunityTrigger, string> = {
  churn: "Recuperação",
  lost_registration: "Cadastro não finalizado",
  abandonment: "Abandono",
  return_load: "Carga de retorno",
  preferences: "Preferências",
};

const SEVERITY_CLASSES: Record<string, string> = {
  high: "admin-tint-danger",
  medium: "admin-tint-warning",
  low: "admin-tint-neutral",
};

interface WizardStep {
  key: string;
  label: string;
}
interface AbandonSignal {
  kind: string;
  label?: string;
  ageHours?: number;
}
interface SuggestedLoad {
  id: string | null;
  origem: string;
  destino: string;
  dateIso: string | null;
  perfil: string | null;
  whatsappUrl: string | null;
}
interface RouteStat {
  key: string;
  count: number;
  label: string;
}
interface PreferencesData {
  suggestedLoads?: SuggestedLoad[];
  topRoutesLoaded?: RouteStat[];
  topRoutesApplied?: RouteStat[];
  loadedCount?: number;
  appliedCount?: number;
}
interface ReturnSuggestion {
  origem: string;
  destino: string;
  dateIso: string | null;
  backToBase?: boolean;
}

function fmtDate(iso: string | null | undefined) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
}

function openWhatsApp(whatsappUrl: string) {
  const userAgent = typeof window !== "undefined" ? window.navigator?.userAgent ?? "" : "";
  if (shouldPreferDirectWhatsAppAppNavigation(userAgent)) {
    const appUrl = buildWhatsAppAppUrl(whatsappUrl);
    if (appUrl) {
      window.location.href = appUrl;
      return;
    }
  }
  window.open(whatsappUrl, "_blank", "noopener,noreferrer");
}

/** Gatilhos com detalhe expansível inline (cadastro, abandono, retorno). */
function hasInlineDetail(trigger: string) {
  return trigger === "lost_registration" || trigger === "abandonment" || trigger === "return_load";
}

interface DriverOpportunitiesPanelProps {
  cpf: string | null;
  nome: string | null;
  phone: string | null;
  /** Só busca quando o modal está aberto — evita fetch desnecessário. */
  enabled: boolean;
}

export default function DriverOpportunitiesPanel({ cpf, nome, phone, enabled }: DriverOpportunitiesPanelProps) {
  const [expanded, setExpanded] = useState<number | null>(null);
  const [prefData, setPrefData] = useState<PreferencesData | null>(null);

  const { data, isLoading, isError } = useQuery({
    queryKey: ["operator", "driver-opportunities", cpf, nome],
    queryFn: () => fetchDriverOpportunities({ cpf, nome, phone }),
    enabled: enabled && Boolean(cpf || nome),
    staleTime: 60_000,
  });

  const opportunities = data?.opportunities ?? [];

  return (
    <section>
      <h4 className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.24em] text-muted-foreground">
        <Sparkles className="h-3.5 w-3.5 text-primary" />
        Oportunidades de contato
      </h4>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Analisando o histórico do motorista…</p>
      ) : isError ? (
        <p className="text-sm text-destructive">Não foi possível carregar as oportunidades.</p>
      ) : opportunities.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nenhuma oportunidade detectada no momento.</p>
      ) : (
        <div className="space-y-2">
          {data?.optedOut ? (
            <p className="text-xs font-medium text-amber-600">
              Motorista optou por não receber mensagens — envio desabilitado.
            </p>
          ) : null}
          {opportunities.map((opp, index) => (
            <OpportunityCard
              key={`${opp.trigger}-${index}`}
              opp={opp}
              open={expanded === index}
              onToggle={() => {
                if (opp.trigger === "preferences") {
                  setPrefData(opp.data as PreferencesData);
                  return;
                }
                if (hasInlineDetail(opp.trigger)) {
                  setExpanded((cur) => (cur === index ? null : index));
                }
              }}
            />
          ))}
        </div>
      )}

      <PreferencesModal
        nome={nome}
        data={prefData}
        open={prefData !== null}
        onOpenChange={(o) => { if (!o) setPrefData(null); }}
      />
    </section>
  );
}

function OpportunityCard({ opp, open, onToggle }: { opp: DriverOpportunity; open: boolean; onToggle: () => void }) {
  const clickable = opp.trigger === "preferences" || hasInlineDetail(opp.trigger);
  const whatsappUrl = opp.whatsappUrl;
  const badgeText = TRIGGER_LABELS[opp.trigger] ?? opp.trigger;
  const badgeClass = SEVERITY_CLASSES[opp.severity] ?? "admin-tint-neutral";

  return (
    <div className="admin-soft-panel overflow-hidden">
      <div
        className={cn("flex items-start justify-between gap-3 px-4 py-3", clickable && "cursor-pointer")}
        onClick={clickable ? onToggle : undefined}
        role={clickable ? "button" : undefined}
        tabIndex={clickable ? 0 : undefined}
        onKeyDown={clickable ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(); } } : undefined}
      >
        <div className="min-w-0">
          <span className={cn("inline-flex rounded-full border px-2.5 py-0.5 text-[11px] font-semibold", badgeClass)}>
            {badgeText}
          </span>
          <p className="mt-1.5 text-sm text-foreground">{opp.reason}</p>
          {clickable ? (
            <p className="mt-1 flex items-center gap-1 text-[11px] font-medium text-primary">
              {opp.trigger === "preferences" ? (
                <>Ver rotas e cargas <ChevronRight className="h-3 w-3" /></>
              ) : (
                <>{open ? "Ocultar" : "Ver detalhes"} <ChevronDown className={cn("h-3 w-3 transition-transform", open && "rotate-180")} /></>
              )}
            </p>
          ) : null}
        </div>
        {whatsappUrl ? (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); openWhatsApp(whatsappUrl); }}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-[linear-gradient(135deg,#16a34a,#22c55e)] px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:brightness-110"
          >
            <MessageCircle className="h-3.5 w-3.5" />
            Enviar
          </button>
        ) : null}
      </div>

      {open && hasInlineDetail(opp.trigger) ? (
        <div className="border-t border-border/60 bg-muted/20 px-4 py-3">
          <OpportunityDetail opp={opp} />
        </div>
      ) : null}
    </div>
  );
}

function OpportunityDetail({ opp }: { opp: DriverOpportunity }) {
  if (opp.trigger === "lost_registration") {
    const d = opp.data as { missingSteps?: WizardStep[]; completedSteps?: WizardStep[] };
    const missing = d.missingSteps ?? [];
    const done = d.completedSteps ?? [];
    return (
      <div className="space-y-3">
        <div>
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Falta enviar</p>
          <ul className="space-y-1">
            {missing.map((s) => (
              <li key={s.key} className="flex items-start gap-2 text-sm text-foreground">
                <Circle className="mt-1 h-3 w-3 shrink-0 text-amber-500" />
                {s.label}
              </li>
            ))}
          </ul>
        </div>
        {done.length ? (
          <div>
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Já enviou</p>
            <ul className="space-y-1">
              {done.map((s) => (
                <li key={s.key} className="flex items-start gap-2 text-xs text-muted-foreground">
                  <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-emerald-500" />
                  {s.label}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    );
  }

  if (opp.trigger === "abandonment") {
    const signals = (opp.data as { signals?: AbandonSignal[] }).signals ?? [];
    return (
      <div>
        <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Tipos de abandono detectados
        </p>
        <ul className="space-y-1">
          {signals.map((s, i) => (
            <li key={`${s.kind}-${i}`} className="flex items-start gap-2 text-sm text-foreground">
              <Circle className="mt-1 h-3 w-3 shrink-0 text-amber-500" />
              <span>
                {s.label ?? s.kind}
                {typeof s.ageHours === "number" ? <span className="text-muted-foreground"> — há {s.ageHours}h</span> : null}
              </span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (opp.trigger === "return_load") {
    const suggestions = (opp.data as { suggestions?: ReturnSuggestion[] }).suggestions ?? [];
    return (
      <ul className="space-y-1.5">
        {suggestions.map((s, i) => (
          <li key={i} className="flex items-center gap-2 text-sm text-foreground">
            <Truck className="h-3.5 w-3.5 shrink-0 text-primary" />
            <span className="min-w-0">
              {s.origem} → {s.destino}
              {s.dateIso ? <span className="text-muted-foreground"> · {fmtDate(s.dateIso)}</span> : null}
              {s.backToBase ? <span className="ml-1 text-[10px] font-semibold text-emerald-600">volta à base</span> : null}
            </span>
          </li>
        ))}
      </ul>
    );
  }

  return null;
}

function RouteList({ title, routes, empty }: { title: string; routes: RouteStat[]; empty: string }) {
  return (
    <div className="admin-soft-panel px-3 py-2.5">
      <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</p>
      {routes.length === 0 ? (
        <p className="text-xs text-muted-foreground">{empty}</p>
      ) : (
        <ul className="space-y-1.5">
          {routes.map((r) => (
            <li key={r.key} className="flex items-start justify-between gap-2 text-sm text-foreground">
              <span className="min-w-0 flex-1 break-words leading-snug">{r.label}</span>
              <span className="mt-0.5 shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">{r.count}x</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PreferencesModal({
  nome,
  data,
  open,
  onOpenChange,
}: {
  nome: string | null;
  data: PreferencesData | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const list = data?.suggestedLoads ?? [];
  const loadedRoutes = data?.topRoutesLoaded ?? [];
  const appliedRoutes = data?.topRoutesApplied ?? [];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto overflow-x-hidden rounded-3xl">
        <DialogHeader>
          <DialogTitle className="text-base">Preferências do motorista</DialogTitle>
          <DialogDescription>
            {nome ? `${nome} — ` : ""}rotas que mais rodou/candidatou e as melhores cargas abertas para ele.
          </DialogDescription>
        </DialogHeader>

        {/* Empilhado (largura total): rotas longas quebram linha em vez de cortar,
            e o modal não gera rolagem horizontal. */}
        {loadedRoutes.length || appliedRoutes.length ? (
          <div className="flex flex-col gap-3">
            <RouteList title="Rotas que mais rodou" routes={loadedRoutes} empty="Sem histórico de cargas carregadas." />
            <RouteList title="Rotas que mais se candidatou" routes={appliedRoutes} empty="Sem candidaturas registradas." />
          </div>
        ) : null}

        <p className="mt-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Melhores cargas abertas para ele
        </p>
        {list.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Nenhuma carga aberta casa com o perfil no momento.
          </p>
        ) : (
          <ul className="space-y-2">
            {list.map((load, i) => (
              <li key={load.id ?? i} className="admin-soft-panel flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="break-words text-sm font-medium leading-snug text-foreground">
                    {load.origem} → {load.destino}
                  </p>
                  <p className="mt-0.5 flex items-center gap-3 text-xs text-muted-foreground">
                    {load.dateIso ? (
                      <span className="inline-flex items-center gap-1"><Calendar className="h-3 w-3" />{fmtDate(load.dateIso)}</span>
                    ) : null}
                    {load.perfil ? <span className="inline-flex items-center gap-1"><Truck className="h-3 w-3" />{load.perfil}</span> : null}
                  </p>
                </div>
                {load.whatsappUrl ? (
                  <button
                    type="button"
                    onClick={() => openWhatsApp(load.whatsappUrl!)}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-[linear-gradient(135deg,#16a34a,#22c55e)] px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:brightness-110"
                  >
                    <MessageCircle className="h-3.5 w-3.5" />
                    Enviar
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
