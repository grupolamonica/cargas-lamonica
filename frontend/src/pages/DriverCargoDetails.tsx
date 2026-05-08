import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  Clock3,
  CreditCard,
  MapPinned,
  Package,
  ShieldCheck,
  Truck,
} from "lucide-react";
import type { CustomBadgeItem } from "@/services/operatorAdmin";
import { getBadgeIcon } from "@/lib/badgeIcons";
import { Link, useParams } from "react-router-dom";

import DriverClaimPanel from "@/components/driver/DriverClaimPanel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  getVisibleDriverCargoRequirementLabels,
  hasVisibleDriverCargoClientNotes,
} from "@/lib/driverCargoDetails";
import { createRouteLookupKeys } from "@/lib/assignableRoutes";
import { resolveCargoPublicationReadiness } from "@/lib/loadPublication";
import {
  collectMissingDriverClientIds,
  fetchDriverClientsByIds,
  mergeDriverClientsIntoRows,
} from "@/lib/driverClients";
import { buildLoadingDateTime, buildOperationalDateLabel, formatEstimatedTime } from "@/lib/estimatedTime";
import { publicSupabase } from "@/integrations/supabase/public-client";
import { formatCurrency, buildTotalPayment } from "@/lib/currency";

interface CargoClientRow {
  id: string;
  nome: string;
  descricao: string | null;
  forma_pagamento: string | null;
  prazo_pagamento: string | null;
  observacoes: string | null;
  exige_antt: boolean;
  exige_carga_monitorada: boolean;
  exige_rastreamento: boolean;
  exige_seguro: boolean;
  reputacao_boa_comunicacao: boolean;
  reputacao_bom_pagador: boolean;
  reputacao_carga_organizada: boolean;
  reputacao_liberacao_rapida: boolean;
  reputacao_pagamento_rapido: boolean;
  custom_reputacoes: unknown;
  custom_exigencias: unknown;
}

interface CargoDetailsRow {
  id: string;
  data: string;
  horario: string;
  origem: string;
  destino: string;
  distancia_km: number | null;
  duracao_horas: number | null;
  perfil: string;
  valor: number | null;
  bonus: number | null;
  bonus_exigencias: string | null;
  status: string;
  cliente_id: string | null;
  sheet_data_carregamento: string | null;
  sheet_data_descarga: string | null;
  cliente: CargoClientRow | null;
}

const CARGO_DETAILS_SELECT =
  "id, data, horario, origem, destino, distancia_km, duracao_horas, perfil, valor, bonus, bonus_exigencias, status, cliente_id, sheet_data_carregamento, sheet_data_descarga, cliente:clientes(id, nome, descricao, forma_pagamento, prazo_pagamento, observacoes, exige_antt, exige_carga_monitorada, exige_rastreamento, exige_seguro, reputacao_boa_comunicacao, reputacao_bom_pagador, reputacao_carga_organizada, reputacao_liberacao_rapida, reputacao_pagamento_rapido, custom_reputacoes, custom_exigencias)";
const LEGACY_CARGO_DETAILS_SELECT =
  "id, data, horario, origem, destino, distancia_km, duracao_horas, perfil, valor, bonus, status, cliente_id, sheet_data_carregamento, sheet_data_descarga, cliente:clientes(id, nome, descricao, forma_pagamento, prazo_pagamento, observacoes, exige_antt, exige_carga_monitorada, exige_rastreamento, exige_seguro, reputacao_boa_comunicacao, reputacao_bom_pagador, reputacao_carga_organizada, reputacao_liberacao_rapida, reputacao_pagamento_rapido, custom_reputacoes, custom_exigencias)";


const reputationLabels = [
  { label: "Boa comunicação", activeKey: "reputacao_boa_comunicacao" },
  { label: "Bom pagador", activeKey: "reputacao_bom_pagador" },
  { label: "Carga organizada", activeKey: "reputacao_carga_organizada" },
  { label: "Liberação rápida", activeKey: "reputacao_liberacao_rapida" },
  { label: "Pagamento rápido", activeKey: "reputacao_pagamento_rapido" },
] as const;

function formatMaybeText(value?: string | null, fallback = "Não informado") {
  const trimmedValue = value?.trim();
  return trimmedValue ? trimmedValue : fallback;
}

