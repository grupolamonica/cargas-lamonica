import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Bell, CheckCheck, Trash2, Truck, UserPlus } from "lucide-react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  ensureNotificationPermission,
  playSpotBeep,
  showDesktopNotification,
  speakSpot,
  startSpeakingLoop,
  stopSpeakingLoop,
  unlockSpotAudio,
} from "@/lib/spotAlert";
import {
  clearOperatorNotifications,
  createTestSpotNotification,
  fetchOperatorNotifications,
  markOperatorNotificationsSeen,
  type OperatorNotification,
} from "@/services/readModels";

const NOTIFICATIONS_KEY = ["operator", "notifications"];

const KIND_LABEL: Record<string, string> = {
  reservation_timeout: "Reserva expirou",
  reservation_undelivered: "Motorista não avisado (WhatsApp)",
  driver_reply_accept: "Motorista aceitou",
  driver_reply_reject: "Motorista recusou",
  driver_reply_unresolved: "Resposta sem número identificado",
  mass_reply_accept: "Interessado no envio em massa",
  mass_candidatura_criada: "Nova candidatura via chat",
  reply_send_failed: "Falha ao responder motorista",
  driver_media_reply: "Motorista mandou áudio/mídia",
  return_interest_match: "Match: apareceu carga que combina",
  reconcile_done: "Conciliação Angellira concluída",
  route_need_accept: "Motorista topou chamado de carga",
  route_need_converted: "Candidatura via chamado de carga",
  new_spot: "Nova carga spot disponível",
  new_queue_driver: "Novo motorista na fila",
  aspx_trip_missing: "Carga saiu do ASPX",
  aspx_trip_restored: "Viagem voltou ao ASPX",
  aspx_route_missing: "Rota saiu do ASPX",
  sheet_writeback_broken: "Planilha não recebeu cargas",
  aspx_route_restored: "Rota voltou ao ASPX",
  // Disjuntor do aceite SPX: o portal respondeu "não aceita" para uma pilha de viagens
  // de uma vez, o job desconfiou e NÃO escondeu ninguém do Monitor. O rótulo precisa
  // mandar o operador para o portal — é lá, e só lá, que se descobre se o aceite sumiu
  // de verdade ou se foi a aba Planejado respondendo. Kind sem label vira slug cru no
  // sino ("spx_acceptance_mass_hide"), e slug cru o operador ignora.
  spx_acceptance_mass_hide: "Muitas lançadas sem aceite — confira o portal",
};

const KIND_TINT: Record<string, string> = {
  reservation_timeout: "bg-amber-500",
  reservation_undelivered: "bg-orange-500",
  driver_reply_accept: "bg-emerald-500",
  driver_reply_reject: "bg-red-500",
  driver_reply_unresolved: "bg-sky-500",
  mass_reply_accept: "bg-indigo-500",
  mass_candidatura_criada: "bg-emerald-500",
  reply_send_failed: "bg-orange-500",
  driver_media_reply: "bg-purple-500",
  return_interest_match: "bg-emerald-500",
  reconcile_done: "bg-sky-500",
  route_need_accept: "bg-teal-500",
  route_need_converted: "bg-emerald-500",
  new_spot: "bg-blue-600",
  new_queue_driver: "bg-emerald-600",
  aspx_trip_missing: "bg-red-600",
  aspx_trip_restored: "bg-emerald-500",
  aspx_route_missing: "bg-red-700",
  sheet_writeback_broken: "bg-orange-600",
  aspx_route_restored: "bg-emerald-500",
  // Mesmo peso visual de `aspx_route_missing` (bg-red-700): é um aviso da mesma família
  // — "o portal parou de bater com o que temos". Sem entrada aqui o ponto cai no
  // `bg-slate-400` do fallback, cinza de ruído, e o aviso mais importante deste fluxo
  // chegaria vestido de "pode ignorar".
  spx_acceptance_mass_hide: "bg-red-700",
};

function fmtRelative(iso: string) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const diff = Date.now() - t;
  if (diff < 60_000) return "agora";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}min atrás`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h atrás`;
  return new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
}

function spotHref(metadata: Record<string, unknown> | undefined): string {
  const lh = metadata && typeof metadata.lh === "string" ? metadata.lh.trim() : "";
  return lh ? `/programacao?lh=${encodeURIComponent(lh)}` : "/programacao";
}

