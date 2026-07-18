import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, ArrowDown, ArrowUp, CheckCircle2, Loader2, PackagePlus, RefreshCw, Search, Upload, X, Zap } from "lucide-react";

import DashboardHeader from "@/components/DashboardHeader";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import MultiSelectFilter, { type MultiSelectOption } from "@/components/operator/MultiSelectFilter";
import RouteModal, { type RouteFormData } from "@/components/RouteModal";
import ImportProgramacaoModal from "@/components/ImportProgramacaoModal";
import { cn } from "@/lib/utils";
import { confirmAction } from "@/lib/confirm";
import {
  acceptSpxTrips,
  fetchOperatorClientes,
  fetchProgramacao,
  getProgramacaoSettings,
  launchCargoFromTrip,
  runAutoLaunchSpots,
  setSpotAutolaunchEnabled,
  type ProgramacaoOverview,
  type ProgramacaoRow,
  type ProgramacaoTab,
} from "@/services/readModels";
import { fetchAssignableRoutes, findAssignableRouteByLocations } from "@/lib/assignableRoutes";
import { attachClienteRota, createOperatorRoute, type ImportCargasResponse } from "@/services/operatorAdmin";
import { parseMoneyInput, parseOptionalNumber, trimTextOrNull } from "@/lib/routeCatalog";

const PROGRAMACAO_MAIN_KEY = ["operator", "programacao", "main"] as const; // Planejado + Aceito (rápido)
const PROGRAMACAO_CONCLUIDO_KEY = ["operator", "programacao", "concluido"] as const; // lazy
const ROUTES_KEY = ["operator", "programacao", "routes"] as const;
const CLIENTES_KEY = ["operator", "programacao", "clientes"] as const;
const AUTOLAUNCH_KEY = ["operator", "programacao", "autolaunch-settings"] as const;

const TABS: { key: ProgramacaoTab; label: string }[] = [
  { key: "planejado", label: "Planejado" },
  { key: "aceito", label: "Aceito" },
  { key: "concluido", label: "Concluído" },
];

const TAB_TINT: Record<ProgramacaoTab, string> = {
  planejado: "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-200",
  aceito: "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/15 dark:text-emerald-200",
  concluido: "border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-500/30 dark:bg-slate-500/15 dark:text-slate-300",
};

// Opções fixas dos filtros binários (multiselect, padrão Status/Rota).
const LANCADO_OPTS: MultiSelectOption[] = [
  { value: "sim", label: "Lançado" },
  { value: "nao", label: "Não lançado" },
];
const ACEITO_OPTS: MultiSelectOption[] = [
  { value: "sim", label: "Aceito" },
  { value: "nao", label: "Não aceito" },
];

const WARNING_LABEL: Record<string, string> = {
  tab_planejado_unavailable: "A aba Planejado não pôde ser carregada agora.",
  tab_aceito_unavailable: "A aba Aceito não pôde ser carregada agora.",
  tab_concluido_unavailable: "A aba Concluído não pôde ser carregada agora.",
  tab_planejado_truncated: "A lista de Planejado foi truncada (muitas viagens).",
  tab_aceito_truncated: "A lista de Aceito foi truncada (muitas viagens).",
  tab_concluido_truncated: "A lista de Concluído foi truncada — mostrando as mais recentes.",
  launched_lookup_failed: "Não foi possível verificar quais viagens já viraram carga.",
};

// Prefill do modal de rota (padrão prod = multi-tarifa: 1 linha de tarifa por
// veículo). Vem preenchido com a rota da viagem; o operador define valor/bônus.
function makeRoutePrefill(origem: string, destino: string, clienteId: string | null): RouteFormData {
  return {
    origem,
    destino,
    distancia_km: "",
    tempo_estimado_horas: "",
    ativa: true,
    cliente_id: clienteId,
    tarifas: [{ key: crypto.randomUUID(), perfil: "CARRETA", eixos: 0, valor: "", bonus: "", bonus_exigencias: "" }],
  };
}

const fmtDate = (d: string | null) => (d ? d.split("-").reverse().join("/") : "—");
const routeLabel = (r: ProgramacaoRow) => `${r.origem || "—"} → ${r.destino || "—"}`;
const rowStatus = (r: ProgramacaoRow) => r.statusOperacional || r.statusRaw || "";
// Chave comparável 'YYYY-MM-DDTHH:MM' p/ o filtro datetime-local (data+hora). Hora
// ausente = 00:00. Mesma largura/ordem lexicográfica dos valores do <input>.
const dtKey = (d: string | null, h: string | null) => (d ? `${d}T${(h ?? "00:00").slice(0, 5)}` : null);

/* ─────────────────────────── Sub-componentes ─────────────────────────── */

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <DashboardHeader title="Programação" subtitle="Viagens disponíveis por cliente — visualizar, aceitar e lançar" />
      <main className="min-w-0 space-y-5 p-6 lg:p-8">{children}</main>
    </div>
  );
}

