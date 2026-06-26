import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Copy, Eye, EyeOff, Package, Pencil, Plus, RefreshCw, Search, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";

import AdminPagination from "@/components/AdminPagination";
import CargoModal from "@/components/CargoModal";
import ImportProgramacaoModal from "@/components/ImportProgramacaoModal";
import DashboardHeader from "@/components/DashboardHeader";
import {
  applyAssignableRouteToCargoDraft,
  fetchAssignableRoutes,
  resolveCargoCompensation,
  resolveAssignableRouteForCargo,
} from "@/lib/assignableRoutes";
import { formatCargoStatusLabel } from "@/lib/cargoStatus";
import { formatDateOnly } from "@/lib/dateDisplay";
import { resolveCargoPublicationReadiness } from "@/lib/loadPublication";
import { normalizeOperatorCargoDate, normalizeOperatorCargoTime } from "@/lib/operatorCargoSchedule";
import { useAuth } from "@/hooks/useAuth";
import { canWriteMonetaryValues } from "@/lib/operatorAccess";
import { VEHICLE_PROFILE_OPTIONS, normalizeVehicleProfile } from "@/lib/vehicleProfiles";
import {
  createOperatorCargo,
  deleteOperatorCargo,
  duplicateOperatorCargo,
  syncOperatorCargasSheet,
  toggleOperatorCargoStatus,
  updateOperatorCargo,
  type OperatorCargoPayload,
} from "@/services/operatorAdmin";
import {
  fetchOperatorCargas,
  fetchOperatorClientes,
  type OperatorCargoListItem,
} from "@/services/readModels";
import { resolveRouteMetrics } from "@/services/routeMetrics";
import { confirmAction } from "@/lib/confirm";

interface Cliente {
  id: string;
  nome: string;
}

type Cargo = OperatorCargoListItem;

interface CargoFormData {
  data: string;
  horario: string;
  route_key?: string;
  origem: string;
  destino: string;
  perfil: string;
  valor?: string;
  bonus?: string;
  bonus_exigencias?: string;
  driver_visibility: "PUBLIC" | "PREMIUM";
  cliente_id?: string;
  status: string;
  is_template: boolean;
  sheet_data_carregamento?: string;
  sheet_data_descarga?: string;
}

const CARGAS_QUERY_KEY = ["admin", "cargas-read-model"] as const;
const CLIENTES_QUERY_KEY = ["admin", "clientes-read-model"] as const;
const ROUTES_QUERY_KEY = ["admin", "assignable-routes"];
const LOADING_ROW_COUNT = 6;
const DRAFT_STATUS = "DRAFT";
const OPEN_STATUS = "OPEN";
const PAGE_SIZE = 12;
const ONLINE_SHEET_CLIENT_NAME = "Shopee";
const MANUAL_STATUS_OPTIONS = [DRAFT_STATUS, OPEN_STATUS];
const ADMIN_CARGAS_QUERY_OPTIONS = {
  staleTime: 60_000,
  gcTime: 10 * 60_000,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
  placeholderData: keepPreviousData,
} as const;
const ADMIN_CLIENTES_QUERY_OPTIONS = {
  staleTime: 5 * 60_000,
  gcTime: 10 * 60_000,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
  placeholderData: keepPreviousData,
} as const;
const ADMIN_ROUTES_QUERY_OPTIONS = {
  staleTime: 5 * 60_000,
  gcTime: 10 * 60_000,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
  placeholderData: keepPreviousData,
} as const;

function parseMoneyInput(value?: string) {
  const trimmedValue = value?.trim();

  if (!trimmedValue) {
    return null;
  }

  const cleanedValue = trimmedValue.replace(/[^\d,.-]/g, "");
  const hasComma = cleanedValue.includes(",");
  const hasDot = cleanedValue.includes(".");

  let normalizedValue = cleanedValue;

  if (hasComma && hasDot) {
    normalizedValue =
      cleanedValue.lastIndexOf(",") > cleanedValue.lastIndexOf(".")
        ? cleanedValue.replace(/\./g, "").replace(",", ".")
        : cleanedValue.replace(/,/g, "");
  } else if (hasComma) {
    normalizedValue = cleanedValue.replace(/\./g, "").replace(",", ".");
  } else {
    normalizedValue = cleanedValue.replace(/,/g, "");
  }

  const parsedValue = Number.parseFloat(normalizedValue);
  return Number.isFinite(parsedValue) ? parsedValue : null;
}

function toIsoDatetimeLocal(value: string | null | undefined) {
  if (!value) return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  // Already in ISO datetime-local format (YYYY-MM-DDTHH:mm[:ss])
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?/.test(trimmed)) {
    return trimmed.slice(0, 16);
  }
  // "DD/MM/YYYY HH:mm" (formato comum vindo da planilha)
  const brMatch = trimmed.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (brMatch) {
    const [, day, month, year, hour, minute] = brMatch;
    const h = (hour ?? "00").padStart(2, "0");
    const m = (minute ?? "00").padStart(2, "0");
    return `${year}-${month}-${day}T${h}:${m}`;
  }
  return "";
}

function buildNormalizedCargoSchedule(data: string, horario: string) {
  const now = new Date();
  const fallbackDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const fallbackTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

  return {
    data: normalizeOperatorCargoDate(data, fallbackDate),
    horario: normalizeOperatorCargoTime(horario, fallbackTime),
  };
}

