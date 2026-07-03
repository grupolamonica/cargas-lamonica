import { useCallback, useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Clock3,
  CreditCard,
  MapPinned,
  Package,
  ShieldCheck,
  Truck,
} from "lucide-react";
import { toast } from "sonner";
import type { CustomBadgeItem } from "@/services/operatorAdmin";
import { getBadgeIcon } from "@/lib/badgeIcons";
import { Link, useParams } from "react-router-dom";

import DriverClaimPanel, { type PreSubmitInterceptor } from "@/components/driver/DriverClaimPanel";
import CargaParadaCard from "@/components/driver/CargaParadaCard";
import { usePacoteRealtime, type PacoteRealtimeRow } from "@/hooks/usePacoteRealtime";
import { fetchPacote, type PacoteFull } from "@/services/readModels";
import { DriverRegistrationWizard } from "@/components/driver/cadastro-v2/DriverRegistrationWizard";
import { requestCandidaturaPreCheck } from "@/api/candidaturaApi";
import {
  createPublicLoadLeadPreRegistration,
  type PublicLoadLeadPayload,
} from "@/services/loadClaims";
import { persistStoredLeadState } from "@/lib/driverLeadStorage";
import { useDriverAuth } from "@/hooks/useDriverAuth";
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
import { fixBrokenPortugueseText } from "@/lib/fixBrokenEncoding";

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
  eixos: number | null;
  valor: number | null;
  bonus: number | null;
  bonus_exigencias: string | null;
  status: string;
  cliente_id: string | null;
  sheet_data_carregamento: string | null;
  sheet_data_descarga: string | null;
  cliente: CargoClientRow | null;
  /** Pacote (cargas_casadas) ao qual a carga pertence — null = carga avulsa. Plan 10-04/10-06. */
  viagem_id?: string | null;
  /** Posição da carga dentro do pacote (1..N) — null quando avulsa. */
  ordem_viagem?: number | null;
}

const CARGO_DETAILS_SELECT =
  "id, data, horario, origem, destino, distancia_km, duracao_horas, perfil, eixos, valor, bonus, bonus_exigencias, status, cliente_id, sheet_data_carregamento, sheet_data_descarga, viagem_id, ordem_viagem, cliente:clientes(id, nome, descricao, forma_pagamento, prazo_pagamento, observacoes, exige_antt, exige_carga_monitorada, exige_rastreamento, exige_seguro, reputacao_boa_comunicacao, reputacao_bom_pagador, reputacao_carga_organizada, reputacao_liberacao_rapida, reputacao_pagamento_rapido, custom_reputacoes, custom_exigencias)";
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

