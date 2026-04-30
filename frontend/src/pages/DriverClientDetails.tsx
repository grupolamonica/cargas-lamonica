import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  BadgeCheck,
  CircleDashed,
  Clock3,
  CreditCard,
  IdCard,
  MessageSquare,
  Package,
  Search,
  Shield,
  Sparkles,
  Truck,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { format, parseISO } from "date-fns";
import { ptBR } from "date-fns/locale";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import ClientLogo from "@/components/ClientLogo";
import { cn } from "@/lib/utils";
import { publicSupabase } from "@/integrations/supabase/public-client";

interface ClientRow {
  id: string;
  nome: string;
  descricao: string | null;
  logo_url: string | null;
  forma_pagamento: string | null;
  prazo_pagamento: string | null;
  exige_antt: boolean;
  exige_carga_monitorada: boolean;
  exige_rastreamento: boolean;
  exige_seguro: boolean;
  reputacao_boa_comunicacao: boolean;
  reputacao_bom_pagador: boolean;
  reputacao_carga_organizada: boolean;
  reputacao_liberacao_rapida: boolean;
  reputacao_pagamento_rapido: boolean;
}

interface ClientLoadRow {
  id: string;
  data: string;
  horario: string;
  origem: string;
  destino: string;
  perfil: string;
  valor: number | null;
}

const CLIENT_SELECT =
  "id, nome, descricao, logo_url, forma_pagamento, prazo_pagamento, exige_antt, exige_carga_monitorada, exige_rastreamento, exige_seguro, reputacao_boa_comunicacao, reputacao_bom_pagador, reputacao_carga_organizada, reputacao_liberacao_rapida, reputacao_pagamento_rapido";
const CLIENT_FALLBACK_SELECT =
  "id, nome, descricao, forma_pagamento, prazo_pagamento, exige_antt, exige_carga_monitorada, exige_rastreamento, exige_seguro, reputacao_boa_comunicacao, reputacao_bom_pagador, reputacao_carga_organizada, reputacao_liberacao_rapida, reputacao_pagamento_rapido";
const CLIENT_ACTIVE_LOADS_SELECT = "id, data, horario, origem, destino, perfil, valor";

function isMissingClienteLogoColumnError(error: { message?: string; details?: string } | null) {
  const combinedMessage = `${error?.message || ""} ${error?.details || ""}`.toLowerCase();
  return combinedMessage.includes("logo_url");
}

function isMissingDriverVisibilityColumnError(error: { message?: string; details?: string } | null) {
  const combinedMessage = `${error?.message || ""} ${error?.details || ""}`.toLowerCase();
  return combinedMessage.includes("driver_visibility");
}

function formatMaybeText(value: string | null | undefined) {
  const trimmedValue = value?.trim();
  return trimmedValue ? trimmedValue : "Não informado";
}