function normalizeClientName(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function isOnlineSheetCargo(cargo?: Pick<Cargo, "sheet_lh"> | null) {
  return typeof cargo?.sheet_lh === "string" && cargo.sheet_lh.trim() !== "";
}

function buildOperatorCargoClientLabel(cargo: Cargo, shopeeClientName?: string | null) {
  if (cargo.clientes?.nome) {
    return cargo.clientes.nome;
  }

  if (isOnlineSheetCargo(cargo) && cargo.cliente_id) {
    return shopeeClientName || ONLINE_SHEET_CLIENT_NAME;
  }

  if (isOnlineSheetCargo(cargo)) {
    return "Cliente pendente de sincronizacao";
  }

  return "-";
}

function formatMoneyValue(value: number) {
  return value.toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

function formatDriverVisibilityLabel(driverVisibility: "PUBLIC" | "PREMIUM") {
  return driverVisibility === "PREMIUM" ? "Premium" : "Publica";
}

function isUnexpectedOperatorRequestError(error: unknown) {
  return error instanceof Error && error.message.includes("Unexpected error while processing the operator request.");
}

const ManageCargas = () => {
  const { user } = useAuth();
  const canEditValues = canWriteMonetaryValues(user);
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [isSyncingSheet, setIsSyncingSheet] = useState(false);
  const [editingCargo, setEditingCargo] = useState<Cargo | null>(null);
  // Default "ativas" = DRAFT + OPEN. O operador s\u00f3 age sobre cargas no ciclo
  // operacional; reservadas/fechadas/expiradas ficam atr\u00e1s dos filtros.
  const [statusFilter, setStatusFilter] = useState<string>("ativas");
  const [visibilityFilter, setVisibilityFilter] = useState<string>("todos");
  const [sourceFilter, setSourceFilter] = useState<string>("todos");
  const [origemFilter, setOrigemFilter] = useState<string>("");
  const [destinoFilter, setDestinoFilter] = useState<string>("");
  const [perfilFilter, setPerfilFilter] = useState<string>("todos");
  // Default de data: dateFrom = hoje, dateTo = hoje + 90 dias.
  // O range estreito anterior (hoje/hoje) escondia as cargas reais da planilha
  // que tem data de carregamento >= D+0 (frequentemente D+3..D+30), levando o
  // operador a abrir /cargas e ver "0 cargas em exibicao" mesmo com cargas
  // ativas na fila. 90 dias cobre o horizonte operacional sem trazer historico.
  const [dateFrom, setDateFrom] = useState<string>(() => new Date().toISOString().slice(0, 10));
  const [dateTo, setDateTo] = useState<string>(() => {
    const future = new Date();
    future.setDate(future.getDate() + 90);
    return future.toISOString().slice(0, 10);
  });
  const [clienteFilter, setClienteFilter] = useState<string>("");
  const [page, setPage] = useState(1);
  const deferredSearch = useDeferredValue(search);
  const deferredStatusFilter = useDeferredValue(statusFilter);
  const deferredVisibilityFilter = useDeferredValue(visibilityFilter);
  const deferredSourceFilter = useDeferredValue(sourceFilter);
  const deferredOrigemFilter = useDeferredValue(origemFilter);
  const deferredDestinoFilter = useDeferredValue(destinoFilter);
  const deferredPerfilFilter = useDeferredValue(perfilFilter);
  const deferredDateFrom = useDeferredValue(dateFrom);
  const deferredDateTo = useDeferredValue(dateTo);
  const deferredClienteFilter = useDeferredValue(clienteFilter);
  // hasActiveFilters reflete se o estado atual difere do estado LIMPO (o que o
  // botão "Limpar filtros" aplica). "Limpar" zera as datas (dateFrom/dateTo = "")
  // para mostrar todas as cargas ativas sem janela de data. Logo, o range
  // default de entrada (hoje .. hoje+90d) JÁ é um filtro ativo — ele esconde
  // cargas fora da janela — e o botão precisa estar habilitado na entrada para
  // o operador poder removê-lo. (Antes o default de data não contava, então o
  // botão ficava bloqueado ao entrar na tela — bug reportado.)
  const hasActiveFilters =
    deferredSearch.trim().length > 0 ||
    deferredStatusFilter !== "ativas" ||
    deferredVisibilityFilter !== "todos" ||
    deferredSourceFilter !== "todos" ||
    deferredOrigemFilter.trim().length > 0 ||
    deferredDestinoFilter.trim().length > 0 ||
    deferredPerfilFilter !== "todos" ||
    deferredDateFrom.length > 0 ||
    deferredDateTo.length > 0 ||
    deferredClienteFilter.length > 0;

  useEffect(() => {
    setPage(1);
  }, [
    deferredSearch,
    deferredStatusFilter,
    deferredVisibilityFilter,
    deferredSourceFilter,
    deferredOrigemFilter,
    deferredDestinoFilter,
    deferredPerfilFilter,
    deferredDateFrom,
    deferredDateTo,
    deferredClienteFilter,
  ]);

  const {
    data: cargasResponse,
    error: cargasError,
    isFetching: cargasFetching,
    isLoading: cargasLoading,
  } = useQuery({
    queryKey: [...CARGAS_QUERY_KEY, deferredSearch.trim(), deferredStatusFilter, deferredVisibilityFilter, deferredSourceFilter, deferredDateFrom, deferredDateTo, deferredClienteFilter, page],
    queryFn: () =>
      fetchOperatorCargas({
        page: String(page),
        pageSize: String(PAGE_SIZE),
        search: deferredSearch.trim(),
        status: deferredStatusFilter,
        driverVisibility: deferredVisibilityFilter,
        source: deferredSourceFilter,
        dateFrom: deferredDateFrom,
        dateTo: deferredDateTo,
        ...(deferredClienteFilter ? { clienteId: deferredClienteFilter } : {}),
      }),
    ...ADMIN_CARGAS_QUERY_OPTIONS,
  });

  const {
    data: clientesResponse,
    error: clientesError,
    isFetching: clientesFetching,
    isLoading: clientesLoading,
  } = useQuery({
    queryKey: [...CLIENTES_QUERY_KEY, "selector"],
    queryFn: async () => {
      const response = await fetchOperatorClientes({
        page: "1",
        pageSize: "200",
        search: "",
      });

      return response.items.map((cliente) => ({
        id: cliente.id,
        nome: cliente.nome,
      })) as Cliente[];
    },
    ...ADMIN_CLIENTES_QUERY_OPTIONS,
  });

  const {
    data: routes = [],
    error: routesError,
    isFetching: routesFetching,
  } = useQuery({
    queryKey: ROUTES_QUERY_KEY,
    queryFn: fetchAssignableRoutes,
    ...ADMIN_ROUTES_QUERY_OPTIONS,
  });

  useEffect(() => {
    if (cargasError) {
      toast.error("Erro ao carregar cargas");
    }
  }, [cargasError]);

  useEffect(() => {
    if (clientesError) {
      toast.error("Erro ao carregar clientes");
    }
  }, [clientesError]);

  useEffect(() => {
    if (routesError) {
      toast.error("Erro ao carregar rotas do catálogo");
    }
  }, [routesError]);
  const rawCargas = useMemo(() => cargasResponse?.items ?? [], [cargasResponse?.items]);
  // Filtros client-side para origem/destino/perfil. Data \u00e9 filtrada no server
  // (read-model), ent\u00e3o o contador `totalCount` j\u00e1 bate com o per\u00edodo escolhido.
  const cargas = useMemo(() => {
    const origem = deferredOrigemFilter.trim().toLowerCase();
    const destino = deferredDestinoFilter.trim().toLowerCase();
    // Usa normalizeVehicleProfile para que aliases (BITRUCK<->BITREM,
    // CARRETA EXPRESSA<->CARRETA_EXPRESSA) batam corretamente entre filtro e cargo.
    const perfilCanonical = deferredPerfilFilter === "todos" ? null : normalizeVehicleProfile(deferredPerfilFilter);

    if (!origem && !destino && !perfilCanonical) {
      return rawCargas;
    }

    return rawCargas.filter((cargo) => {
      if (origem && !(cargo.origem || "").toLowerCase().includes(origem)) return false;
      if (destino && !(cargo.destino || "").toLowerCase().includes(destino)) return false;
      if (perfilCanonical && normalizeVehicleProfile(cargo.perfil) !== perfilCanonical) return false;
      return true;
    });
  }, [
    rawCargas,
    deferredOrigemFilter,
    deferredDestinoFilter,
    deferredPerfilFilter,
  ]);
  const cargasMeta = cargasResponse?.meta || {
    page,
    pageSize: PAGE_SIZE,
    totalCount: 0,
    totalPages: 1,
    hasNextPage: false,
    maxPageSize: PAGE_SIZE,
    correlationId: "",
  };
  const clientes = useMemo(() => clientesResponse || [], [clientesResponse]);
  const shopeeClient = useMemo(
    () => clientes.find((cliente) => normalizeClientName(cliente.nome) === normalizeClientName(ONLINE_SHEET_CLIENT_NAME)) || null,
    [clientes],
  );

  const loading = (cargasLoading && !cargas.length) || (clientesLoading && !clientes.length);
  const isRefreshing = (cargasFetching || clientesFetching || routesFetching) && !loading;
  const pendingPublicationCount = useMemo(
    () =>
      cargas.filter((cargo) => {
        const matchedRoute = resolveAssignableRouteForCargo(routes, {
          route_key: "",
          origem: cargo.origem,
          destino: cargo.destino,
        });

        return !resolveCargoPublicationReadiness(
          {
            perfil: cargo.perfil,
            valor: cargo.valor,
            bonus: cargo.bonus,
            distancia_km: cargo.distancia_km,
            duracao_horas: cargo.duracao_horas,
          },
          matchedRoute,
        ).isReady;
      }).length,
    [cargas, routes],
  );

  const refreshCargoData = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: CARGAS_QUERY_KEY }),
      queryClient.invalidateQueries({ queryKey: ["operator", "dashboard-read-model"] }),
      // Fila operacional consome o mesmo read-model e precisa refletir status atualizado pos-sync.
      queryClient.invalidateQueries({ queryKey: ["operator", "public-load-leads"] }),
      queryClient.invalidateQueries({ queryKey: ["driver", "loads-read-model"] }),
      queryClient.invalidateQueries({ queryKey: ["driver", "loads-facets"] }),
    ]);
  };

  const handleSyncSheet = async () => {
    if (isSyncingSheet) return;
    if (!confirmAction("Atualizar as cargas a partir da planilha? Isso pode levar alguns segundos.")) {
      return;
    }
    try {
      setIsSyncingSheet(true);
      const result = await syncOperatorCargasSheet();
      await refreshCargoData();
      const insertedLabel = typeof result.inserted === "number" ? ` ${result.inserted} nova(s)` : "";
      const updatedLabel = typeof result.updated === "number" ? ` · ${result.updated} atualizada(s)` : "";
      toast.success(`Cargas atualizadas da planilha.${insertedLabel}${updatedLabel}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Não foi possível sincronizar a planilha agora.");
    } finally {
      setIsSyncingSheet(false);
    }
  };

  const handleSave = async (data: CargoFormData) => {
    const isEditing = Boolean(editingCargo);
    const confirmTitle = isEditing ? "Salvar alterações desta carga?" : "Cadastrar esta nova carga?";
    if (!confirmAction(confirmTitle)) {
      return;
    }
    try {
      const selectedRoute = resolveAssignableRouteForCargo(routes, data);
      // When editing an existing cargo, preserve the operator's manual input for valor/bonus/perfil.
      // Auto-assignment only applies to new cargo creation.
      const autoAssignedCargo = editingCargo
        ? data
        : applyAssignableRouteToCargoDraft(data, selectedRoute);
      const normalizedSchedule = buildNormalizedCargoSchedule(autoAssignedCargo.data, autoAssignedCargo.horario);
      const shouldForceShopeeClient = isOnlineSheetCargo(editingCargo);
      const nextClientId = shouldForceShopeeClient
        ? shopeeClient?.id || editingCargo?.cliente_id || autoAssignedCargo.cliente_id || ""
        : autoAssignedCargo.cliente_id || "";
      const routeMetrics =
        selectedRoute &&
        selectedRoute.distancia_km !== null &&
        selectedRoute.duracao_horas !== null
          ? {
              distancia_km: selectedRoute.distancia_km,
              duracao_horas: selectedRoute.duracao_horas,
            }
          : editingCargo &&
              editingCargo.origem === data.origem &&
              editingCargo.destino === data.destino &&
              editingCargo.distancia_km !== undefined &&
              editingCargo.duracao_horas !== undefined
          ? {
              distancia_km: editingCargo.distancia_km ?? null,
              duracao_horas: editingCargo.duracao_horas ?? null,
            }
          : await resolveRouteMetrics(data.origem, data.destino).catch((error) => {
              if (import.meta.env.DEV) console.error("Erro ao calcular rota da carga", {
                origin: data.origem,
                destination: data.destino,
                message: error instanceof Error ? error.message : String(error),
              });

              toast.warning("Não foi possível calcular KM agora. A carga foi salva sem distância.");

              return {
                distancia_km: null,
                duracao_horas: null,
              };
            });

      const payload: OperatorCargoPayload = {
        data: normalizedSchedule.data,
        horario: normalizedSchedule.horario,
        origem: autoAssignedCargo.origem,
        destino: autoAssignedCargo.destino,
        distancia_km: routeMetrics.distancia_km,
        duracao_horas: routeMetrics.duracao_horas,
        perfil: autoAssignedCargo.perfil,
        valor: parseMoneyInput(autoAssignedCargo.valor),
        bonus: parseMoneyInput(autoAssignedCargo.bonus),
        bonus_exigencias: autoAssignedCargo.bonus_exigencias?.trim() || null,
        driver_visibility: autoAssignedCargo.driver_visibility,
        cliente_id: nextClientId || null,
        status:
          editingCargo && !MANUAL_STATUS_OPTIONS.includes(editingCargo.status)
            ? editingCargo.status
            : autoAssignedCargo.status,
        is_template: autoAssignedCargo.is_template,
        sheet_data_carregamento: autoAssignedCargo.sheet_data_carregamento?.trim() || null,
        sheet_data_descarga: autoAssignedCargo.sheet_data_descarga?.trim() || null,
      };

      const saveCargoMutation = async (nextPayload: typeof payload) => {
        return editingCargo?.id
          ? updateOperatorCargo(editingCargo.id, nextPayload)
          : createOperatorCargo(nextPayload);
      };

      let usedLegacyBonusRulesFallback = false;
      let response;

      try {
        response = await saveCargoMutation(payload);
      } catch (error) {
        const canRetryWithoutBonusRules =
          typeof payload.bonus_exigencias === "string" &&
          payload.bonus_exigencias.trim() !== "" &&
          isUnexpectedOperatorRequestError(error);

        if (!canRetryWithoutBonusRules) {
          toast.error(error instanceof Error ? error.message : editingCargo ? "Erro ao atualizar carga" : "Erro ao cadastrar carga");
          return;
        }

        try {
          response = await saveCargoMutation({
            ...payload,
            bonus_exigencias: null,
          });
          usedLegacyBonusRulesFallback = true;
        } catch (retryError) {
          toast.error(
            retryError instanceof Error ? retryError.message : editingCargo ? "Erro ao atualizar carga" : "Erro ao cadastrar carga",
          );
          return;
        }
      }

      response?.warnings?.forEach((warning) => {
        toast.warning(warning);
      });

      if (usedLegacyBonusRulesFallback) {
        toast.warning("A carga foi salva, mas as regras do bônus não foram persistidas porque essa coluna ainda não existe no banco.");
      }

      toast.success(editingCargo ? "Carga atualizada!" : "Carga cadastrada!");

      setModalOpen(false);
      setEditingCargo(null);
      await refreshCargoData();
    } catch (outerError) {
      if (import.meta.env.DEV) console.error("[ManageCargas] handleSave failed", outerError);
      toast.error(
        outerError instanceof Error
          ? outerError.message
          : editingCargo
            ? "Erro inesperado ao atualizar carga. Verifique o console."
            : "Erro inesperado ao cadastrar carga. Verifique o console.",
      );
    }
  };

  const handleDuplicate = async (cargo: Cargo) => {
    try {
      const response = await duplicateOperatorCargo(cargo.id);

      response.warnings?.forEach((warning) => {
        toast.warning(warning);
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Erro ao duplicar");
      return;
    }

    toast.success("Carga duplicada como rascunho!");
    await refreshCargoData();
  };

  const toggleStatus = async (cargo: Cargo) => {
    if (!MANUAL_STATUS_OPTIONS.includes(cargo.status)) {
      toast.error("Somente cargas abertas ou em rascunho podem ser publicadas manualmente.");
      return;
    }

    const newStatus = cargo.status === OPEN_STATUS ? DRAFT_STATUS : OPEN_STATUS;

    if (newStatus === OPEN_STATUS) {
      const matchedRoute = resolveAssignableRouteForCargo(routes, {
        route_key: "",
        origem: cargo.origem,
        destino: cargo.destino,
      });
      const publication = resolveCargoPublicationReadiness(
        {
          perfil: cargo.perfil,
          valor: cargo.valor,
          bonus: cargo.bonus,
          distancia_km: cargo.distancia_km,
          duracao_horas: cargo.duracao_horas,
        },
        matchedRoute,
      );

      if (!publication.isReady) {
        toast.warning(
          publication.alertSummary || "Complete os dados da carga antes de liberar esta oferta no portal do motorista.",
        );
        return;
      }
    }

    try {
      await toggleOperatorCargoStatus(cargo.id);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Erro ao alterar status");
      return;
    }

    toast.success(`Carga ${newStatus === OPEN_STATUS ? "aberta" : "movida para rascunho"}!`);
    await refreshCargoData();
  };

  const handleDelete = async (id: string) => {
    if (!confirmAction("Excluir esta carga?", "Esta ação é permanente e não pode ser desfeita.")) {
      return;
    }
    try {
      await deleteOperatorCargo(id);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Erro ao excluir carga");
      return;
    }

    toast.success("Carga excluida!");
    await refreshCargoData();
  };

  return (
    <div className="min-w-0">
      <DashboardHeader title="Gerenciar Cargas" />

      <main className="min-w-0 space-y-5 p-6 lg:p-8">
        <section className="admin-panel overflow-hidden p-5 lg:p-6">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.28em] text-primary/60">Operação diária</p>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <h2 className="text-2xl font-semibold tracking-tight text-foreground">
                  {(() => {
                    const hasClientFilters = Boolean(
                      deferredOrigemFilter.trim() || deferredDestinoFilter.trim() || deferredPerfilFilter !== "todos"
                    );
                    const total = cargasMeta.totalCount ?? 0;
                    return hasClientFilters
                      ? `${cargas.length} de ${total} carga${total === 1 ? "" : "s"} em exibicao`
                      : `${total} carga${total === 1 ? "" : "s"} em exibicao`;
                  })()}
                </h2>
                {isRefreshing ? (
                  <span className="inline-flex items-center gap-2 rounded-full border border-primary/12 bg-primary/8 px-3 py-1 text-xs font-semibold text-primary">
                    <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                    Atualizando
                  </span>
                ) : null}
              </div>
            </div>

            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:flex-wrap">
              <div className="relative min-w-[280px] flex-1">
                <Search className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  type="text"
                  placeholder="Pesquisar por origem, destino ou cliente..."
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  className="w-full rounded-2xl border border-border/80 bg-white/92 py-3 pl-11 pr-4 text-sm text-foreground outline-none transition-all duration-200 placeholder:text-muted-foreground focus:border-primary/30 focus:ring-4 focus:ring-primary/10"
                />
              </div>

              <select
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value)}
                className="rounded-2xl border border-border/80 bg-white/92 px-4 py-3 text-sm text-foreground outline-none transition-all duration-200 focus:border-primary/30 focus:ring-4 focus:ring-primary/10 cursor-pointer"
              >
                {/*
                  Dropdown focado no ciclo operacional. RESERVED/BOOKED/EXPIRED/
                  CANCELLED/COMPLETED/FAILED foram retirados daqui a pedido do
                  operador: essas cargas n\u00e3o exigem a\u00e7\u00e3o na tela de Cargas.
                  "Ativas" = Rascunhos + Abertas (default).
                */}
                <option value="ativas">Ativas (rascunhos + abertas)</option>
                <option value="aguardando_dados">Aguardando dados</option>
                <option value={OPEN_STATUS}>Abertas</option>
                <option value={DRAFT_STATUS}>Rascunhos</option>
                <option value="todos">Todas (inclui hist\u00f3rico)</option>
              </select>

              <select
                value={visibilityFilter}
                onChange={(event) => setVisibilityFilter(event.target.value)}
                className="rounded-2xl border border-border/80 bg-white/92 px-4 py-3 text-sm text-foreground outline-none transition-all duration-200 focus:border-primary/30 focus:ring-4 focus:ring-primary/10 cursor-pointer"
              >
                <option value="todos">Toda visibilidade</option>
                <option value="PUBLIC">Publica</option>
                <option value="PREMIUM">Premium</option>
              </select>

              <select
                value={sourceFilter}
                onChange={(event) => setSourceFilter(event.target.value)}
                className="rounded-2xl border border-border/80 bg-white/92 px-4 py-3 text-sm text-foreground outline-none transition-all duration-200 focus:border-primary/30 focus:ring-4 focus:ring-primary/10 cursor-pointer"
              >
                <option value="todos">Toda origem</option>
                <option value="manual">Cadastro manual</option>
                <option value="planilha">Planilha online</option>
              </select>

              <input
                type="text"
                placeholder="Origem"
                value={origemFilter}
                onChange={(event) => setOrigemFilter(event.target.value)}
                className="rounded-2xl border border-border/80 bg-white/92 px-4 py-3 text-sm text-foreground outline-none transition-all duration-200 placeholder:text-muted-foreground focus:border-primary/30 focus:ring-4 focus:ring-primary/10"
              />

              <input
                type="text"
                placeholder="Destino"
                value={destinoFilter}
                onChange={(event) => setDestinoFilter(event.target.value)}
                className="rounded-2xl border border-border/80 bg-white/92 px-4 py-3 text-sm text-foreground outline-none transition-all duration-200 placeholder:text-muted-foreground focus:border-primary/30 focus:ring-4 focus:ring-primary/10"
              />

              <select
                value={perfilFilter}
                onChange={(event) => setPerfilFilter(event.target.value)}
                className="rounded-2xl border border-border/80 bg-white/92 px-4 py-3 text-sm text-foreground outline-none transition-all duration-200 focus:border-primary/30 focus:ring-4 focus:ring-primary/10 cursor-pointer"
              >
                <option value="todos">Todo perfil</option>
                {VEHICLE_PROFILE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>

              <input
                type="date"
                value={dateFrom}
                onChange={(event) => setDateFrom(event.target.value)}
                className="rounded-2xl border border-border/80 bg-white/92 px-4 py-3 text-sm text-foreground outline-none transition-all duration-200 focus:border-primary/30 focus:ring-4 focus:ring-primary/10"
                title="Data inicial (default: hoje)"
                aria-label="Data inicial do filtro (default: hoje)"
              />

              <input
                type="date"
                value={dateTo}
                onChange={(event) => setDateTo(event.target.value)}
                className="rounded-2xl border border-border/80 bg-white/92 px-4 py-3 text-sm text-foreground outline-none transition-all duration-200 focus:border-primary/30 focus:ring-4 focus:ring-primary/10"
                title="Data final (default: hoje + 90 dias)"
                aria-label="Data final do filtro (default: hoje + 90 dias)"
              />

              <select
                value={clienteFilter}
                onChange={(event) => setClienteFilter(event.target.value)}
                className="rounded-2xl border border-border/80 bg-white/92 px-4 py-3 text-sm text-foreground outline-none transition-all duration-200 focus:border-primary/30 focus:ring-4 focus:ring-primary/10 cursor-pointer"
              >
                <option value="">Todos os clientes</option>
                {clientes.map((c) => (
                  <option key={c.id} value={c.id}>{c.nome}</option>
                ))}
              </select>

              <button
                type="button"
                onClick={() => {
                  setSearch("");
                  setStatusFilter("ativas");
                  setVisibilityFilter("todos");
                  setSourceFilter("todos");
                  setOrigemFilter("");
                  setDestinoFilter("");
                  setPerfilFilter("todos");
                  // Limpa de fato as datas de coleta/entrega (sem range). Datas
                  // vazias contam como "sem filtro" no hasActiveFilters e o
                  // servidor retorna todas as cargas ativas — sem o bug de
                  // "0 cargas" (verificado). Antes restaurava hoje..hoje+90, o
                  // que deixava as datas presas e nao limpava o filtro.
                  setDateFrom("");
                  setDateTo("");
                  setClienteFilter("");
                }}
                disabled={!hasActiveFilters}
                className="inline-flex items-center justify-center rounded-2xl border border-border/80 bg-white/92 px-4 py-3 text-sm font-semibold text-foreground transition-colors duration-200 hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
              >
                Limpar filtros
              </button>

              <button
                type="button"
                onClick={() => void handleSyncSheet()}
                disabled={isSyncingSheet}
                className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-2xl border border-primary/20 bg-primary/8 px-4 py-3 text-sm font-semibold text-primary transition-colors hover:bg-primary/12 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-primary/15"
                title="Busca novas cargas na planilha do Google Sheets e atualiza as existentes"
              >
                <RefreshCw className={`h-4 w-4${isSyncingSheet ? " animate-spin" : ""}`} />
                {isSyncingSheet ? "Atualizando..." : "Atualizar cargas"}
              </button>

              <button
                type="button"
                onClick={() => setImportModalOpen(true)}
                className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-2xl border border-primary/20 bg-primary/8 px-4 py-3 text-sm font-semibold text-primary transition-colors hover:bg-primary/12 dark:bg-primary/15"
                title="Importa várias cargas de uma vez a partir de um arquivo CSV"
              >
                <Upload className="h-4 w-4" />
                Importar programação
              </button>

              <button
                onClick={() => {
                  setEditingCargo(null);
                  setModalOpen(true);
                }}
                className="admin-primary-button inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-2xl px-5 py-3 text-sm font-semibold text-white cursor-pointer"
              >
                <Plus className="h-4 w-4" />
                Nova carga
              </button>
            </div>
          </div>
        </section>

        {pendingPublicationCount > 0 ? (
          <section className="admin-panel border border-amber-200/80 bg-amber-50/90 p-4 shadow-none dark:border-amber-400/30 dark:bg-amber-500/10">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex items-start gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-amber-100 text-amber-700">
                  <AlertTriangle className="h-5 w-5" />
                </span>
                <div className="space-y-1">
                  <p className="text-sm font-semibold text-amber-950">
                    {pendingPublicationCount} carga{pendingPublicationCount === 1 ? "" : "s"} aguardando dados para aparecer no portal
                  </p>
                  <p className="text-sm leading-relaxed text-amber-900/80">
                    Complete perfil do veículo, frete, distância e tempo estimado para liberar essas cargas ao motorista.
                  </p>
                </div>
              </div>
            </div>
          </section>
        ) : null}

        <section className="admin-panel overflow-hidden">
          {/* ── Tabela desktop ── */}
          <div className="hidden overflow-x-auto overscroll-x-contain pb-1 md:block">
            <table className="w-full min-w-[860px] text-sm">
              <thead>
                <tr className="border-b border-border/60 bg-primary/[0.032]">
                  {(["LH", "Carregamento", "Descarga", "Cliente / Rota", "Veículo", "Compensação", "Status", ""] as const).map((col) => (
                    <th
                      key={col}
                      className={`px-4 py-3.5 text-xs font-semibold uppercase tracking-[0.22em] text-muted-foreground/80 ${col === "Compensação" ? "text-right" : col === "" ? "text-right" : "text-left"}`}
                    >
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>

              <tbody className="divide-y divide-border/50">
                {loading ? (
                  Array.from({ length: LOADING_ROW_COUNT }, (_, i) => (
                    <tr key={`sk-${i}`}>
                      <td className="px-4 py-5" colSpan={8}>
                        <div className="flex animate-pulse items-center gap-4">
                          <div className="h-9 w-9 shrink-0 rounded-xl bg-muted/60" />
                          <div className="flex-1 space-y-2">
                            <div className="h-3.5 w-32 rounded-full bg-muted/70" />
                            <div className="h-3 w-48 rounded-full bg-muted/40" />
                          </div>
                          <div className="h-3 w-20 rounded-full bg-muted/40" />
                          <div className="h-3 w-24 rounded-full bg-muted/40" />
                          <div className="h-6 w-20 rounded-full bg-muted/40" />
                        </div>
                      </td>
                    </tr>
                  ))
                ) : cargas.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-4 py-16 text-center">
                      <div className="flex flex-col items-center gap-2 text-muted-foreground">
                        <Package className="h-8 w-8 opacity-30" />
                        <p className="text-sm font-medium">
                          {hasActiveFilters ? "Nenhuma carga com esses filtros." : "Nenhuma carga cadastrada ainda."}
                        </p>
                      </div>
                    </td>
                  </tr>
                ) : (
                  cargas.map((cargo, index) => {
                    const displayDate = formatDateOnly(cargo.data, "A confirmar");
                    const displayTime = normalizeOperatorCargoTime(cargo.horario, "A confirmar");
                    const matchedRoute = resolveAssignableRouteForCargo(routes, {
                      route_key: "",
                      origem: cargo.origem,
                      destino: cargo.destino,
                    });
                    const publication = resolveCargoPublicationReadiness(
                      { perfil: cargo.perfil, valor: cargo.valor, bonus: cargo.bonus, distancia_km: cargo.distancia_km, duracao_horas: cargo.duracao_horas },
                      matchedRoute,
                    );
                    const paymentBreakdown = resolveCargoCompensation({ valor: cargo.valor, bonus: cargo.bonus }, matchedRoute);

                    const statusConfig: Record<string, { dot: string; bg: string; text: string }> = {
                      OPEN:      { dot: "bg-emerald-500",  bg: "bg-emerald-50  text-emerald-800",  text: "Aberta"    },
                      DRAFT:     { dot: "bg-slate-400",    bg: "bg-slate-100   text-slate-700",    text: "Rascunho"  },
                      RESERVED:  { dot: "bg-amber-500",    bg: "bg-amber-50    text-amber-800",    text: "Reservada" },
                      BOOKED:    { dot: "bg-teal-500",     bg: "bg-teal-50     text-teal-800",     text: "Fechada"   },
                      EXPIRED:   { dot: "bg-red-400",      bg: "bg-red-50      text-red-700",      text: "Expirada"  },
                      CANCELLED: { dot: "bg-zinc-400",     bg: "bg-zinc-100    text-zinc-600",     text: "Cancelada" },
                      COMPLETED: { dot: "bg-blue-500",     bg: "bg-blue-50     text-blue-800",     text: "Concluída" },
                      FAILED:    { dot: "bg-rose-500",     bg: "bg-rose-50     text-rose-800",     text: "Falhou"    },
                    };
                    const sc = statusConfig[cargo.status] ?? { dot: "bg-gray-400", bg: "bg-muted text-muted-foreground", text: cargo.status };

                    return (
                      <tr
                        key={cargo.id}
                        className="group transition-colors duration-150 hover:bg-primary/[0.025]"
                        style={{ animationDelay: `${index * 40}ms` }}
                      >
                        {/* LH */}
                        <td className="whitespace-nowrap px-4 py-4 align-middle">
                          {cargo.sheet_lh ? (
                            <span className="inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary">
                              {cargo.sheet_lh}
                            </span>
                          ) : (
                            <span className="text-xs text-muted-foreground/60">—</span>
                          )}
                        </td>

                        {/* Carregamento */}
                        <td className="whitespace-nowrap px-4 py-4 align-middle">
                          {cargo.sheet_data_carregamento ? (
                            <p className="text-sm font-semibold text-foreground">{cargo.sheet_data_carregamento}</p>
                          ) : (
                            <>
                              <p className="text-sm font-semibold text-foreground">{displayDate}</p>
                              <p className="mt-0.5 text-xs text-muted-foreground">{displayTime}</p>
                            </>
                          )}
                        </td>

                        {/* Descarga */}
                        <td className="whitespace-nowrap px-4 py-4 align-middle">
                          {cargo.sheet_data_descarga ? (
                            <p className="text-sm font-semibold text-foreground">{cargo.sheet_data_descarga}</p>
                          ) : (
                            <span className="text-xs text-muted-foreground/60">A confirmar</span>
                          )}
                        </td>

                        {/* Cliente / Rota */}
                        <td className="px-4 py-4 align-middle">
                          <p className="text-sm font-semibold text-foreground leading-snug">
                            {buildOperatorCargoClientLabel(cargo, shopeeClient?.nome)}
                          </p>
                          <div className="mt-1 flex items-center gap-1.5">
                            <span className="max-w-[120px] truncate text-xs text-muted-foreground">{cargo.origem}</span>
                            <span className="text-muted-foreground/40">→</span>
                            <span className="max-w-[120px] truncate text-xs text-muted-foreground">{cargo.destino}</span>
                          </div>
                          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                            {matchedRoute ? (
                              <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${matchedRoute.ativa ? "bg-primary/8 text-primary" : "bg-muted text-muted-foreground"}`}>
                                {matchedRoute.ativa ? "Catálogo ativo" : "Catálogo inativo"}
                              </span>
                            ) : (
                              <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">Rota manual</span>
                            )}
                            {cargo.is_template && (
                              <span className="inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">Template</span>
                            )}
                            {!publication.isReady && (
                              <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-800">
                                <AlertTriangle className="h-2.5 w-2.5" />
                                {publication.alertSummary || "Dados pendentes"}
                              </span>
                            )}
                          </div>
                        </td>

                        {/* Veículo */}
                        <td className="whitespace-nowrap px-4 py-4 align-middle">
                          <span className="inline-flex items-center rounded-lg bg-muted/60 px-2.5 py-1 text-xs font-semibold text-foreground">
                            {publication.perfil || "—"}
                          </span>
                          {(cargo.distancia_km ?? 0) > 0 && (
                            <p className="mt-1 text-xs text-muted-foreground">{cargo.distancia_km?.toFixed(0)} km</p>
                          )}
                        </td>

                        {/* Compensação */}
                        <td className="whitespace-nowrap px-4 py-4 align-middle text-right">
                          <p className="text-sm font-bold tabular-nums text-foreground">
                            {paymentBreakdown.total !== null ? formatMoneyValue(paymentBreakdown.total) : "—"}
                          </p>
                          {typeof paymentBreakdown.bonus === "number" && paymentBreakdown.bonus > 0 ? (
                            <p className="mt-0.5 text-[11px] font-medium text-emerald-700">
                              +{formatMoneyValue(paymentBreakdown.bonus)} bônus
                            </p>
                          ) : paymentBreakdown.total !== null && paymentBreakdown.source !== "cargo" ? (
                            <p className="mt-0.5 text-[11px] text-muted-foreground">Valor padrão</p>
                          ) : null}
                        </td>

                        {/* Status */}
                        <td className="px-4 py-4 align-middle">
                          <div className="flex flex-col gap-1.5">
                            <span className={`inline-flex w-fit items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${sc.bg}`}>
                              <span className={`h-1.5 w-1.5 rounded-full ${sc.dot}`} />
                              {sc.text}
                            </span>
                            <span className={`inline-flex w-fit items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                              cargo.driver_visibility === "PREMIUM"
                                ? "bg-orange-100 text-orange-700"
                                : "bg-sky-100 text-sky-700"
                            }`}>
                              {cargo.driver_visibility === "PREMIUM" ? "Premium" : "Pública"}
                            </span>
                          </div>
                        </td>

                        {/* Ações */}
                        <td className="whitespace-nowrap px-4 py-4 align-middle">
                          <div className="flex items-center justify-end gap-1.5">
                            {MANUAL_STATUS_OPTIONS.includes(cargo.status) && (
                              <button
                                onClick={() => toggleStatus(cargo)}
                                title={cargo.status === OPEN_STATUS ? "Voltar para rascunho" : "Abrir carga"}
                                className="flex h-8 w-8 items-center justify-center rounded-lg border border-primary/10 bg-primary/5 text-primary transition-all duration-150 hover:bg-primary/12 hover:scale-105 cursor-pointer"
                              >
                                {cargo.status === OPEN_STATUS ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                              </button>
                            )}
                            <button
                              onClick={() => handleDuplicate(cargo)}
                              title="Duplicar"
                              className="flex h-8 w-8 items-center justify-center rounded-lg border border-border/70 bg-white/80 text-muted-foreground transition-all duration-150 hover:bg-muted hover:text-foreground hover:scale-105 cursor-pointer"
                            >
                              <Copy className="h-3.5 w-3.5" />
                            </button>
                            <button
                              onClick={() => { setEditingCargo(cargo); setModalOpen(true); }}
                              title="Editar"
                              className="flex h-8 w-8 items-center justify-center rounded-lg border border-primary/10 bg-primary/5 text-primary transition-all duration-150 hover:bg-primary/12 hover:scale-105 cursor-pointer"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                            <button
                              onClick={() => handleDelete(cargo.id)}
                              title="Excluir"
                              className="flex h-8 w-8 items-center justify-center rounded-lg border border-destructive/15 bg-destructive/5 text-destructive transition-all duration-150 hover:bg-destructive/10 hover:scale-105 cursor-pointer"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {/* ── Cards mobile ── */}
          <div className="flex flex-col divide-y divide-border/50 md:hidden">
            {loading ? (
              Array.from({ length: 4 }, (_, i) => (
                <div key={`msk-${i}`} className="animate-pulse space-y-3 p-4">
                  <div className="flex items-center justify-between">
                    <div className="h-4 w-28 rounded-full bg-muted/70" />
                    <div className="h-5 w-16 rounded-full bg-muted/50" />
                  </div>
                  <div className="h-3 w-40 rounded-full bg-muted/50" />
                  <div className="h-3 w-24 rounded-full bg-muted/40" />
                </div>
              ))
            ) : cargas.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-12 text-muted-foreground">
                <Package className="h-7 w-7 opacity-30" />
                <p className="text-sm">{hasActiveFilters ? "Nenhuma carga com esses filtros." : "Nenhuma carga cadastrada ainda."}</p>
              </div>
            ) : (
              cargas.map((cargo) => {
                const displayDate = formatDateOnly(cargo.data, "A confirmar");
                const displayTime = normalizeOperatorCargoTime(cargo.horario, "A confirmar");
                const matchedRoute = resolveAssignableRouteForCargo(routes, { route_key: "", origem: cargo.origem, destino: cargo.destino });
                const publication = resolveCargoPublicationReadiness(
                  { perfil: cargo.perfil, valor: cargo.valor, bonus: cargo.bonus, distancia_km: cargo.distancia_km, duracao_horas: cargo.duracao_horas },
                  matchedRoute,
                );
                const paymentBreakdown = resolveCargoCompensation({ valor: cargo.valor, bonus: cargo.bonus }, matchedRoute);
                const statusDot: Record<string, string> = {
                  OPEN: "bg-emerald-500", DRAFT: "bg-slate-400", RESERVED: "bg-amber-500",
                  BOOKED: "bg-teal-500", EXPIRED: "bg-red-400", CANCELLED: "bg-zinc-400",
                };

                return (
                  <div key={cargo.id} className="space-y-3 p-4 transition-colors hover:bg-primary/[0.025]">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-foreground">
                          {buildOperatorCargoClientLabel(cargo, shopeeClient?.nome)}
                        </p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {cargo.origem} → {cargo.destino}
                        </p>
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        <span className="flex items-center gap-1.5 rounded-full bg-muted/60 px-2.5 py-1 text-[11px] font-semibold text-foreground">
                          <span className={`h-1.5 w-1.5 rounded-full ${statusDot[cargo.status] ?? "bg-gray-400"}`} />
                          {formatCargoStatusLabel(cargo.status)}
                        </span>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">{displayDate}</span>
                      <span>·</span>
                      <span>{displayTime}</span>
                      <span>·</span>
                      <span>{publication.perfil || "Perfil pendente"}</span>
                      {paymentBreakdown.total !== null && (
                        <>
                          <span>·</span>
                          <span className="font-semibold text-foreground">{formatMoneyValue(paymentBreakdown.total)}</span>
                        </>
                      )}
                    </div>

                    {!publication.isReady && (
                      <p className="flex items-center gap-1 text-xs font-medium text-amber-700">
                        <AlertTriangle className="h-3 w-3" />
                        {publication.alertSummary || "Dados pendentes para publicação"}
                      </p>
                    )}

                    <div className="flex items-center justify-between">
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${cargo.driver_visibility === "PREMIUM" ? "bg-orange-100 text-orange-700" : "bg-sky-100 text-sky-700"}`}>
                        {cargo.driver_visibility === "PREMIUM" ? "Premium" : "Pública"}
                      </span>
                      <div className="flex items-center gap-1.5">
                        {MANUAL_STATUS_OPTIONS.includes(cargo.status) && (
                          <button onClick={() => toggleStatus(cargo)} className="flex h-8 w-8 items-center justify-center rounded-lg border border-primary/10 bg-primary/5 text-primary cursor-pointer">
                            {cargo.status === OPEN_STATUS ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                          </button>
                        )}
                        <button onClick={() => handleDuplicate(cargo)} className="flex h-8 w-8 items-center justify-center rounded-lg border border-border/70 bg-white/80 text-muted-foreground cursor-pointer">
                          <Copy className="h-3.5 w-3.5" />
                        </button>
                        <button onClick={() => { setEditingCargo(cargo); setModalOpen(true); }} className="flex h-8 w-8 items-center justify-center rounded-lg border border-primary/10 bg-primary/5 text-primary cursor-pointer">
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button onClick={() => handleDelete(cargo.id)} className="flex h-8 w-8 items-center justify-center rounded-lg border border-destructive/15 bg-destructive/5 text-destructive cursor-pointer">
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </section>

        <AdminPagination
          page={cargasMeta.page}
          totalPages={cargasMeta.totalPages}
          totalCount={cargasMeta.totalCount}
          pageSize={cargasMeta.pageSize}
          itemLabel={`carga${cargasMeta.totalCount === 1 ? "" : "s"}`}
          isFetching={isRefreshing}
          onPrevious={() => setPage((currentPage) => Math.max(currentPage - 1, 1))}
          onNext={() => setPage((currentPage) => Math.min(currentPage + 1, cargasMeta.totalPages))}
        />
      </main>

      <ImportProgramacaoModal
        open={importModalOpen}
        onClose={() => setImportModalOpen(false)}
        onImported={refreshCargoData}
      />

      <CargoModal
        open={modalOpen}
        onClose={() => {
          setModalOpen(false);
          setEditingCargo(null);
        }}
        onSave={handleSave}
        clientes={clientes}
        routes={routes}
        initialData={
          editingCargo
            ? {
                ...buildNormalizedCargoSchedule(editingCargo.data, editingCargo.horario),
                route_key:
                  resolveAssignableRouteForCargo(routes, {
                    route_key: "",
                    origem: editingCargo.origem,
                    destino: editingCargo.destino,
                  })?.route_key || "",
                origem: editingCargo.origem,
                destino: editingCargo.destino,
                perfil: editingCargo.perfil,
                valor: editingCargo.valor?.toString() || "",
                bonus: editingCargo.bonus?.toString() || "",
                bonus_exigencias: editingCargo.bonus_exigencias || "",
                driver_visibility: editingCargo.driver_visibility || "PUBLIC",
                cliente_id:
                  isOnlineSheetCargo(editingCargo) && shopeeClient?.id
                    ? shopeeClient.id
                    : editingCargo.cliente_id || "",
                status: editingCargo.status,
                is_template: editingCargo.is_template,
                sheet_data_carregamento: toIsoDatetimeLocal(editingCargo.sheet_data_carregamento),
                sheet_data_descarga: toIsoDatetimeLocal(editingCargo.sheet_data_descarga),
              }
            : null
        }
        lockedClientId={
          editingCargo && isOnlineSheetCargo(editingCargo)
            ? shopeeClient?.id || editingCargo.cliente_id || ""
            : ""
        }
        lockedClientLabel={editingCargo && isOnlineSheetCargo(editingCargo) ? shopeeClient?.nome || ONLINE_SHEET_CLIENT_NAME : ""}
        canEditValues={canEditValues}
      />
    </div>
  );
};

export default ManageCargas;