export function formatRouteMetric(value: number | null, unit: string) {
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

export function DetailMetric({
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
  const driverAuth = useDriverAuth();
  const isDriverAuthenticated = Boolean(driverAuth.session?.access_token);
  const [registrationWizardOpen, setRegistrationWizardOpen] = useState(false);
  const [registrationContext, setRegistrationContext] = useState<{
    cargaId: string;
    cpf: string;
    horsePlate: string;
    trailerPlates: string[];
    preCheckResponse: import("@/api/candidaturaApi").PreCheckResponse;
  } | null>(null);

  // Abre o fluxo de candidatura existente (DriverClaimPanel dentro do dialog atual).
  // Este handler e chamado:
  //   1) Direto por drivers NAO autenticados (fallback público v1)
  //   2) Pelo wizard v2 após pre-check com pendencias = 0
  const handleExistingClaimFlow = (_ctx: {
    cargaId: string;
    horsePlate: string;
    trailerPlates: string[];
  }) => {
    setIsClaimDialogOpen(true);
  };

  const openCandidaturaFlow = () => {
    // SEMPRE abre o modal de candidatura existente (DriverClaimPanel).
    // O interceptor v2 (handlePreSubmitInterceptor abaixo) é injetado nele
    // e dispara o pre-check com as placas que o motorista digitou no modal,
    // APÓS o submit do form mas ANTES do POST v1 — se houver pendências,
    // troca para o wizard v2; se zero, segue submit v1 normal.
    setIsClaimDialogOpen(true);
  };

  /**
   * Phase 7 interceptor — injetado no DriverClaimPanel para TODOS os drivers
   * (autenticados ou não). Roda DEPOIS de o form estar válido e ANTES do POST v1.
   * Endpoint público: CPF vem do próprio form, sem necessidade de login.
   *
   * Decisão:
   *  - CPF vazio / sem cargoId    → 'continue' (não bloqueia)
   *  - pre-check pendências=0     → 'continue' (driver OK, submit v1 normal)
   *  - pre-check pendências>0     → 'abort' + abre wizard v2 com dados pré-populados
   *  - falha de rede no pre-check → 'continue' (não bloqueia driver; backend re-valida)
   */
  const handlePreSubmitInterceptor: PreSubmitInterceptor = async (form) => {
    if (!normalizedCargoId) {
      return "continue";
    }

    const cpf = form.cpf?.replace(/\D/g, "") || "";
    if (cpf.length !== 11) {
      return "continue";
    }

    const trailerPlatesArray = [form.trailerPlate, form.trailerPlate2]
      .map((plate) => plate?.trim() || "")
      .filter((plate) => plate.length > 0);

    let response: { pendencias: unknown[]; completos?: unknown[] };
    try {
      response = await requestCandidaturaPreCheck({
        cpf,
        horsePlate: form.horsePlate,
        trailerPlates: trailerPlatesArray,
      });
    } catch (preCheckError) {
      console.warn("[DriverCargoDetails] pre-check failed; continuing v1 submit", preCheckError);
      return "continue";
    }

    if (!Array.isArray(response.pendencias) || response.pendencias.length === 0) {
      return "continue";
    }

    // Bug A — Sintoma 2 (Task 08-18): persistir o lead com os dados novos
    // ANTES de abrir o wizard. Sem isso, se o motorista clica "Agora não"
    // na Tela 0, a candidatura volta a exibir os dados antigos (placa A)
    // tanto no DB quanto no localStorage, descartando silenciosamente a
    // atualização que ele acabou de digitar (ex.: placa B).
    //
    // O endpoint /pre-registration funciona como UPSERT: insere quando não
    // existe lead matching e atualiza vehicle_type/trailer_plate quando o
    // identity tuple bate. Aceita lead com placa pendente (a validação
    // detachada roda em background).
    //
    // Falha de rede / 4xx → fallback: persistir só no localStorage e abrir
    // o wizard mesmo assim (melhor que descarte silencioso).
    const payload: PublicLoadLeadPayload = {
      cpf,
      phone: form.phone,
      horsePlate: form.horsePlate,
      trailerPlate: form.trailerPlate,
      trailerPlate2: form.trailerPlate2,
      vehicleType: form.vehicleType,
    };

    try {
      const persistResult = await createPublicLoadLeadPreRegistration(
        normalizedCargoId,
        payload,
      );
      persistStoredLeadState({
        loadId: normalizedCargoId,
        leadId: persistResult.lead.id,
        stage: persistResult.lead.status === "PRE_REGISTERED" ? "PRE_REGISTERED" : "QUEUED",
        form: payload,
        whatsappUrl: null,
        updatedAt: new Date().toISOString(),
      });
    } catch (persistError) {
      // Não bloqueia o fluxo — o motorista ainda completa o wizard, e o
      // backend re-valida no submit final. O localStorage guarda a placa
      // nova para o usuário não perder o trabalho ao reabrir o painel.
      console.warn(
        "[DriverCargoDetails] persist-before-wizard failed; opening wizard mesmo assim",
        persistError,
      );
      try {
        persistStoredLeadState({
          loadId: normalizedCargoId,
          // sem lead.id servidor — usamos sentinel local para a UI saber que
          // ainda não está confirmado.
          leadId: `local-pending-${cpf}`,
          stage: "PRE_REGISTERED",
          form: payload,
          whatsappUrl: null,
          updatedAt: new Date().toISOString(),
        });
      } catch (storageError) {
        console.warn(
          "[DriverCargoDetails] localStorage persist also failed",
          storageError,
        );
      }
    }

    // Pendências detectadas — fecha o claim panel e abre o wizard com os dados digitados.
    setIsClaimDialogOpen(false);
    setRegistrationContext({
      cargaId: normalizedCargoId,
      cpf,
      horsePlate: form.horsePlate,
      trailerPlates: trailerPlatesArray,
      preCheckResponse: response as import("@/api/candidaturaApi").PreCheckResponse,
    });
    setRegistrationWizardOpen(true);
    return "abort";
  };

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

      // viagem_id / ordem_viagem foram adicionados em plan 10-04 mas os tipos
      // gerados do Supabase ainda não foram regenerados — cast via unknown.
      return resolveCargoDecorations(data as unknown as CargoDetailsRow);
    },
    // Detalhe de carga muda pouco; sem staleTime (default 0) cada foco de aba
    // refazia a query + JOINs de cliente/rota. 30s corta refetches redundantes
    // (egress do pooler) sem prejudicar a navegação do motorista.
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  // ─── Pacote (cargas casadas) realtime — plan 10-06 ──────────────────────
  // Quando a carga aberta pertence a um pacote (viagem_id NOT NULL), assina
  // UPDATE em cargas_casadas e dispara toast + invalida queries quando o
  // operador edita (version-bump). Carga avulsa: viagemId=null → hook é
  // no-op (não subscreve). Hooks chamados aqui ficam ANTES dos early returns
  // para satisfazer Rules of Hooks.
  const queryClient = useQueryClient();
  const viagemId = cargoQuery.data?.cargo.viagem_id ?? null;
  const pacoteCached = queryClient.getQueryData<PacoteFull>(["pacote", viagemId]);
  const currentPacoteVersion = pacoteCached?.version ?? 0;
  const currentCargoIdForBump = cargoQuery.data?.cargo.id ?? null;

  const handlePacoteVersionBump = useCallback(
    (next: PacoteRealtimeRow) => {
      toast.info(`Pacote atualizado pelo operador (v${next.version}). Recarregando…`);
      // Refresca o detalhe do pacote (PacotePanel re-renderiza com cargas novas)
      queryClient.invalidateQueries({ queryKey: ["pacote", viagemId] });
      // Refresca a carga atual — version-bump pode ter re-aberto reserva
      if (currentCargoIdForBump) {
        queryClient.invalidateQueries({ queryKey: ["driver", "cargo", currentCargoIdForBump] });
      }
    },
    [queryClient, viagemId, currentCargoIdForBump],
  );

  usePacoteRealtime({
    pacoteId: viagemId,
    currentVersion: currentPacoteVersion,
    onVersionBump: handlePacoteVersionBump,
  });

  // Carrega o pacote completo (todas as cargas + valor_total) quando a carga
  // aberta pertence a uma viagem casada. Compartilha queryKey ["pacote", id]
  // com PacoteStopsList do listing — o hook usePacoteRealtime invalida essa
  // mesma chave em version-bump.
  const pacoteQuery = useQuery<PacoteFull>({
    queryKey: ["pacote", viagemId],
    queryFn: () => fetchPacote(viagemId!),
    enabled: Boolean(viagemId),
    staleTime: 30_000,
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

  // Flag central — quando a carga pertence a um pacote, varias secoes sao
  // ocultadas (bonus/cliente/exigencias/reputacao) e o header da rota muda
  // para "VIAGEM CASADA — N paradas". `pacoteData` so resolve depois do fetch
  // do pacote; usamos boolean(viagemId) para ja iniciar o ramo, exibindo
  // placeholders enquanto carrega.
  const pacoteData = pacoteQuery.data ?? null;
  const isPacote = Boolean(viagemId);
  const pacoteTotalCargas = pacoteData?.total_cargas ?? pacoteData?.cargas.length ?? null;
  const pacoteValorTotalLabel = pacoteData
    ? formatCurrency(pacoteData.valor_total)
    : "Carregando…";

  return (
    <div className="driver-theme min-h-screen bg-[radial-gradient(circle_at_top_left,hsl(224_100%_96%),transparent_40%),linear-gradient(180deg,hsl(220_30%_97%),hsl(220_22%_94%))] px-4 py-5 sm:px-6 sm:py-6 lg:px-8">
      {/* pb-28+ mobile/tablet para evitar sobreposição com sticky CTA "Candidatar-se" (iter #2 D11) */}
      <div className="mx-auto max-w-6xl space-y-5 pb-28 sm:space-y-6 sm:pb-32 lg:pb-12">
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
                  onClick={openCandidaturaFlow}
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
                  <p className="text-xs font-semibold uppercase tracking-[0.24em] text-white/70">
                    {isPacote ? "Viagem casada" : "Rota disponível"}
                  </p>
                  <h1 className="mt-3 break-words text-2xl font-black tracking-tight text-white sm:text-4xl">
                    {isPacote ? (
                      <>VIAGEM CASADA {"—"} {pacoteTotalCargas ?? "…"} paradas</>
                    ) : (
                      <>{fixBrokenPortugueseText(cargo.origem)} {"\u2192"} {fixBrokenPortugueseText(cargo.destino)}</>
                    )}
                  </h1>
                </div>

                <p className="hidden max-w-2xl text-sm leading-relaxed text-white/82 sm:block sm:text-base">
                  {isPacote
                    ? `Pacote com ${pacoteTotalCargas ?? "várias"} cargas — confira as paradas abaixo antes de demonstrar interesse.`
                    : cliente?.descricao?.trim()
                      ? cliente.descricao
                      : "Aqui você vê os principais dados da carga e do cliente antes de demonstrar interesse."}
                </p>
              </div>

              <div className="rounded-[28px] border border-white/12 bg-white/10 p-4 backdrop-blur sm:p-5">
                <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/60">Pagamento total</p>
                <p className="mt-3 text-3xl font-black tracking-tight text-white">
                  {isPacote
                    ? pacoteValorTotalLabel
                    : totalPayment !== null
                      ? formatCurrency(totalPayment)
                      : "A combinar"}
                </p>
                {!isPacote ? (
                  <p className="mt-2 text-sm leading-relaxed text-white/72">
                    {buildDriverPaymentDetails(cargo.valor, cargo.bonus)}
                  </p>
                ) : null}
                {!isPacote ? (
                  <div className="mt-5 space-y-2 text-sm text-white/82">
                    <p className="hidden sm:block">Cliente: {formatMaybeText(cliente?.nome?.trim(), "Cliente não informado")}</p>
                    <p>Janela estimada: {estimatedTime}</p>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </section>

        {!isPacote && hasBonusHighlight ? (
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

        {isPacote ? (
          /*
           * Plan revisao 2026-05-23: quando a carga aberta pertence a um pacote,
           * substitui a card unica "Coleta, entrega e percurso" por um grid
           * com uma sub-card por carga (CargaParadaCard). Loading -> 3 skeleton
           * cards. Error -> ErrorState inline com retry.
           */
          <section className="space-y-4">
            <h2 className="text-xl font-bold">Informações das cargas</h2>
            {pacoteQuery.isLoading ? (
              <div className="grid gap-4 xl:grid-cols-2" data-testid="pacote-paradas-loading">
                <Skeleton className="h-[180px] rounded-[24px]" />
                <Skeleton className="h-[180px] rounded-[24px]" />
                <Skeleton className="h-[180px] rounded-[24px]" />
              </div>
            ) : pacoteQuery.isError || !pacoteData ? (
              <div
                role="alert"
                data-testid="pacote-paradas-error"
                className="admin-panel rounded-[24px] border border-destructive/30 bg-destructive/5 p-5"
              >
                <p className="text-sm text-muted-foreground">
                  Falha ao carregar as paradas desta viagem casada.
                </p>
                <Button
                  type="button"
                  variant="outline"
                  className="mt-3 rounded-full"
                  onClick={() => void pacoteQuery.refetch()}
                  disabled={pacoteQuery.isFetching}
                >
                  Tentar novamente
                </Button>
              </div>
            ) : (
              <div className="grid gap-4 xl:grid-cols-2" data-testid="pacote-paradas-grid">
                {[...pacoteData.cargas]
                  .sort((a, b) => a.ordem_viagem - b.ordem_viagem)
                  .map((c) => (
                    <CargaParadaCard
                      key={c.id}
                      carga={c}
                      isCurrent={c.id === cargo.id}
                      index={c.ordem_viagem}
                    />
                  ))}
              </div>
            )}
          </section>
        ) : (
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
              <DetailMetric icon={Truck} label="Tipo de veículo" value={cargo.perfil ? (cargo.eixos ? `${cargo.perfil} · ${cargo.eixos} eixos` : cargo.perfil) : "A confirmar"} />
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
        )}

        {!isPacote ? (
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
        ) : null}
      </div>

      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center px-4 sm:bottom-6 sm:justify-end sm:px-6 lg:px-8">
        <Button
          type="button"
          variant="cta"
          onClick={openCandidaturaFlow}
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
              mode={isDriverAuthenticated ? "authenticated-claim" : "public-form"}
              onPreSubmitInterceptor={handlePreSubmitInterceptor}
              onCompleteRegistration={({ preCheckResponse, cpf, horsePlate, trailerPlates }) => {
                if (!normalizedCargoId) return;
                setIsClaimDialogOpen(false);
                setRegistrationContext({
                  cargaId: normalizedCargoId,
                  cpf,
                  horsePlate,
                  trailerPlates,
                  preCheckResponse,
                });
                setRegistrationWizardOpen(true);
              }}
              className="admin-card-surface-deep rounded-[28px] border shadow-[0_32px_64px_-38px_hsl(223_56%_10%/0.38)] sm:rounded-[32px]"
            />
          </DialogContent>
        ) : null}
      </Dialog>

      <DriverRegistrationWizard
        open={registrationWizardOpen}
        onOpenChange={setRegistrationWizardOpen}
        cargaId={registrationContext?.cargaId}
        cargaContext={{ origem: cargo.origem, destino: cargo.destino }}
        cpf={registrationContext?.cpf}
        horsePlate={registrationContext?.horsePlate}
        trailerPlates={registrationContext?.trailerPlates}
        initialPreCheckResponse={registrationContext?.preCheckResponse}
        onPreCheckPassed={handleExistingClaimFlow}
      />
    </div>
  );
};

export default DriverCargoDetails;