function StatCard({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div className="rounded-2xl border border-border/70 bg-card px-4 py-3">
      <p className="text-[0.62rem] font-bold uppercase tracking-[0.18em] text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-foreground">{value}</p>
      {hint ? <p className="mt-0.5 text-[0.68rem] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function DateRangeFilter({
  label,
  from,
  to,
  onFrom,
  onTo,
}: {
  label: string;
  from: string;
  to: string;
  onFrom: (v: string) => void;
  onTo: (v: string) => void;
}) {
  const active = Boolean(from || to);
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-2xl border bg-card px-3 py-2 text-sm transition-colors",
        active ? "border-primary/40" : "border-border/80",
      )}
    >
      <span className="text-xs font-semibold text-muted-foreground">{label}</span>
      <input
        type="datetime-local"
        aria-label={`${label} de`}
        value={from}
        onChange={(e) => onFrom(e.target.value)}
        className="bg-transparent text-xs text-foreground outline-none [color-scheme:light] dark:[color-scheme:dark]"
      />
      <span className="text-muted-foreground">–</span>
      <input
        type="datetime-local"
        aria-label={`${label} até`}
        value={to}
        onChange={(e) => onTo(e.target.value)}
        className="bg-transparent text-xs text-foreground outline-none [color-scheme:light] dark:[color-scheme:dark]"
      />
    </div>
  );
}

/* ─────────────────────────── Página ─────────────────────────── */