// Leva de spots (alerta "Programação disponível"): manda TODAS as LHs (?lh=A,B,C) p/ a
// Programação filtrar/destacar todas — não só a primeira.
function spotHrefMany(lhs: string[]): string {
  const uniq = [...new Set(lhs.map((s) => String(s).trim()).filter(Boolean))];
  return uniq.length ? `/programacao?lh=${uniq.map(encodeURIComponent).join(",")}` : "/programacao";
}

// Aviso "carga saiu do ASPX" leva à tela de Cargas já filtrada pelo LH da viagem —
// é lá que a carga continua (ela sai do Monitor, mas nunca do sistema).
function cargasHref(metadata: Record<string, unknown> | undefined): string {
  const lh = metadata && typeof metadata.lh === "string" ? metadata.lh.trim() : "";
  return lh ? `/cargas?busca=${encodeURIComponent(lh)}` : "/cargas";
}

// DC-299 — alerta de novo motorista na fila leva à Fila (/leads) destacando a(s) carga(s)
// do(s) motorista(s). ?carga=A,B,C → a Fila realça/expande esses grupos.
function queueHrefMany(cargaIds: string[]): string {
  const uniq = [...new Set(cargaIds.map((s) => String(s).trim()).filter(Boolean))];
  return uniq.length ? `/leads?carga=${uniq.map(encodeURIComponent).join(",")}` : "/leads";
}

