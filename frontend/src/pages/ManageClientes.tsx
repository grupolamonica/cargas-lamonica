import { useDeferredValue, useEffect, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Building2,
  Clock3,
  CreditCard,
  IdCard,
  MessageSquare,
  Package,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Shield,
  Trash2,
  Truck,
  Zap,
} from "lucide-react";
import { toast } from "sonner";

import AdminPagination from "@/components/AdminPagination";
import ClienteModal from "@/components/ClienteModal";
import ClientLogo from "@/components/ClientLogo";
import DashboardHeader from "@/components/DashboardHeader";
import { useAuth } from "@/hooks/useAuth";
import { type Cliente, type ClienteFormData, mapClienteFormToPayload } from "@/lib/clientes";
import { canWriteOperatorClientes, getOperatorAccessLevel, getOperatorAccessLevelLabel } from "@/lib/operatorAccess";
import {
  createOperatorCliente,
  deleteOperatorCliente,
  updateOperatorCliente,
} from "@/services/operatorAdmin";
import { fetchOperatorClientes } from "@/services/readModels";
import { cn } from "@/lib/utils";
import { confirmAction } from "@/lib/confirm";

const CLIENTES_QUERY_KEY = ["admin", "clientes-read-model"] as const;
const LOADING_CARD_COUNT = 4;
const PAGE_SIZE = 8;
const ADMIN_CLIENTES_QUERY_OPTIONS = {
  staleTime: 60_000,
  gcTime: 10 * 60_000,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
  placeholderData: keepPreviousData,
} as const;

const requirementOptions = [
  { key: "exige_rastreamento", label: "Rastreamento", icon: Search },
  { key: "exige_antt", label: "ANTT", icon: IdCard },
  { key: "exige_seguro", label: "Seguro", icon: Shield },
  { key: "exige_carga_monitorada", label: "Carga monitorada", icon: Truck },
] as const;

const reputationOptions = [
  { key: "reputacao_pagamento_rapido", label: "Pagamento rapido", icon: Clock3 },
  { key: "reputacao_bom_pagador", label: "Bom pagador", icon: CreditCard },
  { key: "reputacao_liberacao_rapida", label: "Liberacao rapida", icon: Zap },
  { key: "reputacao_carga_organizada", label: "Carga organizada", icon: Package },
  { key: "reputacao_boa_comunicacao", label: "Boa comunicacao", icon: MessageSquare },
] as const;