export default function Programacao() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<ProgramacaoTab>("planejado");

  // Filtros
  const [search, setSearch] = useState("");
  const [fCliente, setFCliente] = useState<string[]>([]);
  const [fRota, setFRota] = useState<string[]>([]);
  const [fStatus, setFStatus] = useState<string[]>([]);
  // Filtros multiselect (mesmo padrão de Cliente/Rotas/Status): valores "sim"/"nao".
  const [fLancado, setFLancado] = useState<string[]>([]);
  const [fAceito, setFAceito] = useState<string[]>([]);
  const [carregDe, setCarregDe] = useState("");
  const [carregAte, setCarregAte] = useState("");
  const [descargaDe, setDescargaDe] = useState("");
  const [descargaAte, setDescargaAte] = useState("");

  // Ordenação pela agenda (data de carregamento), igual ao Monitor de prod:
  // cabeçalho Carreg./Descarga clicável, alterna asc/desc, persistido.
  const [agendaSortDir, setAgendaSortDir] = useState<"asc" | "desc">(() => {
    if (typeof window === "undefined") return "asc";
    return window.localStorage.getItem("lamonica-programacao-agenda-sort") === "desc" ? "desc" : "asc";
  });
  useEffect(() => {
    try {
      window.localStorage.setItem("lamonica-programacao-agenda-sort", agendaSortDir);
    } catch {
      /* localStorage indisponível — ignora */
    }
  }, [agendaSortDir]);
  const toggleAgendaSort = () => setAgendaSortDir((prev) => (prev === "asc" ? "desc" : "asc"));

  // Relógio para manter a tela SEMPRE em dia com o horário atual: a cada 30s
  // reavaliamos quais viagens do Planejado já ficaram atrasadas (carregamento no
  // passado) e as escondemos na hora, sem esperar o próximo fetch do servidor.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  // Importar programação (CSV) — movido da tela de Cargas; mesmo comportamento.
  const [importOpen, setImportOpen] = useState(false);

  // Fluxo "sem rota → cadastrar rota antes de lançar"
  const [routeModalOpen, setRouteModalOpen] = useState(false);
  // Qual fluxo abriu o modal de rota: "launch" (lançar spot) ou "import"
  // (remediar cargas importadas sem rota). Muda o que acontece após salvar.
  const [routeFlow, setRouteFlow] = useState<"launch" | "import">("launch");
  // Fila de remediação da importação (trechos sem rota, deduplicados).
  const [importQueue, setImportQueue] = useState<{ origem: string; destino: string; clienteNome: string | null }[]>([]);
  const [routeModalInitial, setRouteModalInitial] = useState<RouteFormData | null>(null);
  const [pendingLaunchRow, setPendingLaunchRow] = useState<ProgramacaoRow | null>(null);

  // "Atualizar" força busca ao vivo (sem cache). O queryFn lê e reseta a flag.
  // Um ref por query (Planejado+Aceito e Concluído).
  const forceMainRef = useRef(false);
  const forceConcRef = useRef(false);

  // Query PRINCIPAL: Planejado + Aceito. Rápida (o Concluído pesado é lazy, abaixo).
  const mainQuery = useQuery<ProgramacaoOverview>({
    queryKey: PROGRAMACAO_MAIN_KEY,
    queryFn: () => {
      const force = forceMainRef.current;
      forceMainRef.current = false;
      return fetchProgramacao({ force, tabs: "planejado,aceito" });
    },
    // Renderiza o cache na hora (sensação de velocidade) e revalida em background;
    // poll 90s (o portal SPX só muda ~a cada 10min). staleTime 0 = sempre revalida
    // ao montar/focar, mas o cache aparece instantâneo (react-query não bloqueia).
    refetchInterval: 90_000,
    refetchIntervalInBackground: false,
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    retry: 1,
  });

  // Concluído: prefetch em BACKGROUND 1x ao abrir a tela, só para o CONTADOR já vir
  // certo (antes nascia 0 porque era 100% lazy). Não bloqueia o render inicial —
  // Planejado/Aceito aparecem na hora e o número do Concluído preenche em seguida.
  // Mantém leve: SEM polling em background (só quando a aba está ativa) e com cache
  // (staleTime) para NÃO repetir a consulta pesada (history/list do SPX + lookup de
  // cargas) a cada montagem. Aba ativa = revalida/poll para a lista ficar fresca.
  const concluidoAtivo = tab === "concluido";
  const concluidoQuery = useQuery<ProgramacaoOverview>({
    queryKey: PROGRAMACAO_CONCLUIDO_KEY,
    queryFn: () => {
      const force = forceConcRef.current;
      forceConcRef.current = false;
      return fetchProgramacao({ force, tabs: "concluido" });
    },
    enabled: true,
    refetchInterval: concluidoAtivo ? 90_000 : false,
    refetchIntervalInBackground: false,
    staleTime: concluidoAtivo ? 0 : 60_000,
    refetchOnMount: concluidoAtivo ? "always" : false,
    refetchOnWindowFocus: concluidoAtivo,
    retry: 1,
  });

  // Overview mesclado: Planejado+Aceito (sempre) + Concluído (quando carregado).
  const data = useMemo<ProgramacaoOverview | undefined>(() => {
    if (!mainQuery.data) return undefined;
    const concRows = concluidoQuery.data?.rows ?? [];
    const concCount = concluidoQuery.data?.byTab?.concluido ?? 0;
    return {
      ...mainQuery.data,
      rows: [...mainQuery.data.rows, ...concRows],
      byTab: { ...mainQuery.data.byTab, concluido: concCount },
      summary: { ...mainQuery.data.summary, concluido: concCount },
      warnings: [...(mainQuery.data.warnings ?? []), ...(concluidoQuery.data?.warnings ?? [])],
    };
  }, [mainQuery.data, concluidoQuery.data]);

  const isLoading = mainQuery.isLoading;
  const isError = mainQuery.isError;
  const error = mainQuery.error;
  const isFetching = mainQuery.isFetching || (tab === "concluido" && concluidoQuery.isFetching);

  const routesQuery = useQuery({
    queryKey: ROUTES_KEY,
    queryFn: fetchAssignableRoutes,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });

  const clientesQuery = useQuery({
    queryKey: CLIENTES_KEY,
    queryFn: () => fetchOperatorClientes({ page: "1", pageSize: "200" }),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
  const clienteOptions = useMemo(
    () => (clientesQuery.data?.items ?? []).map((c) => ({ id: c.id, nome: c.nome })),
    [clientesQuery.data],
  );

  // DC-201 — liga/desliga o lançamento automático de spots com rota (persistido).
  const autolaunchQuery = useQuery({
    queryKey: AUTOLAUNCH_KEY,
    queryFn: getProgramacaoSettings,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
  const autolaunchOn = autolaunchQuery.data?.spotAutolaunchEnabled ?? true;
  const [autolaunchModalOpen, setAutolaunchModalOpen] = useState(false);
  const autolaunchMut = useMutation({
    mutationFn: (enabled: boolean) => setSpotAutolaunchEnabled(enabled),
    onSuccess: (res) => {
      queryClient.setQueryData(AUTOLAUNCH_KEY, res);
      setAutolaunchModalOpen(false);
      toast.success(
        res.spotAutolaunchEnabled
          ? "Lançamento automático LIGADO — cargas com rota entram no portal sozinhas."
          : "Lançamento automático DESLIGADO — o operador passa a lançar manualmente.",
      );
    },
    onError: (e: Error) => toast.error(e.message || "Erro ao alterar o lançamento automático."),
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: PROGRAMACAO_MAIN_KEY });
    queryClient.invalidateQueries({ queryKey: PROGRAMACAO_CONCLUIDO_KEY });
  };
  // Atualizar (manual): força busca ao vivo no SPX (sem cache) — garante que a tela
  // reflita exatamente o portal deles, sem remanescente.
  const forceRefresh = () => {
    forceMainRef.current = true;
    forceConcRef.current = true;
    invalidate();
  };

  const aceitarMut = useMutation({
    mutationFn: (lh: string) => acceptSpxTrips([lh]),
    onSuccess: (res) => {
      const item = res.results?.[0];
      if (item?.state === "accepted") toast.success("Viagem aceita no SPX.");
      else if (item?.state === "dry_run") toast.warning("Simulação: o envio real ao SPX está desligado (SPX_ACCEPT_WRITE_ENABLED).");
      else toast.error(item?.reason || "Não foi possível aceitar a viagem.");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message || "Erro ao aceitar a viagem."),
  });

  // Aceitar sempre pede confirmação (compromete a carga com a agência no SPX).
  const handleAceitar = (r: ProgramacaoRow) => {
    const real = Boolean(data?.acceptWriteEnabled);
    const rota = `${r.origem || "—"} → ${r.destino || "—"}`;
    const agenda = r.data ? `${fmtDate(r.data)}${r.horario ? ` ${r.horario}` : ""}` : "sem data";
    const detalhe = real
      ? "Isso RESERVA a carga com a agência no SPX (compromete SLA/financeiro)."
      : "Envio real desligado (simulação): nada será reservado de fato no SPX.";
    const ok = confirmAction(`Tem certeza que deseja aceitar a viagem ${r.lh}?`, `${rota} · ${agenda}\n\n${detalhe}`);
    if (ok) aceitarMut.mutate(r.lh);
  };

  const lancarMut = useMutation({
    mutationFn: (row: ProgramacaoRow) =>
      launchCargoFromTrip({
        lh: row.lh,
        // origem/destino = Cidade/UF limpo (sem "· TIPO"): é o que casa com o
        // catálogo de rotas. Sem isso a carga não acha a rota → sem valor/métrica
        // → não fica "ready" → some do portal do motorista.
        origem: row.origemCidadeUf || row.origem,
        destino: row.destinoCidadeUf || row.destino,
        data: row.data ?? undefined,
        horario: row.horario ?? undefined,
        dataDescarga: row.dataDescarga ?? undefined,
        horarioDescarga: row.horarioDescarga ?? undefined,
        nome: row.nome || undefined,
      }),
    onSuccess: (res) => {
      toast.success(
        res.alreadyExists
          ? "Essa viagem já estava lançada como carga."
          : res.aConfirmar
            ? "Carga lançada como 'a confirmar' (defina a agenda depois)."
            : "Carga lançada no sistema.",
      );
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message || "Erro ao lançar a carga."),
  });

  // Lançar: se a rota (origem→destino) não existir no catálogo, abre o modal de
  // cadastro de rota prefilled; após salvar, lança a carga. Se existir, lança direto.
  const handleLancar = (row: ProgramacaoRow) => {
    // Trava/aviso: carregamento no passado → a carga nasce expirada e NÃO aparece
    // no portal do motorista até a data ser ajustada. Exige confirmação.
    if (row.expirada) {
      const ok = confirmAction(
        `A viagem ${row.lh} tem carregamento no passado (${fmtDate(row.data)}).`,
        "A carga será criada mas NÃO vai aparecer no portal do motorista enquanto a data de carregamento estiver no passado (ajuste a data no Monitor). Lançar mesmo assim?",
      );
      if (!ok) return;
    }
    const routes = routesQuery.data ?? [];
    const match = findAssignableRouteByLocations(routes, row.origemCidadeUf || row.origem, row.destinoCidadeUf || row.destino);
    if (match) {
      lancarMut.mutate(row);
      return;
    }
    const clienteId = clienteOptions.find((c) => c.nome === row.cliente)?.id ?? null;
    setPendingLaunchRow(row);
    setRouteFlow("launch");
    setRouteModalInitial(makeRoutePrefill(row.origemCidadeUf || "", row.destinoCidadeUf || "", clienteId));
    setRouteModalOpen(true);
  };

  // Remediação da importação: abre o modal de rota p/ o 1º trecho da fila (ou
  // encerra e revalida quando a fila esvazia). Pré-seleciona o cliente pelo nome.
  const openImportRemediation = (queue: { origem: string; destino: string; clienteNome: string | null }[]) => {
    if (!queue.length) {
      setImportQueue([]);
      setRouteFlow("launch");
      setRouteModalOpen(false);
      setRouteModalInitial(null);
      invalidate();
      return;
    }
    const item = queue[0];
    const clienteId = clienteOptions.find((c) => c.nome === item.clienteNome)?.id ?? null;
    setImportQueue(queue);
    setRouteFlow("import");
    setRouteModalInitial(makeRoutePrefill(item.origem, item.destino, clienteId));
    setRouteModalOpen(true);
  };

  const handleSaveRoute = async (form: RouteFormData) => {
    const origem = form.origem.trim();
    const destino = form.destino.trim();
    if (!origem || !destino) {
      toast.error("Informe origem e destino da rota.");
      return;
    }
    const distancia = parseOptionalNumber(form.distancia_km);
    const tempo = parseOptionalNumber(form.tempo_estimado_horas);
    if (distancia === null || tempo === null) {
      toast.error("Informe a distância e o tempo estimado da rota.");
      return;
    }
    if (!form.tarifas.length) {
      toast.error("Adicione ao menos uma tarifa (veículo) com valor.");
      return;
    }
    try {
      // Cada tarifa (perfil+eixos) vira uma rota no catálogo. O backend desta
      // branch cria uma tarifa por chamada (createOperatorRoute); o /routes/trecho
      // multi-tarifa atômico de prod entra quando a branch subir pra main.
      let firstRotaId: string | null = null;
      for (const t of form.tarifas) {
        const resp = await createOperatorRoute({
          origem,
          destino,
          distancia_km: distancia,
          duracao_horas: tempo,
          tempo_estimado_horas: tempo,
          perfil_padrao: trimTextOrNull(t.perfil),
          eixos: t.eixos,
          valor_padrao: parseMoneyInput(t.valor),
          bonus_padrao: parseMoneyInput(t.bonus),
          bonus_exigencias: trimTextOrNull(t.bonus_exigencias),
          ativa: form.ativa,
          observacoes: null,
        });
        if (!firstRotaId) firstRotaId = resp.rota_id ?? null;
      }
      if (form.cliente_id && firstRotaId) {
        try {
          await attachClienteRota(form.cliente_id, firstRotaId);
        } catch {
          /* vínculo é best-effort; a rota já foi criada */
        }
      }
      await queryClient.invalidateQueries({ queryKey: ROUTES_KEY });
      setRouteModalOpen(false);
      setRouteModalInitial(null);

      // Remediação de importação: cadastrou a rota do trecho da carga importada →
      // avança para o próximo trecho sem rota (ou encerra e revalida a tela).
      if (routeFlow === "import") {
        const rest = importQueue.slice(1);
        toast.success(rest.length ? "Rota cadastrada. Próxima carga sem rota…" : "Rotas das cargas importadas cadastradas.");
        openImportRemediation(rest);
        return;
      }

      // Fluxo "lançar" (DC-201): dispara a varredura de auto-lançamento na hora.
      // Lança a viagem pendente + irmãs no mesmo trecho no portal, sem esperar o
      // ciclo de ~5min. Best-effort: se a varredura falhar (SPX fora), lança a pendente.
      const row = pendingLaunchRow;
      setPendingLaunchRow(null);
      try {
        const res = await runAutoLaunchSpots();
        toast.success(
          res.launched > 0
            ? `Rota cadastrada — ${res.launched} carga(s) lançada(s) no portal.`
            : "Rota cadastrada. A carga aparece no portal assim que a viagem for elegível.",
        );
      } catch {
        if (row) lancarMut.mutate(row);
        else toast.success("Rota cadastrada.");
      }
      invalidate();
    } catch (e) {
      toast.error((e as Error).message || "Erro ao cadastrar a rota.");
      // Mantém o modal aberto para o operador corrigir e tentar novamente.
    }
  };

  const rows = useMemo<ProgramacaoRow[]>(() => data?.rows ?? [], [data]);

  // Opções dos multiselects (Cliente/Rotas/Status) — de todas as linhas.
  const options = useMemo(() => {
    const cli = new Set<string>();
    const rota = new Set<string>();
    const st = new Set<string>();
    for (const r of rows) {
      if (r.cliente) cli.add(r.cliente);
      rota.add(routeLabel(r));
      const s = rowStatus(r);
      if (s) st.add(s);
    }
    const strOpts = (set: Set<string>): MultiSelectOption[] =>
      [...set].sort((a, b) => a.localeCompare(b, "pt-BR")).map((v) => ({ value: v, label: v }));
    const clienteNames = data?.clientes?.length ? data.clientes.map((c) => c.nome) : [...cli];
    return {
      cliente: [...new Set(clienteNames)].sort((a, b) => a.localeCompare(b, "pt-BR")).map((v) => ({ value: v, label: v })),
      rota: strOpts(rota),
      status: strOpts(st),
    };
  }, [rows, data?.clientes]);

  const filteredAll = useMemo(() => {
    const q = search.trim().toUpperCase();
    const cliSet = new Set(fCliente);
    const rotaSet = new Set(fRota);
    const stSet = new Set(fStatus);
    const lancSet = new Set(fLancado);
    const aceSet = new Set(fAceito);
    return rows.filter((r) => {
      // Nunca desatualizado: no Planejado, esconde viagens já atrasadas (carregamento
      // no passado vs o relógio corrente). Compara epoch absoluto → sem ambiguidade de
      // fuso. Reavaliado a cada tick (nowMs). Aceito/Concluído são naturalmente passados.
      if (r.tab === "planejado" && r.carregamentoTs && r.carregamentoTs * 1000 < nowMs) return false;
      if (q && !`${r.lh} ${r.nome}`.toUpperCase().includes(q)) return false;
      if (cliSet.size && !cliSet.has(r.cliente)) return false;
      if (rotaSet.size && !rotaSet.has(routeLabel(r))) return false;
      if (stSet.size && !stSet.has(rowStatus(r))) return false;
      // Filtro por data+hora (datetime-local). Compara instante de parede como string
      // 'YYYY-MM-DDTHH:MM' (largura fixa → ordem lexicográfica = cronológica).
      const cDt = dtKey(r.data, r.horario);
      if (carregDe && !(cDt && cDt >= carregDe)) return false;
      if (carregAte && !(cDt && cDt <= carregAte)) return false;
      const dDt = dtKey(r.dataDescarga, r.horarioDescarga);
      if (descargaDe && !(dDt && dDt >= descargaDe)) return false;
      if (descargaAte && !(dDt && dDt <= descargaAte)) return false;
      // Lançado / não lançado (carga já criada no sistema).
      if (lancSet.size && !lancSet.has(r.jaLancada ? "sim" : "nao")) return false;
      // Aceito / não aceito no SPX (acceptanceStatus 1=aceito, 0=não aceito; null=não-LT).
      if (aceSet.size) {
        const key = r.acceptanceStatus === 1 ? "sim" : r.acceptanceStatus === 0 ? "nao" : null;
        if (key === null || !aceSet.has(key)) return false;
      }
      return true;
    });
  }, [rows, search, fCliente, fRota, fStatus, carregDe, carregAte, descargaDe, descargaAte, fLancado, fAceito, nowMs]);

  const countFor = (t: ProgramacaoTab) => filteredAll.filter((r) => r.tab === t).length;
  const visibleRows = useMemo(() => {
    const list = filteredAll.filter((r) => r.tab === tab);
    const dir = agendaSortDir === "asc" ? 1 : -1;
    // Ordena pela data de carregamento (epoch); linhas sem data vão pro fim.
    return [...list].sort((a, b) => {
      const ta = a.carregamentoTs;
      const tb = b.carregamentoTs;
      if (ta == null && tb == null) return 0;
      if (ta == null) return 1;
      if (tb == null) return -1;
      return (ta - tb) * dir;
    });
  }, [filteredAll, tab, agendaSortDir]);

  const hasActiveFilters =
    search.trim().length > 0 ||
    fCliente.length + fRota.length + fStatus.length + fLancado.length + fAceito.length > 0 ||
    Boolean(carregDe || carregAte || descargaDe || descargaAte);

  const clearFilters = () => {
    setSearch("");
    setFCliente([]);
    setFRota([]);
    setFStatus([]);
    setCarregDe("");
    setCarregAte("");
    setDescargaDe("");
    setDescargaAte("");
    setFLancado([]);
    setFAceito([]);
  };

  /* ── Loading / erro ── */
  if (isLoading) {
    return (
      <Shell>
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Carregando programação…
        </div>
      </Shell>
    );
  }

  if (isError || !data) {
    const status = (error as { status?: number } | null)?.status;
    const notConfigured = status === 503;
    return (
      <Shell>
        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm text-amber-800">
          <div className="flex items-center gap-2 font-semibold">
            <AlertTriangle className="h-4 w-4" />
            {notConfigured ? "Viagens SPX indisponíveis no momento" : "Não foi possível carregar a programação"}
          </div>
          <p className="mt-1 text-amber-700">
            {notConfigured
              ? "Não deu para consultar o SPX agora — o serviço de viagens (sidecar SPX) está fora do ar ou a sessão do SPX/Shopee expirou. Tente novamente; se persistir, renove a sessão do SPX."
              : (error as Error | null)?.message || "Tente novamente em instantes."}
          </p>
          <Button variant="outline" className="mt-3 gap-2" onClick={forceRefresh}>
            <RefreshCw className="h-4 w-4" /> Tentar novamente
          </Button>
        </div>
      </Shell>
    );
  }

  const activeWarnings = (data.warnings ?? []).filter((w) => WARNING_LABEL[w]);

  return (
    <div className="min-w-0">
      <DashboardHeader
        title="Programação"
        subtitle="Viagens disponíveis por cliente — visualizar, aceitar e lançar"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              className={cn(
                "gap-2",
                autolaunchOn
                  ? "border-emerald-300 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-500/40 dark:text-emerald-300 dark:hover:bg-emerald-500/10"
                  : "border-border text-muted-foreground",
              )}
              onClick={() => setAutolaunchModalOpen(true)}
              disabled={autolaunchQuery.isLoading}
              title="Liga/desliga o lançamento automático de cargas com rota no portal do motorista"
            >
              <Zap className={cn("h-4 w-4", autolaunchOn && "fill-current")} />
              Lançamento automático: {autolaunchOn ? "Ligado" : "Desligado"}
            </Button>
            <Button variant="outline" className="gap-2" onClick={() => setImportOpen(true)}>
              <Upload className="h-4 w-4" /> Importar programação
            </Button>
            <Button variant="outline" className="gap-2" onClick={forceRefresh} disabled={isFetching}>
              <RefreshCw className={cn("h-4 w-4", isFetching && "animate-spin")} /> Atualizar
            </Button>
          </div>
        }
      />

      <main className="min-w-0 space-y-5 p-6 lg:p-8">
        {/* Resumo */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard label="Planejado" value={data.summary.planejado} hint={`${data.summary.podeAceitar} p/ aceitar · ${data.summary.aguardandoMotorista} s/ motorista`} />
          <StatCard label="Aceito" value={data.summary.aceito} />
          <StatCard label="Concluído" value={data.summary.concluido} />
          <StatCard label="Já lançadas" value={data.summary.jaLancadas} hint="viraram carga" />
        </div>

        {/* Avisos */}
        {!data.acceptWriteEnabled && (
          <div className="rounded-xl border border-sky-200 bg-sky-50 px-4 py-2.5 text-xs text-sky-800">
            Aceite em <strong>simulação</strong>: o envio real ao SPX está desligado (SPX_ACCEPT_WRITE_ENABLED). As viagens não são reservadas de fato.
          </div>
        )}
        {activeWarnings.map((w) => (
          <div key={w} className="flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs text-amber-800">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> {WARNING_LABEL[w]}
          </div>
        ))}

        {/* Barra de filtros */}
        <div className="flex flex-col gap-3 lg:flex-row lg:flex-wrap lg:items-center">
          <div className="relative min-w-[240px] flex-1">
            <Search className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              placeholder="Pesquisar por código da viagem (LH)…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full rounded-2xl border border-border/80 bg-background py-3 pl-11 pr-4 text-sm text-foreground outline-none transition-all duration-200 placeholder:text-muted-foreground focus:border-primary/30 focus:ring-4 focus:ring-primary/10"
            />
          </div>
          <MultiSelectFilter label="Cliente" options={options.cliente} selected={fCliente} onChange={setFCliente} searchPlaceholder="Buscar cliente…" />
          <MultiSelectFilter label="Rotas" options={options.rota} selected={fRota} onChange={setFRota} searchPlaceholder="Buscar rota…" />
          <MultiSelectFilter label="Status" options={options.status} selected={fStatus} onChange={setFStatus} searchPlaceholder="Buscar status…" />
          <MultiSelectFilter label="Lançado" options={LANCADO_OPTS} selected={fLancado} onChange={setFLancado} searchPlaceholder="Buscar…" />
          <MultiSelectFilter label="Aceito" options={ACEITO_OPTS} selected={fAceito} onChange={setFAceito} searchPlaceholder="Buscar…" />
          <DateRangeFilter label="Carregamento" from={carregDe} to={carregAte} onFrom={setCarregDe} onTo={setCarregAte} />
          <DateRangeFilter label="Descarga" from={descargaDe} to={descargaAte} onFrom={setDescargaDe} onTo={setDescargaAte} />
          {hasActiveFilters && (
            <button
              type="button"
              onClick={clearFilters}
              className="inline-flex items-center gap-1.5 rounded-2xl border border-border/80 px-4 py-3 text-sm font-semibold text-muted-foreground transition hover:bg-muted/60"
            >
              <X className="h-4 w-4" /> Limpar filtros
            </button>
          )}
        </div>

        {/* Abas por status */}
        <div className="inline-flex gap-1 rounded-xl bg-muted p-1">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={cn(
                "rounded-lg px-3.5 py-1.5 text-xs font-semibold transition",
                tab === t.key ? "bg-background text-foreground shadow" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t.label}
              <span className="ml-1.5 tabular-nums opacity-70">{countFor(t.key)}</span>
            </button>
          ))}
        </div>

        {/* Tabela */}
        {tab === "concluido" && concluidoQuery.isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Carregando concluídas…
          </div>
        ) : visibleRows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {hasActiveFilters
              ? "Nenhuma viagem para os filtros aplicados."
              : `Nenhuma viagem em “${TABS.find((t) => t.key === tab)?.label}”.`}
          </p>
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-border/70 bg-card shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
            {/* Linha enxuta: Cliente+Cód. e Carregamento+Descarga empilhados em uma
                célula cada, p/ a tabela caber SEM coluna fixa nem scroll. A Rota vem
                por extenso (sem truncar), quebrando linha quando necessário. */}
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/60 bg-muted/50 text-left text-[0.62rem] uppercase tracking-wide text-muted-foreground">
                  <th className="px-3 py-2.5">Cliente / Cód.</th>
                  <th className="px-3 py-2.5">Rota</th>
                  <th className="px-3 py-2.5">
                    <button
                      type="button"
                      onClick={toggleAgendaSort}
                      title={
                        agendaSortDir === "asc"
                          ? "Carregamento: mais antigo no topo. Clique para inverter."
                          : "Carregamento: mais novo no topo. Clique para inverter."
                      }
                      className="inline-flex items-center gap-1 uppercase tracking-wide text-muted-foreground/80 transition-colors hover:text-foreground"
                    >
                      Carreg. / Descarga
                      {agendaSortDir === "asc" ? (
                        <ArrowUp className="h-3 w-3 text-primary" />
                      ) : (
                        <ArrowDown className="h-3 w-3 text-primary" />
                      )}
                    </button>
                  </th>
                  <th className="px-3 py-2.5">Status</th>
                  {tab !== "planejado" && <th className="px-3 py-2.5">Motorista / Veículo</th>}
                  <th className="px-3 py-2.5 text-right">Ações</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {visibleRows.map((r, i) => (
                  <tr key={`${r.tab}:${r.lh}`} className={cn("align-top transition hover:bg-primary/[0.03]", i % 2 === 1 && "bg-muted/20")}>
                    <td className="px-3 py-2.5">
                      <div className="font-medium text-foreground">{r.cliente || "—"}</div>
                      <div className="font-mono text-[11px] text-muted-foreground">{r.lh || "—"}</div>
                    </td>
                    <td className="px-3 py-2.5">
                      <span className="font-medium text-foreground">{r.origem || "—"}</span>
                      <span className="text-muted-foreground"> → {r.destino || "—"}</span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-muted-foreground">
                      <div>{r.data ? `${fmtDate(r.data)}${r.horario ? ` ${r.horario}` : ""}` : <span className="text-amber-600 dark:text-amber-400">A confirmar</span>}</div>
                      <div className="text-[11px]">↓ {r.dataDescarga ? `${fmtDate(r.dataDescarga)}${r.horarioDescarga ? ` ${r.horarioDescarga}` : ""}` : <span className="text-amber-600 dark:text-amber-400">A confirmar</span>}</div>
                    </td>
                    <td className="px-3 py-2.5">
                      <span className={cn("inline-flex whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-semibold", TAB_TINT[r.tab])}>
                        {rowStatus(r) || "—"}
                      </span>
                    </td>
                    {tab !== "planejado" && (
                      <td className="px-3 py-2.5 text-muted-foreground">
                        {[r.motorista, r.placa].filter(Boolean).join(" · ") || "—"}
                      </td>
                    )}
                    <td className="px-3 py-2.5">
                      <div className="flex items-center justify-end gap-2">
                        {r.jaLancada ? (
                          <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-600">
                            <CheckCircle2 className="h-3.5 w-3.5" /> Lançada
                          </span>
                        ) : (
                          // Sem data (r.data ausente) o operador ainda pode lançar — a
                          // carga entra "a confirmar" e a agenda é definida depois.
                          r.tab === "planejado" && (
                            <button
                              type="button"
                              onClick={() => handleLancar(r)}
                              disabled={lancarMut.isPending}
                              title={r.data ? undefined : "Sem carregamento definido — lança como 'a confirmar'"}
                              className="inline-flex items-center gap-1 rounded-lg border border-border bg-secondary px-2.5 py-1 text-[11px] font-semibold text-secondary-foreground transition hover:bg-secondary/70 disabled:opacity-50"
                            >
                              <PackagePlus className="h-3.5 w-3.5" /> Lançar
                            </button>
                          )
                        )}
                        {r.podeAceitar && (
                          <button
                            type="button"
                            onClick={() => handleAceitar(r)}
                            disabled={aceitarMut.isPending}
                            className="rounded-lg bg-primary px-2.5 py-1 text-[11px] font-semibold text-primary-foreground transition hover:bg-primary/90 disabled:opacity-50"
                          >
                            Aceitar
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>

      {/* Sem rota → cadastrar antes de lançar (mesma tela) */}
      <RouteModal
        open={routeModalOpen}
        onClose={() => {
          setRouteModalOpen(false);
          setRouteModalInitial(null);
          setPendingLaunchRow(null);
          setImportQueue([]);
          setRouteFlow("launch");
        }}
        onSave={handleSaveRoute}
        initialData={routeModalInitial}
        supportsCatalogFields
        clientes={clienteOptions}
        existingRoutes={routesQuery.data ?? []}
      />

      {/* Importar programação (CSV) — movido da tela de Cargas */}
      <ImportProgramacaoModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        clientes={clienteOptions}
        onClientesChanged={() => queryClient.invalidateQueries({ queryKey: CLIENTES_KEY })}
        onImported={(result: ImportCargasResponse) => {
          invalidate();
          // Cargas importadas SEM rota → remediação: abre o modal de rota (uma vez
          // por trecho, deduplicado) já preenchido, com cliente pré-selecionado.
          const seen = new Set<string>();
          const queue: { origem: string; destino: string; clienteNome: string | null }[] = [];
          for (const r of result?.rows ?? []) {
            if (!r.ok || (r.action !== "insert" && r.action !== "update")) continue;
            if (r.preview?.route_registered !== false) continue;
            const origem = (r.preview.origem ?? "").trim();
            const destino = (r.preview.destino ?? "").trim();
            const key = `${origem}|${destino}`.toLowerCase();
            if (!origem || !destino || seen.has(key)) continue;
            seen.add(key);
            queue.push({ origem, destino, clienteNome: r.preview.cliente_nome ?? null });
          }
          if (queue.length) openImportRemediation(queue);
        }}
      />

      {/* DC-201 — confirmação de liga/desliga do lançamento automático. */}
      <Dialog open={autolaunchModalOpen} onOpenChange={(o) => !autolaunchMut.isPending && setAutolaunchModalOpen(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {autolaunchOn ? "Desligar" : "Ligar"} o lançamento automático de cargas?
            </DialogTitle>
            <DialogDescription className="space-y-2 pt-1">
              {autolaunchOn ? (
                <>
                  Hoje está <strong>ligado</strong>: toda viagem SPX Planejado que já tem rota
                  cadastrada é lançada <strong>sozinha</strong> no portal do motorista (a cada ~5 min),
                  sem aceite no SPX.
                  <br />
                  Ao desligar, o sistema para de lançar automaticamente — o operador passa a lançar
                  manualmente pela tela. Tem certeza que é isso que você quer?
                </>
              ) : (
                <>
                  Hoje está <strong>desligado</strong>. Ao ligar, o sistema volta a lançar{" "}
                  <strong>sozinho</strong> no portal do motorista toda viagem SPX Planejado que já tem
                  rota cadastrada (a cada ~5 min), sem aceite no SPX — as cargas passam a aparecer para
                  os motoristas automaticamente. Tem certeza que é isso que você quer?
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setAutolaunchModalOpen(false)}
              disabled={autolaunchMut.isPending}
            >
              Cancelar
            </Button>
            <Button
              variant={autolaunchOn ? "destructive" : "default"}
              className="gap-2"
              onClick={() => autolaunchMut.mutate(!autolaunchOn)}
              disabled={autolaunchMut.isPending}
            >
              {autolaunchMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {autolaunchOn ? "Sim, desligar" : "Sim, ligar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