export default function NotificationsBell() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const { data } = useQuery({
    queryKey: NOTIFICATIONS_KEY,
    queryFn: fetchOperatorNotifications,
    // O cache do servidor tem TTL de 45s, dimensionado PARA este poll de 30s
    // (__notificationsCacheTiming em backend/src/application/driver-outreach/admin.js).
    // Se este número subir acima de 45s, o cache volta a dar zero hit — mexer nos dois
    // lados junto.
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  const items = useMemo<OperatorNotification[]>(() => data?.items ?? [], [data?.items]);
  const unseen = data?.unseenCount ?? 0;

  const goToSpot = (metadata: OperatorNotification["metadata"]) => {
    setOpen(false);
    navigate(spotHref(metadata));
  };

  // DC-279 — dispara o alerta completo (som de alarme + notificação do SO + card na
  // tela). Compartilhado pela detecção real e pelo botão de teste (dev). O card fica
  // na tela até o operador dispensar/aceitar (notificação visual persistente).
  // Alvo do alarme sonoro em curso: ids das notificações que dispararam o loop de voz
  // + id do toast/card. Servem para "Dispensar para todos" — quando essas notificações
  // viram `seen` (por qualquer operador), o loop para em TODAS as telas (efeito abaixo).
  const alarmingIdsRef = useRef<Set<string> | null>(null);
  const alarmToastIdRef = useRef<string | number | null>(null);

  const fireSpotAlert = useCallback(
    (opts: {
      count: number;
      rota: string;
      body?: string | null;
      tag: string;
      ids: string[];
      audio: boolean;
      onOpen: () => void;
    }) => {
      const { count, rota, body, tag, ids, audio, onOpen } = opts;
      const many = count > 1;
      // Som (bip + voz em LOOP) SÓ quando a carga é forecast (audio=true). Os demais
      // tipos (Adhoc/FM Hub/Nestlé) ainda aparecem no sino + card, mas sem alarme sonoro.
      if (audio) {
        playSpotBeep();
        startSpeakingLoop(many ? "Programação disponível" : "Spot disponível");
        alarmingIdsRef.current = new Set(ids);
      }
      showDesktopNotification({
        title: many ? `🚚 Programação disponível — ${count} cargas` : "🚚 Spot disponível",
        body: many ? "Clique para ver e aceitar na Programação" : `${rota}${body ? ` · ${body}` : ""}`,
        tag,
        onClick: onOpen,
      });
      const toastId = toast.custom(
        (id) => (
          <div className="flex w-[380px] max-w-[92vw] items-start gap-3 rounded-2xl border border-blue-200 bg-white p-4 shadow-xl dark:border-blue-500/40 dark:bg-slate-900">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-blue-600 text-white shadow-sm">
              <Truck className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-blue-600 dark:text-blue-400">
                {many ? `Programação disponível · ${count} cargas` : "Spot disponível"}
              </p>
              <p className="mt-0.5 truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
                {many ? "Disponíveis para aceitar" : rota}
              </p>
              {!many && body ? (
                <p className="mt-0.5 truncate text-xs text-slate-500 dark:text-slate-400">{body}</p>
              ) : null}
              <div className="mt-2.5 flex items-center gap-2">
                {/* "Ver a carga" só NAVEGA (não aceita, não dispensa) — a voz segue
                    tocando até Dispensar ou aceitar a carga no sistema. */}
                <button
                  type="button"
                  onClick={onOpen}
                  className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-blue-700"
                >
                  Ver a carga
                </button>
                <button
                  type="button"
                  onClick={() => {
                    toast.dismiss(id);
                    stopSpeakingLoop(); // silencia a voz nesta tela na hora
                    // DISPENSAR PARA TODOS: marca as notificações do alarme como vistas
                    // (linhas globais em operator_notifications) → os outros operadores
                    // param o alarme no próximo poll (efeito "parar loop quando visto").
                    if (ids.length) {
                      void markOperatorNotificationsSeen({ ids })
                        .then(() => queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_KEY }))
                        .catch(() => {});
                    }
                    alarmingIdsRef.current = null;
                    alarmToastIdRef.current = null;
                  }}
                  className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-slate-500 transition hover:bg-slate-100 dark:hover:bg-slate-800"
                >
                  Dispensar
                </button>
              </div>
            </div>
          </div>
        ),
        { duration: Infinity }, // fica na tela até dispensar/aceitar (visual persistente)
      );
      if (audio) alarmToastIdRef.current = toastId;
    },
    [queryClient],
  );

  // DC-299 — alerta LEVE de novo motorista na fila: bip + 1 aviso de voz (SEM loop — o
  // operador não precisa "aceitar" na hora, e motorista entra na fila com frequência) +
  // notificação do navegador + toast que some sozinho (o sino guarda o histórico).
  const fireQueueAlert = useCallback(
    (opts: { count: number; nome: string; body?: string | null; tag: string; onOpen: () => void }) => {
      const { count, nome, body, tag, onOpen } = opts;
      const many = count > 1;
      playSpotBeep();
      speakSpot(many ? "Novos motoristas na fila" : "Novo motorista na fila"); // 1x, sem loop
      showDesktopNotification({
        title: many ? `👤 ${count} novos motoristas na fila` : "👤 Novo motorista na fila",
        body: many ? "Clique para ver na Fila" : `${nome || "Motorista"}${body ? ` · ${body}` : ""}`,
        tag,
        onClick: onOpen,
      });
      toast.custom(
        (id) => (
          <div className="flex w-[380px] max-w-[92vw] items-start gap-3 rounded-2xl border border-emerald-200 bg-white p-4 shadow-xl dark:border-emerald-500/40 dark:bg-slate-900">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-emerald-600 text-white shadow-sm">
              <UserPlus className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-emerald-600 dark:text-emerald-400">
                {many ? `${count} novos motoristas na fila` : "Novo motorista na fila"}
              </p>
              <p className="mt-0.5 truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
                {many ? "Veja na Fila" : nome || "Motorista"}
              </p>
              {!many && body ? (
                <p className="mt-0.5 truncate text-xs text-slate-500 dark:text-slate-400">{body}</p>
              ) : null}
              <div className="mt-2.5 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    toast.dismiss(id);
                    onOpen();
                  }}
                  className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-700"
                >
                  Ver na fila
                </button>
                <button
                  type="button"
                  onClick={() => toast.dismiss(id)}
                  className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-slate-500 transition hover:bg-slate-100 dark:hover:bg-slate-800"
                >
                  Dispensar
                </button>
              </div>
            </div>
          </div>
        ),
        { duration: 20_000 },
      );
    },
    [],
  );

  // Botões de teste (gate backend ENABLE_TEST_NOTIFICATIONS): CRIAM notificação(ões) de
  // spot REAIS no banco (metadata.test=true) → caem no sino de TODOS (persistem,
  // dismissáveis). Mas o ALARME (voz em loop + card) dispara SÓ na tela de quem clicou —
  // localmente aqui —, porque a detecção (abaixo) ignora metadata.test. Assim o operador
  // testa o alerta completo sem estourar o alarme na tela dos outros operadores.
  const testMut = useMutation({
    mutationFn: (count: number) => {
      unlockSpotAudio();
      void ensureNotificationPermission();
      return createTestSpotNotification(count);
    },
    onSuccess: (_res, count) => {
      queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_KEY });
      fireSpotAlert({
        count,
        rota: "Simões Filho/BA → Jaboatão dos Guararapes/PE",
        body: "TESTE · aceite na Programação",
        tag: `teste-${count}`,
        ids: [], // teste local: sem ids reais p/ "dispensar para todos"
        audio: true, // o botão de teste serve justamente p/ testar o som
        onOpen: () => {
          setOpen(false);
          navigate("/programacao");
        },
      });
    },
    onError: (e: Error) => toast.error(e.message || "Falha ao criar notificação de teste."),
  });
  const testSpotAlert = () => testMut.mutate(1);
  const testProgramacaoAlert = () => testMut.mutate(4);

  // DC-279: som + notificação do navegador quando chega uma nova carga spot. Só
  // roda depois que a query trouxe dados (senão a 1ª leva real seria tratada como
  // "nova" e tocaria o histórico inteiro — review #11). A 1ª leva COM dados só
  // registra os IDs (sem alertar); levas seguintes (polling 30s) alertam 1x cada.
  const alertedSpotIdsRef = useRef<Set<string> | null>(null);
  // Dedup de ALARME por LH (em memória): evita re-tocar o alarme do MESMO spot se a
  // notificação for recriada — ex.: após "Limpar todas" o scanner reinsere o LH ainda
  // aberto. O card reaparece no sino normalmente; isto só corta o nag sonoro repetido.
  const alertedLhsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!data) return;
    // Alarme SÓ p/ spots reais: metadata.test é IGNORADO aqui — o botão de teste dispara
    // o alarme localmente só na tela de quem clicou (não estoura na dos outros operadores).
    const spots = items.filter(
      (n) => n.kind === "new_spot" && !(n.metadata as Record<string, unknown> | undefined)?.test,
    );
    if (alertedSpotIdsRef.current === null) {
      alertedSpotIdsRef.current = new Set(spots.map((n) => n.id));
      return;
    }
    const already = alertedSpotIdsRef.current;
    const lhOf = (n: OperatorNotification) => String((n.metadata as Record<string, unknown> | undefined)?.lh ?? "");
    const fresh = spots.filter((n) => !already.has(n.id) && !n.seen);
    fresh.forEach((n) => already.add(n.id));
    // Não re-alarma LHs já alertados nesta sessão (linha recriada após limpar/expirar).
    const alertedLhs = alertedLhsRef.current;
    const freshNew = fresh.filter((n) => {
      const lh = lhOf(n);
      return !lh || !alertedLhs.has(lh);
    });
    if (freshNew.length === 0) return;
    freshNew.forEach((n) => {
      const lh = lhOf(n);
      if (lh) alertedLhs.add(lh);
    });

    const first = freshNew[0];
    const meta = (first.metadata ?? {}) as Record<string, unknown>;
    const rota =
      [meta.origem, meta.destino].filter(Boolean).join(" → ") ||
      first.title.replace(/^Nova carga spot:\s*/i, "");
    // "Ver a carga" leva TODAS as LHs da leva (não só a primeira) → mostra todas as
    // cargas do alerta na Programação. Uma leva (freshNew > 1) usa o link multi-LH.
    const lhs = freshNew.map(lhOf).filter(Boolean);
    // Som SÓ quando há carga forecast na leva (metadata.is_forecast do scanner). Os
    // demais tipos (Adhoc/FM Hub/Nestlé) alertam só visualmente (sino + card), sem voz.
    const isForecast = (n: OperatorNotification) => {
      const m = (n.metadata ?? {}) as Record<string, unknown>;
      return m.is_forecast === true || m.tipo === "forecast";
    };
    const audio = freshNew.some(isForecast);
    fireSpotAlert({
      count: freshNew.length,
      rota,
      body: first.body,
      tag: first.id,
      ids: freshNew.map((n) => n.id),
      audio,
      onOpen: () => navigate(lhs.length > 1 ? spotHrefMany(lhs) : spotHref(first.metadata)),
    });
  }, [data, items, navigate, fireSpotAlert]);

  // DISPENSAR PARA TODOS (DC-279 iter): o alarme sonoro roda em LOOP até ser dispensado.
  // Quando as notificações que dispararam o alarme viram `seen` (por QUALQUER operador que
  // clicou em Dispensar, ou abriu o sino), este efeito — que roda a cada poll (30s) em todas
  // as telas — para o loop e fecha o card. Assim "Dispensar" vale para todos os operadores.
  useEffect(() => {
    if (!data) return;
    const alarming = alarmingIdsRef.current;
    if (!alarming || alarming.size === 0) return;
    const byId = new Map(items.map((n) => [n.id, n]));
    const allDismissed = [...alarming].every((id) => {
      const n = byId.get(id);
      return !n || n.seen; // sumiu da lista OU já foi vista → dispensada
    });
    if (allDismissed) {
      stopSpeakingLoop();
      if (alarmToastIdRef.current != null) toast.dismiss(alarmToastIdRef.current);
      alarmingIdsRef.current = null;
      alarmToastIdRef.current = null;
    }
  }, [data, items]);

  // DC-299 — novo motorista na fila. Mesmo padrão do spot (1ª leva com dados só registra
  // ids, sem alertar histórico; depois alerta 1x por lead novo). Alarme SÓ p/ reais
  // (ignora metadata.test). Dedup de alarme por lead_id em memória.
  const alertedQueueIdsRef = useRef<Set<string> | null>(null);
  const alertedLeadsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!data) return;
    const drivers = items.filter(
      (n) => n.kind === "new_queue_driver" && !(n.metadata as Record<string, unknown> | undefined)?.test,
    );
    if (alertedQueueIdsRef.current === null) {
      alertedQueueIdsRef.current = new Set(drivers.map((n) => n.id));
      return;
    }
    const already = alertedQueueIdsRef.current;
    const leadOf = (n: OperatorNotification) => String((n.metadata as Record<string, unknown> | undefined)?.lead_id ?? "");
    const cargaOf = (n: OperatorNotification) => String((n.metadata as Record<string, unknown> | undefined)?.carga_id ?? "");
    const fresh = drivers.filter((n) => !already.has(n.id) && !n.seen);
    fresh.forEach((n) => already.add(n.id));
    const alertedLeads = alertedLeadsRef.current;
    const freshNew = fresh.filter((n) => {
      const l = leadOf(n);
      return !l || !alertedLeads.has(l);
    });
    if (freshNew.length === 0) return;
    freshNew.forEach((n) => {
      const l = leadOf(n);
      if (l) alertedLeads.add(l);
    });

    const first = freshNew[0];
    const meta = (first.metadata ?? {}) as Record<string, unknown>;
    const nome = String(meta.driver ?? "").trim();
    const cargaIds = freshNew.map(cargaOf).filter(Boolean);
    fireQueueAlert({
      count: freshNew.length,
      nome,
      body: first.body,
      tag: first.id,
      onOpen: () => navigate(queueHrefMany(cargaIds)),
    });
  }, [data, items, navigate, fireQueueAlert]);

  const markAllMut = useMutation({
    mutationFn: () => markOperatorNotificationsSeen({ all: true }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_KEY }),
  });
  const clearAllMut = useMutation({
    mutationFn: () => clearOperatorNotifications({ all: true }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_KEY }),
  });

  // DC-279 — o chip de teste era TEMPORÁRIO (a pedido do operador, p/ validar o alerta em
  // prod). Removido a pedido do operador. Mantido como flag desligado p/ reativar fácil se
  // preciso; a guarda REAL segue no backend (ENABLE_TEST_NOTIFICATIONS → 403 sem a env).
  const SHOW_TEST_CHIP = false;

  return (
    <div className="flex items-center gap-2">
      {SHOW_TEST_CHIP ? (
        <div className="hidden items-center gap-1.5 rounded-2xl border border-amber-300 bg-amber-50 px-1.5 py-1 shadow-sm sm:flex dark:border-amber-500/40 dark:bg-amber-500/10">
          <span className="pl-1 text-[10px] font-bold uppercase tracking-wide text-amber-700 dark:text-amber-300">Teste</span>
          <button
            type="button"
            onClick={testSpotAlert}
            disabled={testMut.isPending}
            title="Testar: 1 spot → fala 'Spot disponível'"
            className="flex items-center gap-1 rounded-xl px-2 py-1 text-xs font-semibold text-amber-800 transition hover:bg-amber-100 disabled:opacity-50 dark:text-amber-200 dark:hover:bg-amber-500/20"
          >
            <Truck className="h-3.5 w-3.5" /> Spot
          </button>
          <button
            type="button"
            onClick={testProgramacaoAlert}
            disabled={testMut.isPending}
            title="Testar: leva de cargas → fala 'Programação disponível'"
            className="rounded-xl px-2 py-1 text-xs font-semibold text-amber-800 transition hover:bg-amber-100 disabled:opacity-50 dark:text-amber-200 dark:hover:bg-amber-500/20"
          >
            Leva
          </button>
        </div>
      ) : null}
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (next) {
          // Abrir o sino é um gesto do usuário — destrava o áudio e pede permissão
          // de notificação do navegador (DC-279), se ainda não decididas.
          unlockSpotAudio();
          void ensureNotificationPermission();
          // Marca como vistas depois de 800ms (usuário viu).
          if (unseen > 0) setTimeout(() => markAllMut.mutate(), 800);
        }
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Notificações"
          className="admin-card-surface relative flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border shadow-[0_12px_28px_-20px_rgba(2,36,131,0.28)] backdrop-blur-xl transition hover:bg-muted/40"
        >
          <Bell className="h-4 w-4 text-muted-foreground" />
          {unseen > 0 ? (
            <span className="absolute -right-1 -top-1 flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white shadow">
              {unseen > 99 ? "99+" : unseen}
            </span>
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 max-w-[92vw] p-0">
        <div className="flex items-center justify-between border-b border-border/60 px-4 py-3">
          <p className="text-sm font-semibold">Notificações</p>
          {items.length ? (
            <div className="flex items-center gap-1">
              <Button
                size="sm"
                variant="ghost"
                className="h-7 gap-1 text-xs"
                onClick={() => markAllMut.mutate()}
                disabled={markAllMut.isPending || unseen === 0}
              >
                <CheckCheck className="h-3.5 w-3.5" /> Marcar todas
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 gap-1 text-xs text-red-600 hover:text-red-700"
                onClick={() => {
                  if (confirm("Limpar todas as notificações? Essa ação não pode ser desfeita.")) {
                    clearAllMut.mutate();
                  }
                }}
                disabled={clearAllMut.isPending}
              >
                <Trash2 className="h-3.5 w-3.5" /> Limpar todas
              </Button>
            </div>
          ) : null}
        </div>
        <div className="max-h-[70vh] overflow-y-auto">
          {items.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">Nenhuma notificação por enquanto.</p>
          ) : (
            <ul className="divide-y divide-border/60">
              {items.map((n) => {
                // DC-279/DC-299: notificações clicáveis levam o operador ao contexto —
                // spot → Programação (?lh=); novo motorista → Fila (?carga=).
                const isQueue = n.kind === "new_queue_driver";
                // Avisos de ASPX levam à tela de Cargas (a carga marcada vive lá).
                // `spx_acceptance_mass_hide` NÃO entra aqui de propósito (e o prefixo
                // "aspx_" não o pega): é um aviso agregado, sem LH, e o lugar de conferir
                // é o portal SPX — fora do sistema. Levar a /cargas sem filtro seria
                // prometer um destino que não responde a pergunta do operador.
                const isAspx = n.kind.startsWith("aspx_");
                const clickable = n.kind === "new_spot" || isQueue || isAspx;
                const openRow = () => {
                  if (isAspx) {
                    setOpen(false);
                    navigate(cargasHref(n.metadata as Record<string, unknown> | undefined));
                    return;
                  }
                  if (isQueue) {
                    setOpen(false);
                    const cid = (n.metadata as Record<string, unknown> | undefined)?.carga_id;
                    navigate(typeof cid === "string" && cid ? `/leads?carga=${encodeURIComponent(cid)}` : "/leads");
                    return;
                  }
                  goToSpot(n.metadata);
                };
                return (
                  <li
                    key={n.id}
                    className={cn(
                      "relative flex items-start gap-3 px-4 py-3",
                      !n.seen && "bg-primary/5",
                      clickable && "cursor-pointer transition-colors hover:bg-primary/10",
                    )}
                    {...(clickable
                      ? {
                          role: "button",
                          tabIndex: 0,
                          onClick: openRow,
                          onKeyDown: (e: React.KeyboardEvent) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              openRow();
                            }
                          },
                        }
                      : {})}
                  >
                    <span className={cn("mt-1 h-2.5 w-2.5 shrink-0 rounded-full", KIND_TINT[n.kind] ?? "bg-slate-400")} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <p className="truncate text-sm font-medium text-foreground">{n.title}</p>
                        <span className="shrink-0 text-[10px] text-muted-foreground">{fmtRelative(n.created_at)}</span>
                      </div>
                      {n.body ? <p className="mt-0.5 truncate text-xs text-muted-foreground">{n.body}</p> : null}
                      <p className="mt-0.5 text-[10px] uppercase tracking-wide text-muted-foreground/80">
                        {KIND_LABEL[n.kind] ?? n.kind}
                      </p>
                      {clickable ? (
                        <p className="mt-1 text-[11px] font-semibold text-primary">
                          {isAspx ? "Abrir em Cargas" : isQueue ? "Abrir na Fila" : "Abrir na Programação"} &rarr;
                        </p>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </PopoverContent>
      </Popover>
    </div>
  );
}