const ManageClientes = () => {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [editingCliente, setEditingCliente] = useState<Cliente | null>(null);
  const [page, setPage] = useState(1);
  const deferredSearch = useDeferredValue(search);

  useEffect(() => {
    setPage(1);
  }, [deferredSearch]);

  const {
    data: clientesResponse,
    error,
    isFetching,
    isLoading,
  } = useQuery({
    queryKey: [...CLIENTES_QUERY_KEY, deferredSearch.trim(), page],
    queryFn: async () => {
      const response = await fetchOperatorClientes({
        page: String(page),
        pageSize: String(PAGE_SIZE),
        search: deferredSearch.trim(),
      });

      return {
        items: response.items as Cliente[],
        meta: response.meta,
      };
    },
    ...ADMIN_CLIENTES_QUERY_OPTIONS,
  });

  useEffect(() => {
    if (!error) {
      return;
    }

    toast.error("Erro ao carregar embarcadores");
  }, [error]);

  const clientes = clientesResponse?.items || [];
  const operatorAccessLevel = getOperatorAccessLevel(user);
  const canManageClientes = canWriteOperatorClientes(user);
  const meta = clientesResponse?.meta || {
    page,
    pageSize: PAGE_SIZE,
    totalCount: 0,
    totalPages: 1,
    hasNextPage: false,
    maxPageSize: PAGE_SIZE,
    correlationId: "",
  };

  const handleSave = async (data: ClienteFormData) => {
    if (!canManageClientes) {
      toast.error("Seu acesso nesta area e somente leitura.");
      return;
    }

    const confirmTitle = editingCliente ? "Salvar alterações deste embarcador?" : "Cadastrar este novo embarcador?";
    if (!confirmAction(confirmTitle)) {
      return;
    }

    const payload = mapClienteFormToPayload(data);

    if (editingCliente) {
      try {
        const response = await updateOperatorCliente(editingCliente.id, payload);

        response.warnings?.forEach((warning) => {
          toast.warning(warning);
        });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Erro ao atualizar embarcador");
        return;
      }
      toast.success("Embarcador atualizado!");
    } else {
      try {
        const response = await createOperatorCliente(payload);

        response.warnings?.forEach((warning) => {
          toast.warning(warning);
        });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Erro ao cadastrar embarcador");
        return;
      }
      toast.success("Embarcador cadastrado!");
    }

    setModalOpen(false);
    setEditingCliente(null);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: CLIENTES_QUERY_KEY }),
      queryClient.invalidateQueries({ queryKey: ["admin", "cargas-read-model"] }),
      queryClient.invalidateQueries({ queryKey: ["operator", "dashboard-read-model"] }),
      queryClient.invalidateQueries({ queryKey: ["driver", "loads-read-model"] }),
    ]);
  };

  const handleDelete = async (id: string) => {
    if (!canManageClientes) {
      toast.error("Seu acesso nesta area e somente leitura.");
      return;
    }

    if (!confirmAction("Excluir este embarcador?", "Esta ação é permanente e não pode ser desfeita.")) {
      return;
    }

    try {
      await deleteOperatorCliente(id);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Erro ao excluir embarcador");
      return;
    }

    toast.success("Embarcador excluido!");
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: CLIENTES_QUERY_KEY }),
      queryClient.invalidateQueries({ queryKey: ["admin", "cargas-read-model"] }),
      queryClient.invalidateQueries({ queryKey: ["operator", "dashboard-read-model"] }),
      queryClient.invalidateQueries({ queryKey: ["driver", "loads-read-model"] }),
    ]);
  };

  return (
    <div>
      <DashboardHeader title="Embarcadores" />

      <main className="space-y-5 p-6 lg:p-8">
        <section className="admin-panel overflow-hidden p-5 lg:p-6">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.28em] text-primary/60">Base comercial</p>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <h2 className="text-2xl font-semibold tracking-tight text-foreground">
                  {meta.totalCount} embarcador{meta.totalCount === 1 ? "" : "es"} encontrado
                  {meta.totalCount === 1 ? "" : "s"}
                </h2>
                {isFetching && !isLoading ? (
                  <span className="inline-flex items-center gap-2 rounded-full border border-primary/12 bg-primary/8 px-3 py-1 text-xs font-semibold text-primary">
                    <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                    Atualizando
                  </span>
                ) : null}
              </div>
              <p className="mt-3 max-w-2xl text-sm text-muted-foreground">
                Cadastro rapido com foco em descricao, pagamento, exigencias, reputacao e observacoes internas que pesam na decisao do motorista.
              </p>
            </div>

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <div className="relative min-w-[280px] flex-1">
                <Search className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  type="text"
                  placeholder="Pesquisar empresa ou pagamento..."
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  className="w-full rounded-2xl border border-border/80 bg-white/92 py-3 pl-11 pr-4 text-sm text-foreground outline-none transition-all duration-200 placeholder:text-muted-foreground focus:border-primary/30 focus:ring-4 focus:ring-primary/10"
                />
              </div>

              {canManageClientes ? (
                <button
                  onClick={() => {
                    setEditingCliente(null);
                    setModalOpen(true);
                  }}
                  className="admin-primary-button inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-2xl px-5 py-3 text-sm font-semibold text-white cursor-pointer"
                >
                  <Plus className="h-4 w-4" />
                  Novo embarcador
                </button>
              ) : (
                <div className="inline-flex items-center justify-center rounded-2xl border border-border/80 bg-white/92 px-4 py-3 text-sm font-semibold text-muted-foreground">
                  {getOperatorAccessLevelLabel(operatorAccessLevel)}: somente leitura
                </div>
              )}
            </div>
          </div>
        </section>

        {!canManageClientes ? (
          <section className="rounded-2xl border border-amber-300/45 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-400/30 dark:bg-amber-500/10 dark:text-amber-200">
            Seu perfil pode visualizar todos os embarcadores, mas apenas operadores com acesso avancado podem criar, editar ou excluir nessa area.
          </section>
        ) : null}

        <section className="space-y-4">
          {isLoading ? (
            Array.from({ length: LOADING_CARD_COUNT }, (_, index) => (
              <div key={`cliente-loading-${index}`} className="admin-soft-panel animate-pulse p-5 sm:p-6">
                <div className="flex items-start gap-4">
                  <div className="h-12 w-12 rounded-2xl bg-primary/10" />
                  <div className="grid flex-1 gap-3">
                    <div className="h-5 w-40 rounded-full bg-muted/70" />
                    <div className="h-4 w-60 rounded-full bg-muted/45" />
                  </div>
                </div>

                <div className="mt-5 grid gap-4 lg:grid-cols-2">
                  <div className="h-28 rounded-[24px] bg-muted/50" />
                  <div className="h-28 rounded-[24px] bg-muted/50" />
                </div>

                <div className="mt-4 h-20 rounded-[24px] bg-muted/45" />
              </div>
            ))
          ) : clientes.length === 0 ? (
            <div className="admin-panel px-6 py-14 text-center">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-3xl bg-primary/10 text-primary">
                <Building2 className="h-6 w-6" />
              </div>
              <h3 className="mt-4 text-xl font-semibold text-foreground">Nenhum embarcador encontrado</h3>
              <p className="mt-2 text-sm text-muted-foreground">
                Cadastre um cliente com pagamento e exigencias claras para agilizar a operacao.
              </p>
            </div>
          ) : (
            <div className="grid gap-4 xl:grid-cols-2">
              {clientes.map((cliente) => (
                <article
                  key={cliente.id}
                  className="admin-soft-panel flex h-full flex-col gap-5 p-5 transition-transform duration-200 hover:-translate-y-0.5 sm:p-6"
                >
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start gap-4">
                        <ClientLogo
                          name={cliente.nome}
                          logoUrl={cliente.logo_url}
                          className="h-[72px] w-[72px] shrink-0 rounded-[24px] border-primary/10"
                          imageClassName="p-1.5"
                          fallbackClassName="rounded-[24px]"
                        />

                        <div className="min-w-0">
                          <h3 className="truncate text-xl font-semibold tracking-tight text-foreground">{cliente.nome}</h3>
                          <p className="mt-1 text-xs font-medium text-muted-foreground">
                            {cliente.logo_url ? "Logo configurada" : "Sem logo cadastrada"}
                          </p>
                        </div>
                      </div>
                    </div>

                    {canManageClientes ? (
                      <div className="flex items-center gap-2 self-start">
                        <button
                          type="button"
                          aria-label={`Editar ${cliente.nome}`}
                          onClick={() => {
                            setEditingCliente(cliente);
                            setModalOpen(true);
                          }}
                          className="flex h-10 w-10 items-center justify-center rounded-xl border border-primary/10 bg-primary/5 text-primary transition-colors duration-200 cursor-pointer hover:bg-primary/10"
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          aria-label={`Excluir ${cliente.nome}`}
                          onClick={() => handleDelete(cliente.id)}
                          className="flex h-10 w-10 items-center justify-center rounded-xl border border-destructive/15 bg-destructive/5 text-destructive transition-colors duration-200 cursor-pointer hover:bg-destructive/10"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    ) : (
                      <span className="admin-chip-inactive inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold">
                        Somente leitura
                      </span>
                    )}
                  </div>

                  <div className="admin-card-surface rounded-[24px] border p-4">
                    <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                      <CreditCard className="h-4 w-4 text-primary" />
                      Padrao de pagamento
                    </div>
                    <p className="mt-3 text-sm leading-6 text-foreground">
                      {cliente.forma_pagamento || "Forma de pagamento não informada"}
                    </p>
                    <div className="mt-3 inline-flex items-center gap-2 rounded-full bg-primary/[0.06] px-3 py-1.5 text-xs font-semibold text-primary">
                      <Clock3 className="h-3.5 w-3.5" />
                      {cliente.prazo_pagamento || "Prazo não informado"}
                    </div>
                  </div>

                  <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                    <div className="admin-card-surface rounded-[24px] border p-4">
                      <p className="text-sm font-semibold text-foreground">Exigencias padrao</p>
                      <div className="mt-3 grid grid-cols-2 gap-2">
                        {requirementOptions.map((option) => {
                          const Icon = option.icon;
                          const active = cliente[option.key];

                          return (
                            <div
                              key={option.key}
                              className={cn(
                                "flex items-center gap-2 rounded-2xl border px-3 py-2.5 text-xs font-semibold transition-colors duration-200",
                                active
                                  ? "border-[hsl(224_94%_37%)] bg-[linear-gradient(135deg,#022483,#0b4de8)] text-white shadow-[0_16px_24px_-18px_rgba(2,36,131,0.8)]"
                                  : "admin-chip-inactive",
                              )}
                            >
                              <Icon className="h-4 w-4 shrink-0" />
                              <span className="truncate">{option.label}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    <div className="admin-card-surface rounded-[24px] border p-4">
                      <p className="text-sm font-semibold text-foreground">Cards de reputacao</p>
                      <div className="mt-3 grid grid-cols-2 gap-2">
                        {reputationOptions.map((option) => {
                          const Icon = option.icon;
                          const active = cliente[option.key];

                          return (
                            <div
                              key={option.key}
                              className={cn(
                                "flex items-center gap-2 rounded-2xl border px-3 py-2.5 text-xs font-semibold transition-colors duration-200",
                                active
                                  ? "border-[hsl(224_94%_37%)] bg-[linear-gradient(135deg,#022483,#0b4de8)] text-white shadow-[0_16px_24px_-18px_rgba(2,36,131,0.8)]"
                                  : "admin-chip-inactive",
                              )}
                            >
                              <Icon className="h-4 w-4 shrink-0" />
                              <span className="truncate">{option.label}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>

                  <div className="admin-card-surface rounded-[24px] border p-4">
                    <p className="text-sm font-semibold text-foreground">Observacoes</p>
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">
                      {cliente.observacoes || "Nenhuma observacao cadastrada."}
                    </p>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>

        <AdminPagination
          page={meta.page}
          totalPages={meta.totalPages}
          totalCount={meta.totalCount}
          pageSize={meta.pageSize}
          itemLabel={`embarcador${meta.totalCount === 1 ? "" : "es"}`}
          isFetching={isFetching}
          onPrevious={() => setPage((currentPage) => Math.max(currentPage - 1, 1))}
          onNext={() => setPage((currentPage) => Math.min(currentPage + 1, meta.totalPages))}
        />
      </main>

      {canManageClientes ? (
        <ClienteModal
          open={modalOpen}
          onClose={() => {
            setModalOpen(false);
            setEditingCliente(null);
          }}
          onSave={handleSave}
          initialData={editingCliente}
        />
      ) : null}
    </div>
  );
};

export default ManageClientes;
