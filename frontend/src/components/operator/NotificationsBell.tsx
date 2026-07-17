import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, CheckCheck, Trash2 } from "lucide-react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  clearOperatorNotifications,
  fetchOperatorNotifications,
  markOperatorNotificationsSeen,
  type OperatorNotification,
} from "@/services/readModels";

const NOTIFICATIONS_KEY = ["operator", "notifications"];

const KIND_LABEL: Record<string, string> = {
  reservation_timeout: "Reserva expirou",
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
};

const KIND_TINT: Record<string, string> = {
  reservation_timeout: "bg-amber-500",
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

export default function NotificationsBell() {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: NOTIFICATIONS_KEY,
    queryFn: fetchOperatorNotifications,
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  const items = useMemo<OperatorNotification[]>(() => data?.items ?? [], [data?.items]);
  const unseen = data?.unseenCount ?? 0;

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
      onOpenChange={(open) => {
        // Ao ABRIR o popover, marca como vistas depois de 800ms (usuário viu).
        if (open && unseen > 0) {
          setTimeout(() => markAllMut.mutate(), 800);
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
              {items.map((n) => (
                <li key={n.id} className={cn("relative flex items-start gap-3 px-4 py-3", !n.seen && "bg-primary/5")}>
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
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