function buildPaymentDetails(value: number | null, bonus: number | null) {
  const hasValue = typeof value === "number" && Number.isFinite(value);
  const hasBonus = typeof bonus === "number" && Number.isFinite(bonus) && bonus > 0;

  if (hasValue && hasBonus) {
    return `${formatCurrency(value)} da carga + ${formatCurrency(bonus)} de bônus`;
  }

  if (hasValue) {
    return formatCurrency(value);
  }

  if (hasBonus) {
    return `${formatCurrency(bonus)} de bônus`;
  }

  return "A combinar";
}

function buildDriverPaymentDetails(value: number | null, bonus: number | null) {
  const hasValue = typeof value === "number" && Number.isFinite(value);
  const hasBonus = typeof bonus === "number" && Number.isFinite(bonus) && bonus > 0;

  if (hasValue && hasBonus) {
    return `${formatCurrency(value)} da carga + ${formatCurrency(bonus)} de b\u00f4nus por concluir a entrega seguindo as normas pedidas`;
  }

  if (hasValue) {
    return formatCurrency(value);
  }

  if (hasBonus) {
    return `${formatCurrency(bonus)} de b\u00f4nus por concluir a entrega seguindo as normas pedidas`;
  }

  return "A combinar";
}

function formatCargoStatus(status?: string | null) {
  const normalizedStatus = status?.trim().toUpperCase();

  switch (normalizedStatus) {
    case "OPEN":
      return "Disponível";
    case "RESERVED":
      return "Reservada";
    case "BOOKED":
      return "Fechada";
    case "DRAFT":
      return "Em preparação";
    default:
      return status?.trim() || "Aguardando";
  }
}

function formatRouteMetric(value: number | null, unit: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "A confirmar";
  }

  return `${value.toLocaleString("pt-BR", {
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 2,
  })} ${unit}`;
}

function parseBonusRequirements(value?: string | null) {
  return String(value || "")
    .split(/\r?\n/)
    .map((item) => item.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean);
}

function isRouteCatalogLookupError(error: { message?: string; details?: string } | null) {
  const combinedMessage = `${error?.message || ""} ${error?.details || ""}`.toLowerCase();
  return combinedMessage.includes("route_metrics_cache") || combinedMessage.includes("permission denied");
}

async function resolveDriverCargoRouteFallback(cargo: Pick<CargoDetailsRow, "origem" | "destino">) {
  const routeLookupKeys = createRouteLookupKeys(cargo.origem, cargo.destino);
  const originKeys = Array.from(new Set(routeLookupKeys.map((routeKey) => routeKey.split("|")[0]).filter(Boolean)));
  const destinationKeys = Array.from(new Set(routeLookupKeys.map((routeKey) => routeKey.split("|")[1]).filter(Boolean)));

  if (originKeys.length === 0 || destinationKeys.length === 0) {
    return null;
  }

  const { data, error } = await publicSupabase
    .from("route_metrics_cache")
    .select("origin_key, destination_key, distancia_km, duracao_horas, tempo_estimado_horas, perfil_padrao, valor_padrao, bonus_padrao")
    .in("origin_key", originKeys)
    .in("destination_key", destinationKeys);

  if (error) {
    if (!isRouteCatalogLookupError(error)) {
      if (import.meta.env.DEV) console.error("Nao foi possivel consultar o catalogo publico de rotas", error);
    }

    return null;
  }

  if (!Array.isArray(data) || data.length === 0) {
    return null;
  }

  const routeByKey = new Map(data.map((routeRow) => [`${routeRow.origin_key}|${routeRow.destination_key}`, routeRow]));
  const matchedRouteKey = routeLookupKeys.find((routeKey) => routeByKey.has(routeKey));
  return matchedRouteKey ? routeByKey.get(matchedRouteKey) ?? null : null;
}

