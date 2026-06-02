import { useDeferredValue, useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  BadgeCheck,
  BellRing,
  CalendarClock,
  Check,
  CheckCircle2,
  ClipboardList,
  FileBadge2,
  Pencil,
  Phone,
  RefreshCw,
  Route,
  Search,
  ShieldCheck,
  ShieldX,
  Trash2,
  Truck,
  UserPlus,
  UserRound,
  UsersRound,
  X,
  XCircle,
} from "lucide-react";

import AdminPagination from "@/components/AdminPagination";
import { useOperatorPermissions } from "@/hooks/useOperatorPermissions";
import { AspxSyncCard } from "@/components/AspxSyncCard";
import DashboardHeader from "@/components/DashboardHeader";
import DriverDetailModal, { type DriverDetailModalData } from "@/components/DriverDetailModal";
import ApproveCadastroModal, { type ApproveJob } from "@/components/operator/ApproveCadastroModal";
import DispatchProgressModal from "@/components/operator/DispatchProgressModal";
import ExternalRegistrationPanel from "@/components/operator/ExternalRegistrationPanel";
import {
  StandaloneCadastroDialog,
  type StandaloneCadastroProceedArgs,
} from "@/components/driver/StandaloneCadastroDialog";
import { DriverRegistrationWizard } from "@/components/driver/cadastro-v2/DriverRegistrationWizard";
import { precheckAngellira, precheckSpx, patchCadastroDados, deleteCadastro } from "@/services/readModels";

/**
 * Pré-fetch dos prechecks Angellira+SPX em background.
 * Aproveita o cache server-side de 60s — quando o modal abre depois, vem
 * do cache (response instantânea).
 *
 * Dispara no HOVER (mouseenter) e no CLIQUE da linha. O hover normalmente
 * acontece 1-3s antes do clique → quando o operador clica "Aprovar", as
 * queries externas (~6s) já terminaram e o modal abre com cache hit.
 *
 * Dedup por cadastroId (Set module-level) evita disparos repetidos enquanto
 * o cache de 60s está quente.
 */
const _prefetchedIds = new Set<string>();
function prefetchPrechecks(cadastroId: string) {
  if (!cadastroId || _prefetchedIds.has(cadastroId)) return;
  _prefetchedIds.add(cadastroId);
  // Expira o dedup junto com o cache server-side (60s) pra permitir refresh.
  setTimeout(() => _prefetchedIds.delete(cadastroId), 55_000);
  // Fire-and-forget. Erros são silenciados — o modal vai tentar de novo.
  precheckAngellira(cadastroId).catch(() => { _prefetchedIds.delete(cadastroId); });
  precheckSpx(cadastroId).catch(() => {});
}
import { Input } from "@/components/ui/input";
import { buildDisplayDateTime, formatShortDateTime, parseDateStringAsLocal } from "@/lib/dateDisplay";
import { cn } from "@/lib/utils";
import { getOperatorAccessToken } from "@/services/apiClient";
import {
  aprovarCadastro,
  fetchCadastrosPendentes,
  fetchOperatorDrivers,
  rejeitarCadastro,
  type OperatorDriverApplicationItem,
  type OperatorDriverListItem,
  type PendingDriverRegistrationItem,
} from "@/services/readModels";
import { toast } from "sonner";

const MOTORISTAS_QUERY_KEY = ["operator", "motoristas-read-model"] as const;
const PAGE_SIZE = 8;
const LOADING_CARD_COUNT = 4;

const queryOptions = {
  staleTime: 30_000,
  gcTime: 10 * 60_000,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
  placeholderData: keepPreviousData,
} as const;

function formatApplicationStatus(application: OperatorDriverApplicationItem) {
  if (application.source === "PUBLIC_LEAD") {
    if (application.status === "QUEUED") {
      return "Na fila pública";
    }

    if (application.status === "APPROVED") {
      return "Reservado pelo operador";
    }
  }

  if (application.status === "WAITLISTED") {
    return "Na fila";
  }

  if (application.status === "WON_RESERVATION" || application.status === "PROMOTED") {
    return "Reserva em andamento";
  }

  if (application.status === "CONFIRMED") {
    return "Confirmado";
  }

  return application.status;
}

function getApplicationTone(application: OperatorDriverApplicationItem) {
  if (application.status === "CONFIRMED") {
    return "admin-tint-success";
  }

  if (application.status === "APPROVED" || application.status === "WON_RESERVATION" || application.status === "PROMOTED") {
    return "border-primary/20 bg-primary/10 text-primary";
  }

  return "admin-tint-warning";
}

function getDriverBadgeLabel(driver: OperatorDriverListItem) {
  if (driver.registrationStatus === "REGISTERED") return "Conta cadastrada";
  if (driver.sourceType === "HISTORICO") return "Histórico Angellira";
  return "Pré-cadastro público";
}

function getDriverBadgeTone(driver: OperatorDriverListItem) {
  if (driver.registrationStatus === "REGISTERED") return "border-primary/15 bg-primary/8 text-primary";
  if (driver.sourceType === "HISTORICO") return "admin-tint-violet";
  return "admin-tint-warning";
}

function getDriverHeadline(driver: OperatorDriverListItem) {
  return driver.displayName || "Motorista sem nome cadastrado";
}

function renderProfileSignal(label: string, active: boolean | null, positiveLabel = "Ok", negativeLabel = "Pendente") {
  if (active === null) {
    return null;
  }

  return (
    <div
      className={cn(
        "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold",
        active ? "admin-tint-success" : "admin-tint-danger",
      )}
    >
      {active ? <ShieldCheck className="h-3.5 w-3.5" /> : <ShieldX className="h-3.5 w-3.5" />}
      {label}: {active ? positiveLabel : negativeLabel}
    </div>
  );
}

function renderAngelliraVigencyBadge(driver: OperatorDriverListItem) {
  const vigency = driver.angelliraVigency;

  if (!vigency) {
    return null;
  }

  const { alertLevel, daysUntilExpiry, validUntil, statusText } = vigency;

  if (alertLevel === "EXPIRED") {
    return (
      <div className="admin-tint-danger inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold">
        <XCircle className="h-3.5 w-3.5" />
        Angellira: Vigência vencida{validUntil ? ` (${parseDateStringAsLocal(validUntil)?.toLocaleDateString("pt-BR") ?? ""})` : ""}
      </div>
    );
  }

  if (alertLevel === "EXPIRING_SOON") {
    return (
      <div className="admin-tint-warning inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold animate-pulse">
        <AlertTriangle className="h-3.5 w-3.5" />
        Angellira: Vence em {daysUntilExpiry} dia{daysUntilExpiry !== 1 ? "s" : ""}
        {validUntil ? ` (${parseDateStringAsLocal(validUntil)?.toLocaleDateString("pt-BR") ?? ""})` : ""}
      </div>
    );
  }

  if (alertLevel === "OK" && validUntil) {
    return (
      <div className="admin-tint-success inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold">
        <CheckCircle2 className="h-3.5 w-3.5" />
        Angellira: {statusText || "Vigente"} ate {parseDateStringAsLocal(validUntil)?.toLocaleDateString("pt-BR") ?? ""}
      </div>
    );
  }

  if (vigency.status === "FOUND") {
    return (
      <div className="admin-tint-success inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold">
        <BadgeCheck className="h-3.5 w-3.5" />
        Angellira: {statusText || "Encontrado"}
      </div>
    );
  }

  if (vigency.status === "NOT_FOUND") {
    return (
      <div className="admin-tint-neutral inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold">
        <CalendarClock className="h-3.5 w-3.5" />
        Angellira: Não encontrado
      </div>
    );
  }

  return null;
}

