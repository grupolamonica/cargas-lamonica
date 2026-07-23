import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Bell, CheckCheck, Trash2 } from "lucide-react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ensureNotificationPermission, playSpotBeep, showDesktopNotification, unlockSpotAudio } from "@/lib/spotAlert";
import {
  clearOperatorNotifications,
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

export default function NotificationsBell() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const { data } = useQuery({
    queryKey: NOTIFICATIONS_KEY,
    queryFn: fetchOperatorNotifications,
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  const items = useMemo<OperatorNotification[]>(() => data?.items ?? [], [data?.items]);
  const unseen = data?.unseenCount ?? 0;

  const goToSpot = (metadata: OperatorNotification["metadata"]) => {
    setOpen(false);
    navigate(spotHref(metadata));
  };

  // DC-279: som + notificação do navegador quando chega uma nova carga spot. Só
  // roda depois que a query trouxe dados (senão a 1ª leva real seria tratada como
  // "nova" e tocaria o histórico inteiro — review #11). A 1ª leva COM dados só
  // registra os IDs (sem alertar); levas seguintes (polling 30s) alertam 1x cada.
  const alertedSpotIdsRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!data) return;
    const spots = items.filter((n) => n.kind === "new_spot");
    if (alertedSpotIdsRef.current === null) {
      alertedSpotIdsRef.current = new Set(spots.map((n) => n.id));
      return;
    }
    const already = alertedSpotIdsRef.current;
    const fresh = spots.filter((n) => !already.has(n.id) && !n.seen);
    if (fresh.length === 0) return;
    fresh.forEach((n) => already.add(n.id));

    playSpotBeep();
    const first = fresh[0];
    const openSpot = () => navigate(spotHref(first.metadata));
    const title = fresh.length === 1 ? first.title : `${fresh.length} novas cargas spot disponíveis`;
    const body = fresh.length === 1 ? first.body : "Clique para ver e aceitar na Programação";
    showDesktopNotification({ title, body, tag: first.id, onClick: openSpot });
    toast.info(title, {
      description: fresh.length === 1 ? first.body : undefined,
      duration: 12_000,
      action: { label: "Ver na Programação", onClick: openSpot },
    });
  }, [data, items, navigate]);

  const markAllMut = useMutation({
    mutationFn: () => markOperatorNotificationsSeen({ all: true }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_KEY }),
  });
  const clearAllMut = useMutation({
    mutationFn: () => clearOperatorNotifications({ all: true }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_KEY }),
  });

  return (
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
                // DC-279: a notificação de spot é clicável e leva o operador à
                // Programação (no spot, via ?lh=) para aceitar pelo fluxo normal.
                const clickable = n.kind === "new_spot";
                const openRow = () => goToSpot(n.metadata);
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
                        <p className="mt-1 text-[11px] font-semibold text-primary">Abrir na Programação &rarr;</p>
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
  );
}