async function resolveDriverCargoDistanceKm(cargo: Pick<CargoDetailsRow, "origem" | "destino" | "distancia_km">) {
  if (typeof cargo.distancia_km === "number" && Number.isFinite(cargo.distancia_km)) {
    return cargo.distancia_km;
  }

  const { data: loadData, error: loadError } = await publicSupabase
    .from("cargas")
    .select("distancia_km")
    .eq("origem", cargo.origem)
    .eq("destino", cargo.destino)
    .not("distancia_km", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (loadError) {
    if (import.meta.env.DEV) console.error("Não foi possível consultar o histórico público da rota", loadError);
    return null;
  }

  return typeof loadData?.distancia_km === "number" && Number.isFinite(loadData.distancia_km)
    ? loadData.distancia_km
    : null;
}

function DetailMetric({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: string;
  icon: typeof Clock3;
}) {
  return (
    <div className="admin-card-surface rounded-[20px] border p-3.5 shadow-[0_18px_36px_-28px_hsl(215_25%_12%/0.16)] sm:rounded-[24px] sm:p-4">
      <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground sm:text-[11px] sm:tracking-[0.2em]">
        <span className="flex h-8 w-8 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <Icon className="h-4 w-4" />
        </span>
        {label}
      </div>
      <p className="mt-2.5 text-sm font-semibold leading-snug text-foreground sm:mt-3 sm:text-base">{value}</p>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="driver-theme min-h-screen bg-[radial-gradient(circle_at_top_left,hsl(224_100%_96%),transparent_40%),linear-gradient(180deg,hsl(220_30%_97%),hsl(220_22%_94%))] px-4 py-6 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-6xl space-y-6">
        <Skeleton className="h-[220px] rounded-[32px]" />
        <div className="grid gap-6 xl:grid-cols-2">
          <Skeleton className="h-[320px] rounded-[28px]" />
          <Skeleton className="h-[320px] rounded-[28px]" />
        </div>
        <div className="grid gap-6 xl:grid-cols-2">
          <Skeleton className="h-[220px] rounded-[28px]" />
          <Skeleton className="h-[220px] rounded-[28px]" />
        </div>
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
          <CardHeader className="text-center">
            <CardDescription className="text-xs font-semibold uppercase tracking-[0.24em] text-primary/60">
              Carga específica
            </CardDescription>
            <CardTitle className="text-2xl tracking-tight text-foreground">{title}</CardTitle>
            <CardDescription className="mx-auto max-w-xl text-sm leading-relaxed">
              {description}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex justify-center pb-6">
            <Button asChild className="rounded-full px-5 font-semibold">
              <Link to="/motorista">
                <ArrowLeft className="h-4 w-4" />
                Voltar ao portal
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

const DriverCargoDetails = () => {
  const { cargoId } = useParams();
  const normalizedCargoId = cargoId?.trim() || "";
  const [isClaimDialogOpen, setIsClaimDialogOpen] = useState(false);

  // Registra acesso ao portal para o "Pico de acesso" do painel do operador.
  // Os motoristas chegam direto nesta rota pelo link compartilhado no WhatsApp
  // (raramente passam pelo DriverPortal `/`), ent\u00e3o disparamos o mesmo POST
  // aqui. O backend tem rate-limit por IP (30s) e o sessionStorage garante
  // apenas um POST por sess\u00e3o, compartilhado entre rotas p\u00fablicas.
  useEffect(() => {
    try {
      const STORAGE_KEY = "lamonica-driver-portal-visit-recorded";
      if (typeof window !== "undefined" && !sessionStorage.getItem(STORAGE_KEY)) {
        sessionStorage.setItem(STORAGE_KEY, "1");
        void fetch("/api/driver/portal-view", { method: "POST" }).catch(() => {
          // fire-and-forget
        });
      }
    } catch {
      // sessionStorage indispon\u00edvel
    }
  }, []);

  const cargoQuery = useQuery({
    queryKey: ["driver", "cargo", normalizedCargoId],
    enabled: Boolean(normalizedCargoId),
    queryFn: async () => {
      const resolveClientData = async (cargoRow: CargoDetailsRow) => {
        const missingClientIds = collectMissingDriverClientIds([cargoRow]);

        if (missingClientIds.length === 0) {
          return cargoRow;
        }

        try {
          const clientsById = await fetchDriverClientsByIds(publicSupabase, missingClientIds);
          return mergeDriverClientsIntoRows([cargoRow], clientsById)[0] as CargoDetailsRow;
        } catch (clientError) {
          if (import.meta.env.DEV) console.error("Não foi possível carregar os dados do cliente da carga pública", clientError);
          return cargoRow;
        }
      };

      const resolveCargoDecorations = async (cargoRow: CargoDetailsRow) => {
        const cargoWithClient = await resolveClientData(cargoRow);
        const routeFallback = await resolveDriverCargoRouteFallback(cargoWithClient);
        const fallbackDistanceKm =
          typeof routeFallback?.distancia_km === "number" && Number.isFinite(routeFallback.distancia_km)
            ? routeFallback.distancia_km
            : await resolveDriverCargoDistanceKm(cargoWithClient);
        const publication = resolveCargoPublicationReadiness(
          {
            perfil: cargoWithClient.perfil,
            valor: cargoWithClient.valor,
            bonus: cargoWithClient.bonus,
            distancia_km:
              typeof cargoWithClient.distancia_km === "number" && Number.isFinite(cargoWithClient.distancia_km)
                ? cargoWithClient.distancia_km
                : fallbackDistanceKm,
            duracao_horas: cargoWithClient.duracao_horas,
            tempo_estimado_horas: routeFallback?.tempo_estimado_horas ?? null,
          },
          routeFallback,
        );

        return {
          cargo: {
            ...cargoWithClient,
            perfil: publication.perfil || cargoWithClient.perfil,
            valor: publication.valor,
            bonus: publication.bonus,
            distancia_km: publication.distancia_km,
            duracao_horas: publication.duracao_horas,
          },
          publication,
        };
      };

      const { data, error } = await publicSupabase
        .from("cargas")
        .select(CARGO_DETAILS_SELECT)
        .eq("id", normalizedCargoId)
        .maybeSingle();

      if (error) {
        const combinedMessage = `${error.message || ""} ${error.details || ""}`.toLowerCase();

        if (!combinedMessage.includes("bonus_exigencias")) {
          throw error;
        }

        const fallbackResponse = await publicSupabase
          .from("cargas")
          .select(LEGACY_CARGO_DETAILS_SELECT)
          .eq("id", normalizedCargoId)
          .maybeSingle();

        if (fallbackResponse.error) {
          throw fallbackResponse.error;
        }

        if (!fallbackResponse.data) {
          throw new Error("Carga não encontrada");
        }

        return resolveCargoDecorations({
          ...(fallbackResponse.data as Omit<CargoDetailsRow, "bonus_exigencias">),
          bonus_exigencias: null,
        });
      }

      if (!data) {
        throw new Error("Carga não encontrada");
      }

      return resolveCargoDecorations(data as CargoDetailsRow);
    },
  });

  if (!normalizedCargoId) {
    return (
      <ErrorState
        title="Carga inválida"
        description="Não consegui identificar qual carga deve ser aberta. Volte para a lista e tente novamente."
      />
    );
  }

  if (cargoQuery.isLoading) {
    return <LoadingState />;
  }

  if (cargoQuery.error || !cargoQuery.data) {
    return (
      <ErrorState
        title="Não foi possível abrir esta carga"
        description="Esse link pode ter expirado ou a carga pode não estar mais disponível."
      />
    );
  }

  if (!cargoQuery.data.publication.isReady) {
    return (
      <ErrorState
        title="Carga em preparacao"
        description={
          cargoQuery.data.publication.alertSummary
            ? `${cargoQuery.data.publication.alertSummary} Assim que a equipe concluir esses dados, a carga volta a aparecer para o motorista.`
            : "Essa carga ainda não foi liberada para o portal do motorista."
        }
      />
    );
  }

  const cargo = cargoQuery.data.cargo;
  const cliente = cargo.cliente;
  const totalPayment = buildTotalPayment(cargo.valor, cargo.bonus);
  const loadingDate = buildLoadingDateTime(cargo.sheet_data_carregamento, cargo.data, cargo.horario);
  const loadingLabel = buildOperationalDateLabel(cargo.sheet_data_carregamento, cargo.data, cargo.horario);
  const unloadingLabel = buildOperationalDateLabel(cargo.sheet_data_descarga);
  const estimatedTime = formatEstimatedTime(loadingDate, cargo.sheet_data_descarga);
  const bonusRequirements = parseBonusRequirements(cargo.bonus_exigencias);
  const hasBonusHighlight = (typeof cargo.bonus === "number" && cargo.bonus > 0) || bonusRequirements.length > 0;
  const visibleRequirementLabels = getVisibleDriverCargoRequirementLabels(cliente);
  const hasClientNotes = hasVisibleDriverCargoClientNotes(cliente?.observacoes);

  return (
    <div className="driver-theme min-h-screen bg-[radial-gradient(circle_at_top_left,hsl(224_100%_96%),transparent_40%),linear-gradient(180deg,hsl(220_30%_97%),hsl(220_22%_94%))] px-4 py-5 sm:px-6 sm:py-6 lg:px-8">
      <div className="mx-auto max-w-6xl space-y-5 sm:space-y-6">
        <section className="relative overflow-hidden rounded-[32px] border border-white/70 bg-[linear-gradient(135deg,hsl(223_56%_12%),hsl(223_55%_22%))] p-5 text-white shadow-[0_30px_70px_-30px_hsl(215_25%_12%/0.55)] sm:p-8">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,hsl(225_100%_65%/0.18),transparent_36%),radial-gradient(circle_at_bottom_left,hsl(200_100%_55%/0.14),transparent_30%)]" />
          <div className="relative space-y-6">
            <div className="flex items-center justify-between gap-3">
              <Button
                asChild
                variant="outline"
                className="h-10 w-fit rounded-full border-white/70 bg-white px-4 text-primary shadow-[0_16px_30px_-22px_hsl(223_56%_12%/0.35)] hover:bg-white/95 hover:text-primary"
              >
                <Link to="/motorista">
                  <ArrowLeft className="h-4 w-4" />
                  Voltar ao portal
                </Link>
              </Button>

              <div className="hidden sm:flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="cta"
                  onClick={() => setIsClaimDialogOpen(true)}
                  className="group h-11 rounded-full px-4"
                >
                  <span className="flex h-7 w-7 items-center justify-center rounded-full bg-white/20 transition-colors group-hover:bg-white/28">
                    <ShieldCheck className="h-3.5 w-3.5" />
                  </span>
                  Candidatar-se
                </Button>
              </div>
            </div>

            <div className="grid gap-5 xl:grid-cols-[minmax(0,1.2fr)_320px]">
              <div className="space-y-4">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.24em] text-white/70">Rota disponível</p>
                  <h1 className="mt-3 break-words text-2xl font-black tracking-tight text-white sm:text-4xl">
                    {cargo.origem} {"\u2192"} {cargo.destino}
                  </h1>
                </div>

                <p className="hidden max-w-2xl text-sm leading-relaxed text-white/82 sm:block sm:text-base">
                  {cliente?.descricao?.trim()
                    ? cliente.descricao
                    : "Aqui você vê os principais dados da carga e do cliente antes de demonstrar interesse."}
                </p>
              </div>

              <div className="rounded-[28px] border border-white/12 bg-white/10 p-4 backdrop-blur sm:p-5">
                <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/60">Pagamento total</p>
                <p className="mt-3 text-3xl font-black tracking-tight text-white">
                  {totalPayment !== null ? formatCurrency(totalPayment) : "A combinar"}
                </p>
                <p className="mt-2 text-sm leading-relaxed text-white/72">
                  {buildDriverPaymentDetails(cargo.valor, cargo.bonus)}
                </p>
                <div className="mt-5 space-y-2 text-sm text-white/82">
                  <p className="hidden sm:block">Cliente: {formatMaybeText(cliente?.nome?.trim(), "Cliente não informado")}</p>
                  <p>Janela estimada: {estimatedTime}</p>
                </div>
              </div>
            </div>
          </div>
        </section>

        {hasBonusHighlight ? (
          <section className="admin-accent-tint relative overflow-hidden rounded-[32px] border p-5 shadow-[0_28px_58px_-34px_hsl(223_56%_12%/0.26)] sm:p-7">
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,hsl(152_67%_43%/0.14),transparent_34%),radial-gradient(circle_at_bottom_left,hsl(224_94%_37%/0.14),transparent_42%)]" />
            <div className="relative grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_260px] xl:items-start">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.24em] text-primary/60">Bônus por conformidade</p>
                <h2 className="mt-3 text-2xl font-black tracking-tight text-foreground">Cumpra as normas para liberar esse valor extra</h2>
                <p className="mt-3 max-w-3xl text-sm leading-relaxed text-muted-foreground sm:text-base">
                  Para receber esse bônus, o motorista precisa seguir todas as exigências abaixo e concluir a operação dentro do combinado com a equipe.
                </p>

                <div className="mt-5 flex flex-wrap gap-3">
                  {bonusRequirements.length > 0 ? (
                    bonusRequirements.map((requirement) => (
                      <div
                        key={requirement}
                        className="admin-card-surface inline-flex items-start gap-2 rounded-2xl border px-4 py-3 text-sm font-medium text-foreground shadow-[0_16px_30px_-28px_hsl(223_56%_12%/0.24)]"
                      >
                        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                        <span>{requirement}</span>
                      </div>
                    ))
                  ) : (
                    <div className="admin-card-surface inline-flex items-start gap-2 rounded-2xl border px-4 py-3 text-sm font-medium text-foreground shadow-[0_16px_30px_-28px_hsl(223_56%_12%/0.24)]">
                      <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                      <span>Seguir integralmente as normas operacionais informadas para esta carga.</span>
                    </div>
                  )}
                </div>
              </div>

              <div className="rounded-[28px] border border-white/80 bg-[linear-gradient(180deg,hsl(223_56%_18%),hsl(223_46%_23%))] p-5 text-white shadow-[0_24px_46px_-28px_hsl(223_56%_12%/0.48)]">
                <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/62">Valor do bônus</p>
                <p className="mt-3 text-3xl font-black tracking-tight text-white">
                  {typeof cargo.bonus === "number" && cargo.bonus > 0 ? formatCurrency(cargo.bonus) : "A combinar"}
                </p>
                <p className="mt-3 text-sm leading-relaxed text-white/72">
                  Esse valor adicional só é liberado quando todas as normas desta carga forem cumpridas corretamente.
                </p>
              </div>
            </div>
          </section>
        ) : null}

        <section className="grid gap-6 xl:grid-cols-2">
          <Card className="admin-panel overflow-hidden">
            <CardHeader>
              <CardDescription className="text-xs font-semibold uppercase tracking-[0.24em] text-primary/60">
                Informações da carga
              </CardDescription>
              <CardTitle className="text-2xl tracking-tight text-foreground">Coleta, entrega e percurso</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-3">
              <DetailMetric icon={Clock3} label="Carregamento" value={loadingLabel} />
              <DetailMetric icon={Clock3} label="Descarga" value={unloadingLabel} />
              <DetailMetric icon={Package} label="Tempo estimado" value={estimatedTime} />
              <DetailMetric icon={Truck} label="Tipo de veículo" value={cargo.perfil || "A confirmar"} />
              <DetailMetric icon={MapPinned} label="Percurso recomendado" value={formatRouteMetric(cargo.distancia_km, "km")} />
            </CardContent>
          </Card>

          <Card className="admin-panel hidden overflow-hidden lg:block">
            <CardHeader>
              <CardDescription className="text-xs font-semibold uppercase tracking-[0.24em] text-primary/60">
                Cliente da carga
              </CardDescription>
              <CardTitle className="text-2xl tracking-tight text-foreground">
                {formatMaybeText(cliente?.nome?.trim(), "Cliente não informado")}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <DetailMetric icon={CreditCard} label="Forma de pagamento" value={formatMaybeText(cliente?.forma_pagamento)} />
                <DetailMetric icon={Clock3} label="Prazo de pagamento" value={formatMaybeText(cliente?.prazo_pagamento)} />
              </div>

              {hasClientNotes ? (
                <div className="rounded-[24px] border border-border/60 bg-muted/20 p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.22em] text-muted-foreground">Recados do cliente</p>
                  <p className="mt-3 text-sm leading-relaxed text-foreground">{cliente?.observacoes?.trim()}</p>
                </div>
              ) : null}

              {cliente ? (
                <Button asChild variant="outline" className="w-full rounded-full font-semibold">
                  <Link to={`/motorista/cliente/${cliente.id}`}>Abrir ficha completa do cliente</Link>
                </Button>
              ) : null}
            </CardContent>
          </Card>
        </section>

        <section className="grid gap-6 xl:grid-cols-2">
          {(visibleRequirementLabels.length > 0 || ((cliente?.custom_exigencias ?? []) as CustomBadgeItem[]).some((b) => b.active)) ? (
            <Card className="admin-panel overflow-hidden">
              <CardHeader>
                <CardDescription className="text-xs font-semibold uppercase tracking-[0.24em] text-primary/60">
                  Exigências
                </CardDescription>
                <CardTitle className="text-2xl tracking-tight text-foreground">O que você precisa atender</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                {visibleRequirementLabels.map((label) => (
                  <Badge
                    key={label}
                    className="border-primary/20 bg-primary/10 px-3 py-1.5 text-primary"
                  >
                    <ShieldCheck className="mr-1 h-3.5 w-3.5" />
                    {label}
                  </Badge>
                ))}
                {((cliente?.custom_exigencias ?? []) as CustomBadgeItem[])
                  .filter((b) => b.active)
                  .map((b) => {
                    const Icon = getBadgeIcon(b.icon_name);
                    return (
                      <Badge key={b.id} className="gap-1 border-primary/20 bg-primary/10 px-3 py-1.5 text-primary">
                        <Icon className="h-3.5 w-3.5" />
                        {b.label}
                      </Badge>
                    );
                  })}
              </CardContent>
            </Card>
          ) : null}

          <Card className="admin-panel overflow-hidden">
            <CardHeader>
              <CardDescription className="text-xs font-semibold uppercase tracking-[0.24em] text-primary/60">
                Reputação do cliente
              </CardDescription>
              <CardTitle className="text-2xl tracking-tight text-foreground">Sinais deste cliente</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              {cliente
                ? reputationLabels.map((item) => (
                    <Badge
                      key={item.label}
                      className={
                        cliente[item.activeKey]
                          ? "border-accent/20 bg-accent/10 px-3 py-1.5 text-accent"
                          : "border-border/60 bg-muted/35 px-3 py-1.5 text-muted-foreground"
                      }
                    >
                      {item.label}
                    </Badge>
                  ))
                : <p className="text-sm text-muted-foreground">Sem reputacao cadastrada para este cliente.</p>}
              {((cliente?.custom_reputacoes ?? []) as CustomBadgeItem[])
                .filter((b) => b.active)
                .map((b) => {
                  const Icon = getBadgeIcon(b.icon_name);
                  return (
                    <Badge key={b.id} className="gap-1 border-accent/20 bg-accent/10 px-3 py-1.5 text-accent">
                      <Icon className="h-3.5 w-3.5" />
                      {b.label}
                    </Badge>
                  );
                })}
            </CardContent>
          </Card>
        </section>
      </div>

      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center px-4 sm:bottom-6 sm:justify-end sm:px-6 lg:px-8">
        <Button
          type="button"
          variant="cta"
          onClick={() => setIsClaimDialogOpen(true)}
          className="pointer-events-auto group h-14 w-full rounded-full px-6 text-sm sm:min-w-[220px] sm:w-auto"
        >
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-white/20 transition-colors group-hover:bg-white/28">
            <ShieldCheck className="h-4 w-4" />
          </span>
          Candidatar-se
        </Button>
      </div>

      <Dialog open={isClaimDialogOpen} onOpenChange={setIsClaimDialogOpen}>
        {isClaimDialogOpen ? (
          <DialogContent
            overlayClassName="bg-[hsl(223_56%_12%/0.72)] backdrop-blur-[4px]"
            className="driver-theme max-h-[94vh] max-w-5xl overflow-y-auto border-none bg-transparent p-0 shadow-none [&>button]:right-4 [&>button]:top-4 [&>button]:rounded-full [&>button]:border [&>button]:border-primary/18 [&>button]:bg-white/96 [&>button]:p-2 [&>button]:text-primary [&>button]:opacity-100 [&>button]:shadow-[0_12px_28px_-18px_hsl(223_56%_10%/0.65)] [&>button]:hover:bg-white [&>button]:focus:ring-primary/25 [&>button]:data-[state=open]:bg-white [&>button]:data-[state=open]:text-primary sm:[&>button]:right-5 sm:[&>button]:top-5"
          >
            <DialogTitle className="sr-only">
              Candidatura para a carga de {cargo.origem} para {cargo.destino}
            </DialogTitle>
            <DialogDescription className="sr-only">
              Preencha seus dados para enviar sua candidatura nesta carga.
            </DialogDescription>
            <DriverClaimPanel
              loadId={cargo.id}
              panelId={`driver-claim-dialog-${cargo.id}`}
              className="admin-card-surface-deep rounded-[28px] border shadow-[0_32px_64px_-38px_hsl(223_56%_10%/0.38)] sm:rounded-[32px]"
            />
          </DialogContent>
        ) : null}
      </Dialog>
    </div>
  );
};

export default DriverCargoDetails;