async function updateDriverProfile(driverId: string, payload: Record<string, unknown>) {
  const accessToken = await getOperatorAccessToken();
  const response = await fetch(`/api/operator/motoristas/${driverId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.message || "Erro ao atualizar perfil do motorista.");
  }
  return response.json();
}

// 2026-05-27 — Render recursivo da ficha do cadastro (painel do operador).
// O render anterior pulava arrays (carretas, carreta_owners), filtrava objetos
// aninhados (antt_titular, endereco, cnh, dados_bancarios) e cortava em 10
// campos — então o operador não via o proprietário ANTT (cavalo/carreta), as
// carretas, o banco nem os endereços. FichaNode percorre tudo recursivamente.
const CADASTRO_DADOS_LABELS: Record<string, string> = {
  motorista: "Motorista",
  cavalo: "Cavalo",
  cavalo_owner: "Dono do cavalo",
  carretas: "Carretas",
  carreta_owners: "Donos das carretas",
  antt_titular: "Titular ANTT (RNTRC)",
  endereco: "Endereço",
  dados_bancarios: "Dados bancários",
  banco: "Banco",
  cnh: "CNH",
  owner_reuse: "Reuso de proprietário",
  telefones: "Telefones",
  nome: "Nome",
  doc: "CPF/CNPJ",
  cpf: "CPF",
  tipo: "Tipo",
  placa: "Placa",
  renavam: "RENAVAM",
  chassi: "Chassi",
  marca: "Marca / Modelo",
  modelo: "Modelo",
  ano: "Ano",
  cor: "Cor",
  eixos: "Eixos",
  carroceria: "Carroceria",
  owner_doc: "CPF/CNPJ proprietário",
  owner_doc_type: "Tipo do doc",
  owner_resolution: "Resolução",
  rntrc: "RNTRC",
  telefone: "Telefone",
  telefone_primario: "Telefone",
  cep: "CEP",
  numero: "Número",
  logradouro: "Logradouro",
  bairro: "Bairro",
  cidade: "Cidade",
  uf: "UF",
  banco_nome: "Banco",
  banco_compe: "Cód. banco",
  agencia: "Agência",
  conta: "Conta",
  isento_ie: "Isento de IE",
  inscricao_estadual: "Inscrição estadual",
  validade: "Validade",
  categoria: "Categoria",
  protocolo: "Protocolo",
  pis: "PIS / PASEP",
  estado_civil: "Estado civil",
  cor_raca: "Cor / raça",
  rg: "RG",
  rg_orgao: "Órgão emissor",
  rg_uf: "UF do RG",
  nome_mae: "Nome da mãe",
  nome_pai: "Nome do pai",
  naturalidade: "Naturalidade",
  data_nascimento: "Nascimento",
  tag_pedagio: "Tag de pedágio",
  pancary_autodeclaration: "Pancary",
  uf_emplacamento: "UF emplacamento",
  cidade_emplacamento: "Cidade emplacamento",
  ano_fabricacao: "Ano de fabricação",
  ultimo_licenciamento: "Últ. licenciamento",
  cavalo_owner_is_driver: "Dono = motorista",
  carreta_owners_reused: "Reuso por carreta",
  // Arquivos (storage paths / urls) — exibidos como "arquivo enviado".
  owner_doc_url: "Documento (arquivo)",
  crlv_url: "CRLV (arquivo)",
  selfie_cnh_url: "Selfie com CNH (arquivo)",
  comprovante_url: "Comprovante (arquivo)",
  comprovanteUrl: "Comprovante (arquivo)",
  comprovante_storage_path: "Comprovante (arquivo)",
  documento_storage_path: "Documento (arquivo)",
  anttOwnerDocStoragePath: "Documento do titular (arquivo)",
  anttOwnerComprovanteStoragePath: "Comprovante do titular (arquivo)",
  rntrc_via: "Origem do RNTRC",
  cpf_owner_manual: "Doc. preenchido manual",
  ocr_fallback_manual: "OCR manual",
  ocr_comprovante_fallback_manual: "Comprovante manual",
};

// Rótulo no singular para itens de array (ex.: "Dono da carreta 1").
const CADASTRO_ITEM_LABELS: Record<string, string> = {
  carretas: "Carreta",
  carreta_owners: "Dono da carreta",
  carreta_owners_reused: "Carreta",
  telefones: "Telefone",
};

function humanizeFichaKey(key: string): string {
  return (
    CADASTRO_DADOS_LABELS[key] ??
    key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

function isFichaEmpty(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
  );
}

function formatFichaScalar(key: string, value: unknown): string {
  if (typeof value === "boolean") return value ? "Sim" : "Não";
  const s = String(value);
  if (/_url$|storage_path$|storagePath$/i.test(key) && s.length > 0) {
    return "✓ arquivo enviado";
  }
  return s;
}

/** Render recursivo de qualquer nó do JSONB `dados` (escalar, objeto ou array). */
function FichaNode({
  nodeKey,
  value,
  depth,
  bare = false,
}: {
  nodeKey: string;
  value: unknown;
  depth: number;
  bare?: boolean;
}) {
  if (isFichaEmpty(value)) return null;

  // Escalar → linha rótulo/valor.
  if (typeof value !== "object" || value === null) {
    const field = (
      <>
        <dt className="text-muted-foreground truncate">{humanizeFichaKey(nodeKey)}</dt>
        <dd className="font-medium text-foreground break-words">
          {formatFichaScalar(nodeKey, value)}
        </dd>
      </>
    );
    if (depth === 0) {
      return (
        <div className="rounded-xl border border-border/60 p-3">
          <dl className="text-xs">{field}</dl>
        </div>
      );
    }
    return <div>{field}</div>;
  }

  const cardCls =
    depth === 0
      ? "rounded-xl border border-border/60 p-3"
      : "rounded-lg border border-border/40 bg-muted/20 p-2.5 mt-2";
  const titleCls = "text-xs font-semibold uppercase tracking-wide text-primary/60 mb-2";

  // Array → card com cada item ("Singular N").
  if (Array.isArray(value)) {
    const items = value.filter((v) => !isFichaEmpty(v));
    if (!items.length) return null;
    const singular = CADASTRO_ITEM_LABELS[nodeKey] ?? humanizeFichaKey(nodeKey).replace(/s$/i, "");
    return (
      <div className={cardCls}>
        <p className={titleCls}>{humanizeFichaKey(nodeKey)}</p>
        <div className="space-y-2">
          {items.map((item, i) => (
            <div key={i} className="rounded-lg border border-border/40 bg-background/60 p-2">
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {singular} {i + 1}
              </p>
              <FichaNode nodeKey={nodeKey} value={item} depth={depth + 1} bare />
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Objeto → grid de escalares + nós aninhados.
  const entries = Object.entries(value as Record<string, unknown>).filter(
    ([, v]) => !isFichaEmpty(v),
  );
  const scalars = entries.filter(([, v]) => typeof v !== "object" || v === null);
  const nested = entries.filter(([, v]) => typeof v === "object" && v !== null);
  const body = (
    <>
      {scalars.length > 0 ? (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
          {scalars.map(([k, v]) => (
            <FichaNode key={k} nodeKey={k} value={v} depth={depth + 1} />
          ))}
        </dl>
      ) : null}
      {nested.map(([k, v]) => (
        <FichaNode key={k} nodeKey={k} value={v} depth={depth + 1} />
      ))}
    </>
  );
  // bare = item de array (já tem cabeçalho "Singular N") → sem card/título extra.
  if (bare) return body;
  return (
    <div className={cardCls}>
      <p className={titleCls}>{humanizeFichaKey(nodeKey)}</p>
      {body}
    </div>
  );
}


const PENDENTES_QUERY_KEY = ["operator", "cadastros-pendentes"] as const;

const Motoristas = () => {
  const queryClient = useQueryClient();
  const permissions = useOperatorPermissions();
  const [mainTab, setMainTab] = useState<"motoristas" | "pendentes">("motoristas");
  const [search, setSearch] = useState("");
  const [sourceFilter, setSourceFilter] = useState("todos");
  const [applicationStatusFilter, setApplicationStatusFilter] = useState("todos");
  const [page, setPage] = useState(1);
  const deferredSearch = useDeferredValue(search.trim());
  const [detailDriver, setDetailDriver] = useState<DriverDetailModalData | null>(null);
  const [editingDriver, setEditingDriver] = useState<OperatorDriverListItem | null>(null);
  const [editForm, setEditForm] = useState<{
    full_name: string;
    vehicle_profile: string;
    documents_valid: boolean;
    antt_valid: boolean;
    tracking_enabled: boolean;
    insurance_valid: boolean;
    monitoring_capable: boolean;
    operational_blocked: boolean;
  }>({
    full_name: "",
    vehicle_profile: "",
    documents_valid: false,
    antt_valid: false,
    tracking_enabled: false,
    insurance_valid: false,
    monitoring_capable: false,
    operational_blocked: false,
  });

  const [candidaturasDriver, setCandidaturasDriver] = useState<OperatorDriverListItem | null>(null);

  const updateMutation = useMutation({
    mutationFn: (args: { driverId: string; payload: Record<string, unknown> }) =>
      updateDriverProfile(args.driverId, args.payload),
    onSuccess: () => {
      toast.success("Perfil do motorista atualizado com sucesso.");
      setEditingDriver(null);
      queryClient.invalidateQueries({ queryKey: MOTORISTAS_QUERY_KEY });
    },
    onError: (error: Error) => {
      toast.error(error.message || "Erro ao atualizar motorista.");
    },
  });

  const handleOpenDetail = (driver: OperatorDriverListItem) => {
    const latestValidation = driver.applications.find((a) => a.validation)?.validation || null;
    const latestPlates = driver.applications.find((a) => a.plates)?.plates || null;
    setDetailDriver({
      name: driver.displayName || null,
      cpf: driver.contact.document || null,
      phone: driver.contact.phone || null,
      vehicleType: driver.profile.vehicleProfile || null,
      plates: latestPlates,
      validation: latestValidation,
      angelliraDetails: driver.angelliraDetails || null,
    });
  };

  const handleEditDriver = (driver: OperatorDriverListItem) => {
    setEditingDriver(driver);
    setEditForm({
      full_name: driver.displayName || "",
      vehicle_profile: driver.profile.vehicleProfile || "",
      documents_valid: driver.profile.documentsValid ?? false,
      antt_valid: driver.profile.anttValid ?? false,
      tracking_enabled: driver.profile.trackingEnabled ?? false,
      insurance_valid: driver.profile.insuranceValid ?? false,
      monitoring_capable: driver.profile.monitoringCapable ?? false,
      operational_blocked: driver.profile.operationalBlocked ?? false,
    });
  };

  const handleSaveDriver = () => {
    if (!editingDriver) return;
    updateMutation.mutate({
      driverId: editingDriver.id.replace("driver:", ""),
      payload: editForm,
    });
  };

  const { data, error, isLoading, isFetching } = useQuery({
    queryKey: [...MOTORISTAS_QUERY_KEY, deferredSearch, sourceFilter, applicationStatusFilter, page],
    queryFn: () =>
      fetchOperatorDrivers({
        page: String(page),
        pageSize: String(PAGE_SIZE),
        search: deferredSearch,
        source: sourceFilter,
        applicationStatus: applicationStatusFilter,
      }),
    ...queryOptions,
  });

  const items = data?.items ?? [];
  const meta = data?.meta ?? {
    page,
    pageSize: PAGE_SIZE,
    totalCount: 0,
    totalPages: 1,
    hasNextPage: false,
    maxPageSize: PAGE_SIZE,
    correlationId: "",
  };
  const summary = data?.summary ?? {
    totalDrivers: 0,
    registeredCount: 0,
    publicOnlyCount: 0,
    totalApplications: 0,
  };

  const currentPageApplicationCount = items.reduce((total, driver) => total + driver.stats.totalApplications, 0);

  useEffect(() => {
    setPage(1);
  }, [deferredSearch, sourceFilter, applicationStatusFilter]);


  const hasActiveFilters = deferredSearch.length > 0 || sourceFilter !== "todos" || applicationStatusFilter !== "todos";

  // ─── Pendentes ───────────────────────────────────────────────────────────────
  const [pendentesStatusFilter, setPendentesStatusFilter] = useState("pendente");
  const [pendentesPage, setPendentesPage] = useState(1);
  const [selectedPendente, setSelectedPendente] = useState<PendingDriverRegistrationItem | null>(null);
  const [rejectObs, setRejectObs] = useState("");
  // Cadastro de motorista pelo operador — mesmo fluxo do DriverPortal
  const [showCadastroRapido, setShowCadastroRapido] = useState(false);
  const [registrationWizardOpen, setRegistrationWizardOpen] = useState(false);
  const [registrationContext, setRegistrationContext] = useState<{
    cpf?: string;
    horsePlate?: string;
    trailerPlates?: string[];
    preCheckResponse?: StandaloneCadastroProceedArgs["preCheckResponse"];
  } | null>(null);

  const handleCadastroRapidoProceed = ({ cpf, horsePlate, trailerPlates, preCheckResponse }: StandaloneCadastroProceedArgs) => {
    setRegistrationContext({ cpf, horsePlate, trailerPlates, preCheckResponse });
    setShowCadastroRapido(false);
    setRegistrationWizardOpen(true);
  };

  const [showRejectModal, setShowRejectModal] = useState(false);
  const [rejectTarget, setRejectTarget] = useState<string | null>(null);
  // Modal de aprovação com checkboxes (Angellira opt-in) — DC-111 / Sprint 1
  const [showApproveModal, setShowApproveModal] = useState(false);
  // Modal de edição de dados do cadastro
  const [showEditModal, setShowEditModal] = useState(false);
  const [editDadosJson, setEditDadosJson] = useState("");
  const [editJsonError, setEditJsonError] = useState<string | null>(null);
  // Confirmação de exclusão
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  // Modal de PROGRESSO ao vivo do disparo externo (Angellira + SPX) — DC-111 / DC-118.
  // Snapshot dos dados no momento do disparo (selectedPendente pode mudar/limpar).
  const [dispatchProgress, setDispatchProgress] = useState<{
    cadastroId: string;
    nome?: string;
    jobs: ApproveJob[];
    hasCavalo: boolean;
    hasCarreta: boolean;
  } | null>(null);

  const { data: pendentesData, isLoading: pendentesLoading, isFetching: pendentesFetching, error: pendentesError } = useQuery({
    queryKey: [...PENDENTES_QUERY_KEY, pendentesStatusFilter, pendentesPage],
    queryFn: () =>
      fetchCadastrosPendentes({
        status: pendentesStatusFilter || undefined,
        page: pendentesPage,
        pageSize: 20,
      }),
    enabled: mainTab === "pendentes",
    ...queryOptions,
  });

  const aprovarMutation = useMutation({
    mutationFn: ({ id, jobs }: { id: string; jobs: ApproveJob[] }) => aprovarCadastro(id, { jobs }),
    // Abre o modal de PROGRESSO ANTES da request voltar, para que o polling de
    // GET /external-jobs comece já no início do disparo síncrono do backend.
    // (O backend roda o pipeline dentro do POST /aprovar mas faz commit imediato
    // por etapa — autocommit — então a UI vê o avanço ao vivo.)
    onMutate: ({ jobs }) => {
      const dispatchesExternal = jobs.includes("angellira") || jobs.includes("spx");
      if (dispatchesExternal && selectedPendente) {
        const dados = selectedPendente.dados as Record<string, unknown> | undefined;
        setShowApproveModal(false);
        setDispatchProgress({
          cadastroId: selectedPendente.id,
          nome: selectedPendente.nome_motorista || undefined,
          jobs,
          hasCavalo: Boolean(dados?.cavalo),
          hasCarreta: Boolean(
            dados?.carreta || Array.isArray((dados as { carretas?: unknown[] } | undefined)?.carretas),
          ),
        });
      }
    },
    onSuccess: (data, { id, jobs }) => {
      const dispatchesExternal = jobs.includes("angellira") || jobs.includes("spx");
      if (!dispatchesExternal) {
        // Sem disparo externo: só criação de conta — toast simples.
        toast.success("Motorista aprovado. Conta criada com sucesso.");
        setShowApproveModal(false);
      } else {
        // Com disparo: o resumo aparece no DispatchProgressModal; toast neutro.
        toast.success("Motorista aprovado. Veja o progresso do cadastro externo.");
      }
      queryClient.invalidateQueries({ queryKey: PENDENTES_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: MOTORISTAS_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: ["external-jobs", id] });
    },
    onError: (error: Error) => {
      toast.error(error.message || "Erro ao aprovar cadastro.");
      // Falha na criação de conta/disparo → fecha o modal de progresso (nada a mostrar).
      setDispatchProgress(null);
    },
  });

  const rejeitarMutation = useMutation({
    mutationFn: ({ id, obs }: { id: string; obs: string }) => rejeitarCadastro(id, obs),
    onSuccess: (_data, { id }) => {
      toast.success("Cadastro rejeitado.");
      if (selectedPendente?.id === id) setSelectedPendente(null);
      setShowRejectModal(false);
      setRejectObs("");
      setRejectTarget(null);
      queryClient.invalidateQueries({ queryKey: PENDENTES_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: MOTORISTAS_QUERY_KEY });
    },
    onError: (error: Error) => {
      toast.error(error.message || "Erro ao rejeitar cadastro.");
    },
  });

  const editarDadosMutation = useMutation({
    mutationFn: ({ id, dados }: { id: string; dados: Record<string, unknown> }) =>
      patchCadastroDados(id, dados),
    onSuccess: (_data, { id }) => {
      toast.success("Dados do cadastro atualizados.");
      setShowEditModal(false);
      queryClient.invalidateQueries({ queryKey: PENDENTES_QUERY_KEY });
      // Atualiza dados locais do selectedPendente para refletir a edição imediatamente
      if (selectedPendente?.id === id) {
        try {
          const novosDados = JSON.parse(editDadosJson) as Record<string, unknown>;
          setSelectedPendente({ ...selectedPendente, dados: novosDados });
        } catch { /* ignorar */ }
      }
    },
    onError: (error: Error) => {
      toast.error(error.message || "Erro ao salvar alterações.");
    },
  });

  const excluirCadastroMutation = useMutation({
    mutationFn: (id: string) => deleteCadastro(id),
    onSuccess: (_data, id) => {
      toast.success("Cadastro excluído.");
      if (selectedPendente?.id === id) setSelectedPendente(null);
      setShowDeleteConfirm(false);
      queryClient.invalidateQueries({ queryKey: PENDENTES_QUERY_KEY });
    },
    onError: (error: Error) => {
      toast.error(error.message || "Erro ao excluir cadastro.");
      setShowDeleteConfirm(false);
    },
  });

  const pendentesItems = pendentesData?.items ?? [];
  const pendentesMeta = pendentesData?.meta;

  return (
    <div className="min-w-0">
      <DashboardHeader
        title="Motoristas"
        actions={
          <button
            type="button"
            onClick={() => setShowCadastroRapido(true)}
            className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-sm hover:bg-primary/90 transition-colors"
          >
            <UserPlus className="h-4 w-4" />
            Cadastrar motorista
          </button>
        }
      />

      {/* Tab switcher — segmented control arredondado */}
      <div className="px-6 pt-3 pb-1 lg:px-8">
        <div className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/50 p-1">
          <button
            type="button"
            onClick={() => setMainTab("motoristas")}
            className={cn(
              "inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold transition-colors",
              mainTab === "motoristas"
                ? "bg-background text-primary shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <UsersRound className="h-4 w-4" />
            Motoristas
          </button>
          <button
            type="button"
            onClick={() => setMainTab("pendentes")}
            className={cn(
              "inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold transition-colors",
              mainTab === "pendentes"
                ? "bg-background text-primary shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <ClipboardList className="h-4 w-4" />
            Pendentes
          </button>
        </div>
      </div>

      <main className="min-w-0 space-y-5 p-6 lg:p-8">
        {mainTab === "pendentes" ? (
          <>
            {/* Pendentes section */}
            <section className="admin-panel overflow-hidden p-5 lg:p-6">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.28em] text-primary/60">Cadastros automáticos</p>
                  <h2 className="mt-1 text-2xl font-semibold tracking-tight text-foreground">Revisão de candidatos</h2>
                  <p className="mt-1 text-sm text-muted-foreground">Cadastros enviados pelo formulário público /cadastro aguardando revisão.</p>
                </div>
                <select
                  value={pendentesStatusFilter}
                  onChange={(e) => { setPendentesStatusFilter(e.target.value); setPendentesPage(1); }}
                  className="h-10 rounded-xl border border-border/80 bg-white/92 px-3 text-sm text-foreground outline-none"
                >
                  <option value="">Todos</option>
                  <option value="pendente">Pendentes</option>
                  <option value="em_revisao">Em revisão</option>
                  <option value="aprovado">Aprovados</option>
                  <option value="rejeitado">Rejeitados</option>
                </select>
              </div>
            </section>

            {pendentesLoading ? (
              <section className="admin-panel flex min-h-[160px] items-center justify-center p-8">
                <RefreshCw className="h-6 w-6 animate-spin text-primary/60" />
              </section>
            ) : pendentesError ? (
              <section className="admin-panel flex min-h-[160px] flex-col items-center justify-center gap-3 p-8 text-center">
                <ShieldX className="h-10 w-10 text-rose-500/70" />
                <p className="text-sm text-muted-foreground">Erro ao carregar cadastros.</p>
              </section>
            ) : pendentesItems.length === 0 ? (
              <section className="admin-panel flex min-h-[160px] flex-col items-center justify-center gap-3 p-8 text-center">
                <ClipboardList className="h-10 w-10 text-muted-foreground/40" />
                <p className="text-sm text-muted-foreground">Nenhum cadastro encontrado.</p>
              </section>
            ) : (
              <div className="grid gap-4 xl:grid-cols-[1fr_420px]">
                {/* Lista */}
                <section className="admin-panel overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        <th className="px-5 py-3">Motorista</th>
                        <th className="px-5 py-3">Placa cavalo</th>
                        <th className="px-5 py-3">Enviado em</th>
                        <th className="px-5 py-3">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pendentesItems.map((item) => (
                        <tr
                          key={item.id}
                          // Pré-fetch no HOVER: aquece o cache server-side 1-3s
                          // antes do clique. Dedup interno evita repetição.
                          onMouseEnter={() => prefetchPrechecks(item.id)}
                          onClick={() => {
                            setSelectedPendente(item);
                            // Garante o pré-fetch também no clique (caso o
                            // hover não tenha disparado — ex: navegação por teclado).
                            prefetchPrechecks(item.id);
                          }}
                          className={cn(
                            "cursor-pointer border-b border-border/50 transition-colors hover:bg-muted/40",
                            selectedPendente?.id === item.id && "bg-primary/5",
                          )}
                        >
                          <td className="px-5 py-3">
                            <p className="font-semibold text-foreground">{item.nome_motorista || "—"}</p>
                            <p className="text-xs text-muted-foreground">{item.cpf_motorista || ""}</p>
                          </td>
                          <td className="px-5 py-3 text-foreground">{item.placa_cavalo || "—"}</td>
                          <td className="px-5 py-3 text-muted-foreground">
                            {new Date(item.created_at).toLocaleDateString("pt-BR")}
                          </td>
                          <td className="px-5 py-3">
                            <span className={cn(
                              "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold",
                              item.status === "pendente" && "admin-tint-warning",
                              item.status === "em_revisao" && "admin-tint-neutral border-blue-200 bg-blue-50 text-blue-700",
                              item.status === "aprovado" && "admin-tint-success",
                              item.status === "rejeitado" && "admin-tint-danger",
                            )}>
                              {item.status}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {pendentesMeta && pendentesMeta.totalPages > 1 && (
                    <div className="flex items-center justify-between border-t border-border px-5 py-3">
                      <p className="text-xs text-muted-foreground">
                        {pendentesMeta.totalCount} registro{pendentesMeta.totalCount !== 1 ? "s" : ""}
                      </p>
                      <AdminPagination
                        page={pendentesPage}
                        totalPages={pendentesMeta.totalPages}
                        totalCount={pendentesMeta.totalCount}
                        pageSize={20}
                        itemLabel="cadastro(s)"
                        isFetching={pendentesFetching}
                        onPrevious={() => setPendentesPage((p) => Math.max(1, p - 1))}
                        onNext={() => setPendentesPage((p) => Math.min(pendentesMeta.totalPages, p + 1))}
                      />
                    </div>
                  )}
                </section>

                {/* Painel de revisao */}
                {selectedPendente ? (
                  <section className="admin-panel overflow-hidden p-5">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Candidato</p>
                        <h3 className="mt-1 text-lg font-bold text-foreground">{selectedPendente.nome_motorista || "—"}</h3>
                        <p className="text-sm text-muted-foreground">{selectedPendente.cpf_motorista || ""}</p>
                      </div>
                      <button type="button" onClick={() => setSelectedPendente(null)} className="rounded-full p-1.5 hover:bg-muted">
                        <X className="h-4 w-4 text-muted-foreground" />
                      </button>
                    </div>

                    {selectedPendente.dados && (
                      <div className="mt-4 space-y-3 max-h-[420px] overflow-y-auto pr-1">
                        {Object.entries(selectedPendente.dados as Record<string, unknown>)
                          .filter(([, v]) => !isFichaEmpty(v))
                          .map(([section, value]) => (
                            <FichaNode key={section} nodeKey={section} value={value} depth={0} />
                          ))}
                      </div>
                    )}

                    {(selectedPendente.status === "pendente" || selectedPendente.status === "em_revisao") && (
                      <div className="mt-5 flex gap-3">
                        {permissions.canApproveMotoristas ? (
                          <button
                            type="button"
                            disabled={aprovarMutation.isPending}
                            onClick={() => setShowApproveModal(true)}
                            className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:opacity-60 transition-colors"
                          >
                            {aprovarMutation.isPending ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                            Aprovar
                          </button>
                        ) : null}
                        {permissions.canRejectMotoristas ? (
                          <button
                            type="button"
                            disabled={rejeitarMutation.isPending}
                            onClick={() => { setRejectTarget(selectedPendente.id); setRejectObs(""); setShowRejectModal(true); }}
                            className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl border border-rose-300 bg-rose-50 px-4 py-2.5 text-sm font-semibold text-rose-700 hover:bg-rose-100 disabled:opacity-60 transition-colors"
                          >
                            <X className="h-4 w-4" />
                            Rejeitar
                          </button>
                        ) : null}
                        {!permissions.canApproveMotoristas && !permissions.canRejectMotoristas ? (
                          <p className="flex-1 rounded-xl border border-dashed border-border bg-muted/40 px-4 py-2.5 text-center text-xs text-muted-foreground">
                            Você não tem permissão para aprovar ou rejeitar cadastros.
                          </p>
                        ) : null}
                      </div>
                    )}

                    {/* Painel granular de cadastro externo (Angellira) — DC-111 / Sprint 1.
                        Aparece quando cadastro já foi aprovado (driver_profile criado). */}
                    {selectedPendente.status === "aprovado" ? (
                      <>
                        <ExternalRegistrationPanel cadastroId={selectedPendente.id} />
                        {/* Ações de gerenciamento para cadastros aprovados */}
                        {permissions.canApproveMotoristas ? (
                          <div className="mt-4 flex gap-2 border-t border-border pt-4">
                            <button
                              type="button"
                              onClick={() => {
                                setEditDadosJson(JSON.stringify(selectedPendente.dados ?? {}, null, 2));
                                setEditJsonError(null);
                                setShowEditModal(true);
                              }}
                              className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-sm font-medium text-foreground hover:bg-muted transition-colors"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                              Editar dados
                            </button>
                            {permissions.canRejectMotoristas ? (
                              <button
                                type="button"
                                onClick={() => setShowDeleteConfirm(true)}
                                className="flex items-center justify-center gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-medium text-rose-700 hover:bg-rose-100 transition-colors"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                                Excluir
                              </button>
                            ) : null}
                          </div>
                        ) : null}
                      </>
                    ) : null}
                  </section>
                ) : (
                  <section className="admin-panel flex min-h-[200px] flex-col items-center justify-center gap-3 p-8 text-center">
                    <UserRound className="h-8 w-8 text-muted-foreground/40" />
                    <p className="text-sm text-muted-foreground">Selecione um cadastro para revisar</p>
                  </section>
                )}
              </div>
            )}

            {/* Modal de aprovacao com checkboxes (Angellira opt-in) — DC-111 / Sprint 1 */}
            {selectedPendente ? (
              <ApproveCadastroModal
                cadastroId={selectedPendente.id}
                open={showApproveModal}
                onOpenChange={setShowApproveModal}
                motoristaNome={selectedPendente.nome_motorista || undefined}
                motoristaCpf={selectedPendente.cpf_motorista || undefined}
                hasCavalo={Boolean((selectedPendente.dados as Record<string, unknown>)?.cavalo)}
                hasCarreta={Boolean(
                  (selectedPendente.dados as Record<string, unknown>)?.carreta ||
                  Array.isArray((selectedPendente.dados as { carretas?: unknown[] })?.carretas),
                )}
                isSubmitting={aprovarMutation.isPending}
                onConfirm={(jobs) => aprovarMutation.mutate({ id: selectedPendente.id, jobs })}
              />
            ) : null}

            {/* Modal de PROGRESSO ao vivo do disparo externo (Angellira + SPX) — DC-111 / DC-118.
                Abre ao confirmar "Aprovar e cadastrar"; pollia GET /external-jobs até terminal. */}
            {dispatchProgress ? (
              <DispatchProgressModal
                cadastroId={dispatchProgress.cadastroId}
                open={Boolean(dispatchProgress)}
                onOpenChange={(open) => { if (!open) setDispatchProgress(null); }}
                motoristaNome={dispatchProgress.nome}
                dispatchedJobs={dispatchProgress.jobs}
                hasCavalo={dispatchProgress.hasCavalo}
                hasCarreta={dispatchProgress.hasCarreta}
                dispatchPending={aprovarMutation.isPending}
              />
            ) : null}

            {/* Modal de rejeicao */}
            {showRejectModal && (
              <Dialog open={showRejectModal} onOpenChange={(open) => { if (!open) { setShowRejectModal(false); setRejectTarget(null); setRejectObs(""); } }}>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Rejeitar cadastro</DialogTitle>
                  </DialogHeader>
                  <div className="space-y-3">
                    <p className="text-sm text-muted-foreground">Informe o motivo da rejeicao (opcional).</p>
                    <textarea
                      value={rejectObs}
                      onChange={(e) => setRejectObs(e.target.value)}
                      placeholder="Motivo da rejeicao..."
                      rows={4}
                      className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-primary/20 resize-none"
                    />
                  </div>
                  <DialogFooter>
                    <button
                      type="button"
                      onClick={() => { setShowRejectModal(false); setRejectTarget(null); setRejectObs(""); }}
                      className="rounded-xl border border-border px-4 py-2 text-sm font-semibold"
                    >
                      Cancelar
                    </button>
                    <button
                      type="button"
                      disabled={rejeitarMutation.isPending}
                      onClick={() => rejectTarget && rejeitarMutation.mutate({ id: rejectTarget, obs: rejectObs })}
                      className="rounded-xl bg-rose-600 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-700 disabled:opacity-60"
                    >
                      Confirmar rejeicao
                    </button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            )}

            {/* Modal de edição de dados do cadastro aprovado */}
            <Dialog open={showEditModal} onOpenChange={(open) => { if (!open) { setShowEditModal(false); setEditJsonError(null); } }}>
              <DialogContent className="max-w-2xl">
                <DialogHeader>
                  <DialogTitle>Editar dados do cadastro</DialogTitle>
                </DialogHeader>
                <div className="mt-2 space-y-2">
                  <p className="text-sm text-muted-foreground">
                    Edite os dados do cadastro em formato JSON. As alterações serão salvas e refletidas no próximo cadastro externo.
                  </p>
                  <textarea
                    className="w-full rounded-lg border border-border bg-muted/30 p-3 font-mono text-xs leading-relaxed focus:outline-none focus:ring-2 focus:ring-primary/30"
                    rows={18}
                    value={editDadosJson}
                    onChange={(e) => {
                      setEditDadosJson(e.target.value);
                      setEditJsonError(null);
                    }}
                  />
                  {editJsonError ? (
                    <p className="text-xs text-rose-600">{editJsonError}</p>
                  ) : null}
                </div>
                <DialogFooter>
                  <button
                    type="button"
                    onClick={() => { setShowEditModal(false); setEditJsonError(null); }}
                    className="rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-muted"
                  >
                    Cancelar
                  </button>
                  <button
                    type="button"
                    disabled={editarDadosMutation.isPending}
                    onClick={() => {
                      if (!selectedPendente) return;
                      let parsed: Record<string, unknown>;
                      try {
                        parsed = JSON.parse(editDadosJson) as Record<string, unknown>;
                      } catch {
                        setEditJsonError("JSON inválido. Corrija a sintaxe antes de salvar.");
                        return;
                      }
                      editarDadosMutation.mutate({ id: selectedPendente.id, dados: parsed });
                    }}
                    className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
                  >
                    {editarDadosMutation.isPending ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                    Salvar alterações
                  </button>
                </DialogFooter>
              </DialogContent>
            </Dialog>

            {/* Modal de confirmação de exclusão */}
            <Dialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
              <DialogContent className="max-w-sm">
                <DialogHeader>
                  <DialogTitle>Excluir cadastro</DialogTitle>
                </DialogHeader>
                <p className="text-sm text-muted-foreground">
                  Tem certeza que deseja excluir o cadastro de{" "}
                  <strong>{selectedPendente?.nome_motorista || "—"}</strong>? Esta ação não pode ser desfeita.
                </p>
                <p className="mt-1 text-xs text-amber-700">
                  Se o motorista já foi cadastrado em Angellira ou SPX, os dados <strong>permanecem nesses sistemas</strong> — remova manualmente se necessário.
                </p>
                <DialogFooter>
                  <button
                    type="button"
                    onClick={() => setShowDeleteConfirm(false)}
                    className="rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-muted"
                  >
                    Cancelar
                  </button>
                  <button
                    type="button"
                    disabled={excluirCadastroMutation.isPending}
                    onClick={() => selectedPendente && excluirCadastroMutation.mutate(selectedPendente.id)}
                    className="flex items-center gap-2 rounded-lg bg-rose-600 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-700 disabled:opacity-60"
                  >
                    {excluirCadastroMutation.isPending ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                    Confirmar exclusão
                  </button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </>
        ) : (
          <>
        <AspxSyncCard />

        <section className="admin-panel overflow-hidden p-5 lg:p-6">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.28em] text-primary/60">Visao operacional</p>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <h2 className="text-2xl font-semibold tracking-tight text-foreground">
                  {summary.totalDrivers} motorista{summary.totalDrivers === 1 ? "" : "s"} com candidatura{summary.totalApplications === 1 ? "" : "s"}
                </h2>
                {isFetching && !isLoading ? (
                  <span className="inline-flex items-center gap-2 rounded-full border border-primary/12 bg-primary/8 px-3 py-1 text-xs font-semibold text-primary">
                    <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                    Atualizando
                  </span>
                ) : null}
              </div>
              <p className="mt-3 max-w-3xl text-sm text-muted-foreground">
                A tela consolida contas de motorista cadastradas e pre-cadastros publicos, agrupando as candidaturas mais recentes.
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <div className="admin-soft-panel flex items-center gap-3 px-4 py-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                  <UsersRound className="h-4 w-4" />
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.24em] text-muted-foreground">Cadastrados</p>
                  <p className="text-sm font-semibold text-foreground">{summary.registeredCount}</p>
                </div>
              </div>

              <div className="admin-soft-panel flex items-center gap-3 px-4 py-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-amber-500/12 text-amber-700">
                  <BellRing className="h-4 w-4" />
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.24em] text-muted-foreground">Pre-cadastros</p>
                  <p className="text-sm font-semibold text-foreground">{summary.publicOnlyCount}</p>
                </div>
              </div>

              <div className="admin-soft-panel flex items-center gap-3 px-4 py-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-emerald-500/12 text-emerald-700">
                  <Route className="h-4 w-4" />
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.24em] text-muted-foreground">Candidaturas</p>
                  <p className="text-sm font-semibold text-foreground">{summary.totalApplications}</p>
                </div>
              </div>
            </div>
          </div>

          <div className="mt-5 grid gap-3 lg:grid-cols-[minmax(0,1.4fr)_220px_220px_auto]">
            <div className="relative">
              <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Pesquisar por nome, telefone, documento, rota ou placa..."
                className="h-12 rounded-2xl border-border/80 bg-white/92 pl-11 pr-4"
              />
            </div>

            <select
              value={sourceFilter}
              onChange={(event) => setSourceFilter(event.target.value)}
              className="h-12 rounded-2xl border border-border/80 bg-white/92 px-4 text-sm text-foreground outline-none transition-all duration-200 focus:border-primary/30 focus:ring-4 focus:ring-primary/10"
            >
              <option value="todos">Todas as origens</option>
              <option value="cadastrados">Apenas cadastrados</option>
              <option value="publicos">Apenas pré-cadastros</option>
              <option value="historico">Histórico Angellira</option>
            </select>

            <select
              value={applicationStatusFilter}
              onChange={(event) => setApplicationStatusFilter(event.target.value)}
              className="h-12 rounded-2xl border border-border/80 bg-white/92 px-4 text-sm text-foreground outline-none transition-all duration-200 focus:border-primary/30 focus:ring-4 focus:ring-primary/10"
            >
              <option value="todos">Todos os status</option>
              <option value="fila">Na fila</option>
              <option value="reservado">Reservado</option>
              <option value="confirmado">Confirmado</option>
            </select>

            <button
              type="button"
              onClick={() => {
                setSearch("");
                setSourceFilter("todos");
                setApplicationStatusFilter("todos");
              }}
              disabled={!hasActiveFilters}
              className="inline-flex items-center justify-center rounded-2xl border border-border/80 bg-white/92 px-4 text-sm font-semibold text-foreground transition-colors duration-200 hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
            >
              Limpar filtros
            </button>
          </div>
        </section>

        {isLoading ? (
          <section className="grid gap-4 xl:grid-cols-2">
            {Array.from({ length: LOADING_CARD_COUNT }, (_, index) => (
              <div key={`motorista-loading-${index}`} className="admin-soft-panel animate-pulse p-5 sm:p-6">
                <div className="flex items-start gap-4">
                  <div className="h-14 w-14 rounded-3xl bg-primary/10" />
                  <div className="grid flex-1 gap-3">
                    <div className="h-5 w-44 rounded-full bg-muted/70" />
                    <div className="h-4 w-64 rounded-full bg-muted/45" />
                  </div>
                </div>
                <div className="mt-5 h-24 rounded-[24px] bg-muted/45" />
                <div className="mt-4 grid gap-3">
                  <div className="h-24 rounded-[24px] bg-muted/45" />
                  <div className="h-24 rounded-[24px] bg-muted/45" />
                </div>
              </div>
            ))}
          </section>
        ) : error ? (
          <section className="admin-panel flex min-h-[260px] flex-col items-center justify-center gap-4 p-10 text-center">
            <ShieldX className="h-14 w-14 text-rose-500/70" />
            <div className="space-y-1">
              <p className="text-lg font-bold text-foreground">Não foi possível carregar os motoristas</p>
              <p className="text-sm text-muted-foreground">
                {error instanceof Error ? error.message : "Verifique a sessao do operador e tente novamente."}
              </p>
            </div>
          </section>
        ) : items.length === 0 ? (
          <section className="admin-panel flex min-h-[260px] flex-col items-center justify-center gap-4 p-10 text-center">
            <UsersRound className="h-14 w-14 text-muted-foreground/35" />
            <div className="space-y-1">
              <p className="text-lg font-bold text-foreground">Nenhum motorista encontrado</p>
              <p className="text-sm text-muted-foreground">
                Ajuste os filtros ou aguarde novas candidaturas entrarem no sistema.
              </p>
            </div>
          </section>
        ) : (
          <section className="space-y-4">
            <div className="text-sm text-muted-foreground">
              Exibindo {items.length} motorista{items.length === 1 ? "" : "s"} nesta página, com {currentPageApplicationCount} candidatura{currentPageApplicationCount === 1 ? "" : "s"} visíveis.
            </div>

            <div className="grid gap-4 xl:grid-cols-2">
              {items.map((driver) => (
                <article
                  key={driver.id}
                  className="admin-soft-panel flex h-full flex-col gap-4 p-5 transition-transform duration-200 hover:-translate-y-0.5 sm:p-6"
                >
                  {/* ── ALWAYS VISIBLE: Header ── */}
                  <div className="flex items-start gap-4">
                    <button
                      type="button"
                      onClick={() => handleOpenDetail(driver)}
                      className="flex h-14 w-14 shrink-0 items-center justify-center rounded-[20px] border border-primary/10 bg-[linear-gradient(135deg,#022483,#0b4de8)] text-sm font-bold text-white shadow-[0_14px_28px_-16px_rgba(2,36,131,0.7)] transition-transform hover:scale-105 hover:shadow-[0_18px_32px_-16px_rgba(2,36,131,0.85)]"
                      title="Ver detalhes do motorista"
                    >
                      <UserRound className="h-6 w-6" />
                    </button>

                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          className="text-left hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                          onClick={() => handleOpenDetail(driver)}
                        >
                          <h3 className="truncate text-lg font-semibold tracking-tight text-foreground hover:text-primary transition-colors">
                            {getDriverHeadline(driver)}
                          </h3>
                        </button>
                        <span className={cn("inline-flex rounded-full border px-2.5 py-0.5 text-[0.68rem] font-semibold", getDriverBadgeTone(driver))}>
                          {getDriverBadgeLabel(driver)}
                        </span>
                        {driver.registrationStatus === "REGISTERED" && permissions.canEditMotoristas ? (
                          <button
                            type="button"
                            onClick={() => handleEditDriver(driver)}
                            className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-primary/15 bg-primary/8 text-primary transition-all hover:bg-primary/15 hover:scale-105"
                            title="Editar perfil do motorista"
                          >
                            <Pencil className="h-3 w-3" />
                          </button>
                        ) : null}
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        Ultima candidatura:{" "}
                        {driver.stats.latestApplicationAt
                          ? formatShortDateTime(driver.stats.latestApplicationAt)
                          : "sem data"}
                      </p>
                    </div>
                  </div>

                  {/* ── ALWAYS VISIBLE: Contact row ── */}
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm text-foreground">
                    <span className="inline-flex items-center gap-1.5">
                      <Phone className="h-3.5 w-3.5 text-primary" />
                      {driver.contact.phone || "Telefone indisponível"}
                    </span>
                    <span className="hidden text-border sm:inline">|</span>
                    <span className="inline-flex items-center gap-1.5">
                      <FileBadge2 className="h-3.5 w-3.5 text-primary" />
                      {driver.contact.document || "Documento indisponível"}
                    </span>
                    <span className="hidden text-border sm:inline">|</span>
                    <span className="inline-flex items-center gap-1.5">
                      <Truck className="h-3.5 w-3.5 text-primary" />
                      {driver.profile.vehicleProfile || "Tipo não informado"}
                    </span>
                  </div>

                  {/* ── ALWAYS VISIBLE: Application counters (inline badges) ── */}
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/6 px-2.5 py-1 text-xs font-semibold text-foreground">
                      Total: {driver.stats.totalApplications}
                    </span>
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/8 px-2.5 py-1 text-xs font-semibold text-amber-700">
                      Fila: {driver.stats.queuedApplications}
                    </span>
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/8 px-2.5 py-1 text-xs font-semibold text-primary">
                      Reserva: {driver.stats.reservedApplications}
                    </span>
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-semibold text-emerald-700">
                      Confirmado: {driver.stats.confirmedApplications}
                    </span>
                  </div>

                  {/* ── ALWAYS VISIBLE: Angellira vigency badge ── */}
                  {renderAngelliraVigencyBadge(driver)}

                  {/* ── Sinais do perfil (sempre visíveis) ── */}
                  {(driver.registrationStatus === "REGISTERED" || driver.externalValidation) ? (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {driver.registrationStatus === "REGISTERED" ? (
                        <>
                          {renderProfileSignal("Cadastro", driver.profile.active, "Ativo", "Inativo")}
                          {renderProfileSignal("Documentos", driver.profile.documentsValid)}
                          {renderProfileSignal("ANTT", driver.profile.anttValid)}
                          {renderProfileSignal("Rastreamento", driver.profile.trackingEnabled, "Ativo", "Desligado")}
                          {renderProfileSignal("Seguro", driver.profile.insuranceValid, "Ok", "Não informado")}
                          {renderProfileSignal("Monitoramento", driver.profile.monitoringCapable, "Ok", "Não")}
                          {renderProfileSignal("Operação", driver.profile.operationalBlocked === null ? null : !driver.profile.operationalBlocked, "Liberado", "Bloqueado")}
                        </>
                      ) : driver.externalValidation ? (
                        <>
                          <span className="inline-flex items-center gap-2 rounded-full border border-primary/15 bg-primary/8 px-3 py-1.5 text-xs font-semibold text-primary">
                            <BadgeCheck className="h-3.5 w-3.5" />
                            Angellira: {driver.externalValidation.hasAngelira ? "✓ Verificado" : "Não encontrado"}
                          </span>
                          <span className="inline-flex items-center gap-2 rounded-full border border-primary/15 bg-primary/8 px-3 py-1.5 text-xs font-semibold text-primary">
                            <BadgeCheck className="h-3.5 w-3.5" />
                            ASPX: {driver.externalValidation.hasAspx ? "✓ Cadastrado" : "Não cadastrado"}
                          </span>
                        </>
                      ) : null}
                    </div>
                  ) : null}

                  {/* Dados Angellira agora s\u00f3 via DriverDetailModal (clique no avatar/nome). */}

                  {/* ── CHIP: Candidaturas → abre modal ── */}
                  <button
                    type="button"
                    onClick={() => setCandidaturasDriver(driver)}
                    className="inline-flex items-center rounded-full border border-border/80 bg-white px-3 py-1 text-xs font-semibold uppercase tracking-widest text-muted-foreground transition-colors hover:bg-muted/40 dark:bg-muted/40"
                  >
                    Candidaturas ({driver.applications.length})
                  </button>
                </article>
              ))}
            </div>
          </section>
        )}

        <AdminPagination
          page={meta.page}
          totalPages={meta.totalPages}
          totalCount={meta.totalCount}
          pageSize={meta.pageSize}
          itemLabel={`motorista${meta.totalCount === 1 ? "" : "s"}`}
          isFetching={isFetching}
          onPrevious={() => setPage((currentPage) => Math.max(currentPage - 1, 1))}
          onNext={() => setPage((currentPage) => Math.min(currentPage + 1, meta.totalPages))}
        />

      <Dialog open={editingDriver !== null} onOpenChange={(open) => { if (!open) setEditingDriver(null); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Editar motorista</DialogTitle>
            {editingDriver ? (
              <p className="mt-1 text-sm text-muted-foreground">Altere os dados do perfil de {editingDriver.displayName || "motorista"}.</p>
            ) : null}
          </DialogHeader>

          <div className="grid gap-3">
            <div>
              <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Nome completo</label>
              <Input
                type="text"
                value={editForm.full_name}
                onChange={(e) => setEditForm((f) => ({ ...f, full_name: e.target.value }))}
                className="mt-1.5"
              />
            </div>
            <div>
              <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Perfil do veículo</label>
              <Input
                type="text"
                value={editForm.vehicle_profile}
                onChange={(e) => setEditForm((f) => ({ ...f, vehicle_profile: e.target.value }))}
                className="mt-1.5"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Telefone e documento são gerenciados pelo próprio motorista e não podem ser alterados pelo operador.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            {[
              { key: "documents_valid" as const, label: "Documentos válidos" },
              { key: "antt_valid" as const, label: "ANTT valida" },
              { key: "tracking_enabled" as const, label: "Rastreamento" },
              { key: "insurance_valid" as const, label: "Seguro" },
              { key: "monitoring_capable" as const, label: "Monitoramento" },
              { key: "operational_blocked" as const, label: "Operação bloqueada" },
            ].map(({ key, label }) => (
              <label key={key} className="flex items-center gap-2.5 rounded-2xl border border-border/60 bg-white/80 px-3.5 py-3 text-sm cursor-pointer hover:bg-muted/30 transition-colors">
                <input
                  type="checkbox"
                  checked={editForm[key]}
                  onChange={(e) => setEditForm((f) => ({ ...f, [key]: e.target.checked }))}
                  className="h-4 w-4 rounded border-primary/30 text-primary accent-primary"
                />
                <span className="font-medium text-foreground">{label}</span>
              </label>
            ))}
          </div>

          <DialogFooter>
            <button
              type="button"
              onClick={() => setEditingDriver(null)}
              className="rounded-2xl border border-border/80 bg-white px-5 py-2.5 text-sm font-semibold text-foreground transition-colors hover:bg-muted"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={handleSaveDriver}
              disabled={updateMutation.isPending}
              className="rounded-2xl bg-primary px-5 py-2.5 text-sm font-semibold text-white transition-opacity disabled:opacity-60 hover:bg-primary/90"
            >
              {updateMutation.isPending ? "Salvando..." : "Salvar alteracoes"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Modal de Candidaturas ── */}
      <Dialog open={candidaturasDriver !== null} onOpenChange={(open) => { if (!open) setCandidaturasDriver(null); }}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              Candidaturas — {candidaturasDriver?.displayName || "Motorista"}
            </DialogTitle>
            {candidaturasDriver ? (
              <p className="mt-1 text-sm text-muted-foreground">
                {candidaturasDriver.applications.length} candidatura{candidaturasDriver.applications.length !== 1 ? "s" : ""} mais recentes nesta página de resultados.
              </p>
            ) : null}
          </DialogHeader>

          <div className="mt-2 space-y-3">
            {candidaturasDriver?.applications.length === 0 ? (
              <div className="admin-card-surface rounded-[24px] border border-dashed px-4 py-5 text-sm text-muted-foreground">
                Nenhuma candidatura disponível para este motorista no filtro atual.
              </div>
            ) : (
              <div className="grid gap-3">
                {candidaturasDriver?.applications.map((application) => (
                  <div
                    key={application.id}
                    className="admin-card-surface rounded-[24px] border p-4"
                  >
                    <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-semibold text-foreground">
                            {application.load.origem} {"->"} {application.load.destino}
                          </span>
                          <span
                            className={cn(
                              "inline-flex rounded-full border px-3 py-1 text-xs font-semibold",
                              getApplicationTone(application),
                            )}
                          >
                            {formatApplicationStatus(application)}
                          </span>
                          <span className="inline-flex rounded-full border border-border/80 bg-white px-3 py-1 text-xs font-semibold text-muted-foreground dark:bg-muted/40">
                            {application.source === "CLAIM" ? "Conta no app" : "Pré-cadastro"}
                          </span>
                        </div>

                        <div className="mt-3 flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
                          <span>
                            Carga {application.load.id} • {application.load.perfil}
                          </span>
                          <span>
                            {formatShortDateTime(buildDisplayDateTime(application.load.data, application.load.horario), "A confirmar")}
                          </span>
                          <span>{application.load.status}</span>
                        </div>
                      </div>

                      <div className="text-sm text-muted-foreground">
                        {formatShortDateTime(application.submittedAt)}
                      </div>
                    </div>

                    {application.plates ? (
                      <div className="mt-4 flex flex-wrap gap-2">
                        <span className="inline-flex rounded-full border border-border/80 bg-white px-3 py-1 text-xs font-semibold text-foreground dark:bg-muted/40">
                          Cavalo: {application.plates.horsePlate || "indisponível"}
                        </span>
                        <span className="inline-flex rounded-full border border-border/80 bg-white px-3 py-1 text-xs font-semibold text-foreground dark:bg-muted/40">
                          Carreta 1: {application.plates.trailerPlate || "indisponível"}
                        </span>
                        {application.plates.trailerPlate2 ? (
                          <span className="inline-flex rounded-full border border-border/80 bg-white px-3 py-1 text-xs font-semibold text-foreground dark:bg-muted/40">
                            Carreta 2: {application.plates.trailerPlate2}
                          </span>
                        ) : null}
                      </div>
                    ) : null}

                    {application.validation ? (
                      <div className="mt-4 flex flex-wrap gap-1.5">
                        <span className={`inline-flex rounded-full border px-2.5 py-1 text-[11px] font-semibold ${
                          application.validation.driver.angelira.status === "FOUND"
                            ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-400/40 dark:bg-emerald-500/15 dark:text-emerald-200"
                            : application.validation.driver.angelira.status === "UNAVAILABLE"
                              ? "border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-500/40 dark:bg-slate-500/15 dark:text-slate-200"
                              : "border-red-200 bg-red-50 text-red-700 dark:border-red-400/40 dark:bg-red-500/15 dark:text-red-200"
                        }`}>
                          {application.validation.driver.angelira.status === "FOUND" ? "Angellira" : application.validation.driver.angelira.status === "UNAVAILABLE" ? "Angellira indisponível" : "Fora do Angellira"}
                        </span>
                        <span className={`inline-flex rounded-full border px-2.5 py-1 text-[11px] font-semibold ${
                          application.validation.driver.aspx.status === "FOUND"
                            ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-400/40 dark:bg-emerald-500/15 dark:text-emerald-200"
                            : application.validation.driver.aspx.status === "UNAVAILABLE"
                              ? "border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-500/40 dark:bg-slate-500/15 dark:text-slate-200"
                              : "border-red-200 bg-red-50 text-red-700 dark:border-red-400/40 dark:bg-red-500/15 dark:text-red-200"
                        }`}>
                          {application.validation.driver.aspx.status === "FOUND" ? "ASPX" : application.validation.driver.aspx.status === "UNAVAILABLE" ? "ASPX indisponível" : "Fora do ASPX"}
                        </span>
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <DriverDetailModal
        open={detailDriver !== null}
        onOpenChange={(open) => { if (!open) setDetailDriver(null); }}
        data={detailDriver}
        hideValidation
      />
          </>
        )}
      </main>

      {/* Cadastro de motorista pelo operador — mesmo modal do DriverPortal */}
      <StandaloneCadastroDialog
        open={showCadastroRapido}
        onOpenChange={setShowCadastroRapido}
        onProceed={handleCadastroRapidoProceed}
      />
      <DriverRegistrationWizard
        open={registrationWizardOpen}
        onOpenChange={setRegistrationWizardOpen}
        cpf={registrationContext?.cpf}
        horsePlate={registrationContext?.horsePlate}
        trailerPlates={registrationContext?.trailerPlates}
        initialPreCheckResponse={registrationContext?.preCheckResponse}
        onPreCheckPassed={() => {
          // No contexto do operador, apenas fecha o wizard após registro
          setRegistrationWizardOpen(false);
          setRegistrationContext(null);
        }}
      />
    </div>
  );
};

export default Motoristas;