function formatCurrency(value: number | null) {
  if (value === null) {
    return "A combinar";
  }

  return value.toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

function formatDate(value: string) {
  return format(parseISO(value), "dd/MM/yyyy", { locale: ptBR });
}

const requirementOptions = [
  { key: "exige_rastreamento", label: "Rastreamento", icon: Search },
  { key: "exige_antt", label: "ANTT", icon: IdCard },
  { key: "exige_seguro", label: "Seguro", icon: Shield },
  { key: "exige_carga_monitorada", label: "Carga monitorada", icon: Truck },
] as const;

const reputationOptions = [
  { key: "reputacao_pagamento_rapido", label: "Pagamento rápido", icon: Clock3 },
  { key: "reputacao_bom_pagador", label: "Bom pagador", icon: CreditCard },
  { key: "reputacao_liberacao_rapida", label: "Liberação rápida", icon: Zap },
  { key: "reputacao_carga_organizada", label: "Carga organizada", icon: Package },
  { key: "reputacao_boa_comunicacao", label: "Boa comunicação", icon: MessageSquare },
] as const;

function DetailField({
  icon: Icon,
  label,
  value,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-2xl border border-border/60 bg-background/75 px-4 py-3 shadow-[0_10px_30px_-22px_hsl(215_25%_12%/0.18)]">
      <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
        <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Icon className="h-3.5 w-3.5" />
        </span>
        {label}
      </div>
      <p className="mt-2 text-sm font-semibold leading-snug text-foreground">{value}</p>
    </div>
  );
}

function SignalCard({
  icon: Icon,
  label,
  active,
}: {
  icon: LucideIcon;
  label: string;
  active: boolean;
}) {
  return (
    <div
      className={cn(
        "min-h-[122px] rounded-[20px] border p-3 transition-all duration-200 sm:min-h-[166px] sm:rounded-[24px] sm:p-4",
        active
          ? "border-[hsl(224_94%_37%/0.25)] bg-[linear-gradient(135deg,hsl(223_56%_12%),hsl(223_55%_22%))] text-white shadow-[0_18px_36px_-28px_hsl(223_55%_18%/0.72)]"
          : "admin-card-surface text-foreground shadow-[0_10px_28px_-24px_hsl(215_25%_12%/0.18)]",
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <div
          className={cn(
            "flex h-8 w-8 shrink-0 items-center justify-center rounded-xl sm:h-10 sm:w-10 sm:rounded-2xl",
            active ? "bg-white/14 text-white" : "bg-primary/10 text-primary",
          )}
        >
          <Icon className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
        </div>

        <span
          className={cn(
            "inline-flex h-7 w-7 items-center justify-center rounded-full sm:h-8 sm:w-8",
            active ? "bg-white/12 text-white" : "bg-muted/55 text-muted-foreground",
          )}
          aria-hidden="true"
        >
          {active ? <BadgeCheck className="h-3 w-3 sm:h-3.5 sm:w-3.5" /> : <CircleDashed className="h-3 w-3 sm:h-3.5 sm:w-3.5" />}
        </span>
      </div>

      <p className={cn("mt-3 text-[0.88rem] font-semibold leading-snug sm:mt-4 sm:text-sm", active ? "text-white" : "text-foreground")}>{label}</p>
      <p className={cn("mt-1 text-xs leading-5 sm:text-sm sm:leading-6", active ? "text-white/76" : "text-muted-foreground")}><span className="sm:hidden">{active ? "Confirmado no cadastro." : "Não informado."}</span><span className="hidden sm:inline">
        {active ? "Informação confirmada para este cliente." : "Esse item não foi informado para este cliente."}
      </span></p>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="driver-theme min-h-screen bg-[radial-gradient(circle_at_top_left,hsl(224_100%_96%),transparent_40%),linear-gradient(180deg,hsl(220_30%_97%),hsl(220_22%_94%))] px-4 py-6 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-6xl space-y-6">
        <div className="admin-card-surface rounded-[32px] border p-6 shadow-[0_30px_60px_-34px_hsl(215_25%_12%/0.28)]">
          <Skeleton className="h-5 w-32 rounded-full" />
          <Skeleton className="mt-5 h-12 w-3/5 rounded-2xl" />
          <Skeleton className="mt-3 h-5 w-4/5 rounded-full" />
        </div>
        <div className="grid gap-6 xl:grid-cols-[1.08fr_0.92fr]">
          <Skeleton className="h-[250px] rounded-[28px]" />
          <Skeleton className="h-[250px] rounded-[28px]" />
        </div>
        <div className="grid gap-6 xl:grid-cols-2">
          <Skeleton className="h-[240px] rounded-[28px]" />
          <Skeleton className="h-[240px] rounded-[28px]" />
        </div>
        <Skeleton className="h-[380px] rounded-[28px]" />
      </div>
    </div>
  );
}

function ErrorState({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="driver-theme min-h-screen bg-[radial-gradient(circle_at_top_left,hsl(224_100%_96%),transparent_40%),linear-gradient(180deg,hsl(220_30%_97%),hsl(220_22%_94%))] px-4 py-6 sm:px-6 lg:px-8">
      <div className="mx-auto flex min-h-[70vh] max-w-3xl items-center justify-center">
        <Card className="admin-panel w-full overflow-hidden">
          <CardHeader className="space-y-4 text-center">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
              <Sparkles className="h-6 w-6" />
            </div>
            <CardTitle className="text-2xl tracking-tight text-foreground">{title}</CardTitle>
            <CardDescription className="text-sm leading-relaxed">{description}</CardDescription>
          </CardHeader>
          <CardContent className="flex justify-center pb-6">
            <Button asChild className="rounded-full px-5 font-semibold">
              <Link to="/motorista">
                <ArrowLeft className="h-4 w-4" />
                Voltar para cargas
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

const DriverClientDetails = () => {
  const { clienteId } = useParams();
  const normalizedClienteId = clienteId?.trim() || "";

  const clientQuery = useQuery({
    queryKey: ["driver", "cliente", normalizedClienteId],
    enabled: Boolean(normalizedClienteId),
    queryFn: async () => {
      const { data, error } = await publicSupabase
        .from("clientes")
        .select(CLIENT_SELECT)
        .eq("id", normalizedClienteId)
        .maybeSingle();

      if (error && isMissingClienteLogoColumnError(error)) {
        const fallbackResult = await publicSupabase
          .from("clientes")
          .select(CLIENT_FALLBACK_SELECT)
          .eq("id", normalizedClienteId)
          .maybeSingle();

        if (fallbackResult.error) {
          throw fallbackResult.error;
        }

        if (!fallbackResult.data) {
          throw new Error("Cliente não encontrado");
        }

        return fallbackResult.data as ClientRow;
      }

      if (error) {
        throw error;
      }

      if (!data) {
        throw new Error("Cliente não encontrado");
      }

      return data as ClientRow;
    },
  });

  const loadsQuery = useQuery({
    queryKey: ["driver", "cliente-loads", normalizedClienteId],
    enabled: Boolean(normalizedClienteId),
    queryFn: async () => {
      const buildClientLoadsQuery = (includeDriverVisibilityFilter: boolean) => {
        let query = publicSupabase
          .from("cargas")
          .select(CLIENT_ACTIVE_LOADS_SELECT)
          .eq("cliente_id", normalizedClienteId)
          .eq("status", "OPEN")
          .eq("is_template", false)
          // Exclui cargas que j\u00e1 foram reservadas por algum lead/claim ativo —
          // essas n\u00e3o est\u00e3o mais dispon\u00edveis para o motorista, mesmo permanecendo em OPEN.
          .is("reserved_public_lead_id", null)
          .is("reserved_claim_id", null);

        if (includeDriverVisibilityFilter) {
          query = query.eq("driver_visibility", "PUBLIC");
        }

        return query.order("data", { ascending: true }).order("horario", { ascending: true });
      };

      let response = await buildClientLoadsQuery(true);

      if (response.error && isMissingDriverVisibilityColumnError(response.error)) {
        response = await buildClientLoadsQuery(false);
      }

      const { data, error } = response;

      if (error) {
        throw error;
      }

      return (data || []) as ClientLoadRow[];
    },
  });

  const isLoading = clientQuery.isLoading || loadsQuery.isLoading;
  const activeLoads = loadsQuery.data || [];
  const activeLoadsCount = activeLoads.length;

  const requirementFlags = useMemo(() => {
    if (!clientQuery.data) {
      return [];
    }

    return requirementOptions.map((option) => ({
      ...option,
      active: clientQuery.data[option.key],
    }));
  }, [clientQuery.data]);

  const reputationFlags = useMemo(() => {
    if (!clientQuery.data) {
      return [];
    }

    return reputationOptions.map((option) => ({
      ...option,
      active: clientQuery.data[option.key],
    }));
  }, [clientQuery.data]);

  if (!normalizedClienteId) {
    return (
      <ErrorState
        title="Cliente inválido"
        description="Não consegui identificar o cliente selecionado. Volte para a lista de cargas e tente novamente."
      />
    );
  }

  if (isLoading) {
    return <LoadingState />;
  }

  if (clientQuery.error || !clientQuery.data) {
    return (
      <ErrorState
        title="Não foi possível abrir este cliente"
        description="Este cliente não está disponível no momento ou ainda não possui carga vinculada."
      />
    );
  }

  const client = clientQuery.data;

  return (
    <div className="driver-theme min-h-screen bg-[radial-gradient(circle_at_top_left,hsl(224_100%_96%),transparent_40%),linear-gradient(180deg,hsl(220_30%_97%),hsl(220_22%_94%))] px-4 py-6 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-6xl space-y-6">
        <section className="relative overflow-hidden rounded-[32px] border border-white/70 bg-[linear-gradient(135deg,hsl(223_56%_12%),hsl(223_55%_22%))] p-5 text-white shadow-[0_30px_70px_-30px_hsl(215_25%_12%/0.55)] sm:p-8">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,hsl(225_100%_65%/0.18),transparent_36%),radial-gradient(circle_at_bottom_left,hsl(200_100%_55%/0.14),transparent_30%)]" />
          <div className="relative space-y-5">
            <Button
              asChild
              variant="outline"
              className="h-10 w-fit rounded-full border-white/20 bg-white/10 px-4 text-white hover:bg-white/15 hover:text-white"
            >
              <Link to="/motorista">
                <ArrowLeft className="h-4 w-4" />
                Voltar para cargas
              </Link>
            </Button>

            <div className="grid grid-cols-[minmax(0,1fr)_74px] items-start gap-x-2 gap-y-3 sm:grid-cols-[minmax(0,1fr)_148px] sm:gap-x-5 sm:gap-y-4 lg:grid-cols-[minmax(0,1fr)_168px] lg:gap-x-8">
              <div className="min-w-0 space-y-4 pl-1 pr-0.5 sm:space-y-5 sm:pl-4 sm:pr-4">
                <div className="inline-flex w-fit items-center gap-2 rounded-full border border-white/15 bg-white/10 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.22em] text-white/75">
                  Ficha do cliente
                </div>

                <h1 className="break-words text-2xl font-black tracking-tight text-white sm:max-w-[30rem] sm:text-4xl">
                  {client.nome}
                </h1>
              </div>

              <div className="justify-self-end self-start -mt-12 sm:-mt-14 lg:-mt-16">
                <ClientLogo
                  name={client.nome}
                  logoUrl={client.nome?.toLowerCase() === "shopee" ? "/brand-logos/shopee.png" : client.logo_url}
                  className="h-[74px] w-[74px] border-white/15 bg-white/95 sm:h-[148px] sm:w-[148px] lg:h-[168px] lg:w-[168px]"
                  imageClassName="p-1.5 sm:p-4 scale-[1.02]"
                  fallbackClassName="text-white"
                />
              </div>

              {client.descricao?.trim() ? (
                <p className="col-span-2 pl-1 pr-0.5 text-sm leading-relaxed text-white/82 sm:col-span-1 sm:pl-4 sm:pr-1 sm:text-base">
                  {client.descricao}
                </p>
              ) : null}
            </div>
          </div>
        </section>

        <section className="grid gap-6">
          <Card className="admin-panel overflow-hidden">
            <CardHeader className="space-y-2 p-6 pb-4">
              <CardDescription className="text-xs font-semibold uppercase tracking-[0.24em] text-primary/60">
                Informações do cliente
              </CardDescription>
              <CardTitle className="text-2xl tracking-tight text-foreground">Condições informadas</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3 px-6 pb-6 sm:grid-cols-2">
              <DetailField icon={CreditCard} label="Forma de pagamento" value={formatMaybeText(client.forma_pagamento)} />
              <DetailField icon={Clock3} label="Prazo de pagamento" value={formatMaybeText(client.prazo_pagamento)} />
            </CardContent>
          </Card>
        </section>

        <section className="grid gap-6 xl:grid-cols-2">
          <div className="admin-card-surface rounded-[24px] border p-4 shadow-[0_24px_60px_-40px_hsl(215_25%_12%/0.24)] sm:rounded-[28px] sm:p-6">
            <div className="flex items-end justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.24em] text-primary/60">Exigências</p>
                <h2 className="mt-2 text-2xl font-semibold tracking-tight text-foreground">O que você precisa atender</h2>
              </div>
              <p className="text-xs text-muted-foreground sm:text-sm">{requirementFlags.length} itens</p>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-2.5 sm:mt-5 sm:gap-3">
              {requirementFlags.map((flag) => (
                <SignalCard key={flag.label} icon={flag.icon} label={flag.label} active={flag.active} />
              ))}
            </div>
          </div>

          <div className="admin-card-surface rounded-[24px] border p-4 shadow-[0_24px_60px_-40px_hsl(215_25%_12%/0.24)] sm:rounded-[28px] sm:p-6">
            <div className="flex items-end justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.24em] text-primary/60">Reputação</p>
                <h2 className="mt-2 text-2xl font-semibold tracking-tight text-foreground">Sinais positivos</h2>
              </div>
              <p className="text-xs text-muted-foreground sm:text-sm">{reputationFlags.length} itens</p>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-2.5 sm:mt-5 sm:gap-3 xl:grid-cols-3">
              {reputationFlags.map((flag) => (
                <SignalCard key={flag.label} icon={flag.icon} label={flag.label} active={flag.active} />
              ))}
            </div>
          </div>
        </section>

        <section className="admin-panel overflow-hidden p-5 sm:p-6 lg:p-7">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.24em] text-primary/60">
                Cargas ativas vinculadas
              </p>
              <h2 className="mt-2 text-2xl font-semibold tracking-tight text-foreground">
                {activeLoadsCount} carga{activeLoadsCount === 1 ? "" : "s"} disponível
                {activeLoadsCount === 1 ? "" : "is"}
              </h2>
            </div>
            <p className="max-w-xl text-sm leading-relaxed text-muted-foreground">
              Estas são as cargas disponíveis deste cliente no portal do motorista.
            </p>
          </div>

          <ScrollArea className="mt-5 h-[min(430px,58vh)] pr-2 sm:h-[min(480px,52vh)] sm:pr-4">
            {activeLoads.length > 0 ? (
              <div className="space-y-3">
                {activeLoads.map((load) => (
                  <Link
                    key={load.id}
                    to={`/motorista/cargas/${load.id}`}
                    className="admin-card-surface block rounded-[24px] border p-4 shadow-[0_12px_30px_-24px_hsl(215_25%_12%/0.22)] transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/20"
                  >
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0 space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant="outline" className="border-primary/20 bg-primary/5 text-primary">
                            {load.perfil}
                          </Badge>
                          <Badge variant="outline" className="border-border/60 bg-muted/35 text-muted-foreground">
                            {formatDate(load.data)} - {load.horario.slice(0, 5)}
                          </Badge>
                        </div>
                        <p className="break-words text-base font-semibold tracking-tight text-foreground">
                          {load.origem} {"\u2192"} {load.destino}
                        </p>
                      </div>
                      <div className="flex items-center justify-between gap-3 sm:flex-col sm:items-end sm:justify-start">
                        <p className="text-lg font-bold tracking-tight text-gradient-primary">
                          {formatCurrency(load.valor)}
                        </p>
                        <span className="inline-flex items-center gap-1 text-sm font-semibold text-primary">
                          Ver detalhes
                          <ArrowRight className="h-4 w-4" />
                        </span>
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            ) : (
              <div className="flex min-h-[240px] flex-col items-center justify-center gap-4 rounded-[24px] border border-dashed border-border/60 bg-muted/30 px-6 text-center">
                <Package className="h-14 w-14 text-muted-foreground/35" />
                <div className="space-y-1">
                  <p className="text-lg font-bold text-foreground">Nenhuma carga ativa encontrada</p>
                  <p className="text-sm text-muted-foreground">
                    Este cliente ainda não tem cargas publicadas para o motorista.
                  </p>
                </div>
              </div>
            )}
          </ScrollArea>
        </section>

        <div className="flex justify-center pb-2">
          <Button asChild variant="ghost" className="rounded-full px-5 font-semibold text-muted-foreground">
            <Link to="/motorista">
              <ArrowLeft className="h-4 w-4" />
              Voltar ao portal
            </Link>
          </Button>
        </div>
      </div>
    </div>
  );
};

export default DriverClientDetails;
