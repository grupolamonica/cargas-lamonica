import { Activity, AlertCircle, ArrowRight, BellRing, CheckCircle2 } from "lucide-react";
import { Link } from "react-router-dom";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatShortDateTime } from "@/lib/dateDisplay";
import { buildCargoPublicPath } from "@/lib/cargoLinks";
import { cn } from "@/lib/utils";
import { type DriverLeadNotification } from "@/lib/driverLeadNotifications";

interface DriverClaimWorkflowProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  notifications: DriverLeadNotification[];
  notificationCount: number;
  onDismissNotification: (notification: DriverLeadNotification) => void;
}

export function DriverClaimWorkflow({
  isOpen,
  onOpenChange,
  notifications,
  notificationCount,
  onDismissNotification,
}: DriverClaimWorkflowProps) {
  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent
        overlayClassName="bg-[hsl(223_56%_10%/0.76)] backdrop-blur-[2px]"
        className="driver-theme left-0 right-0 top-auto bottom-0 max-h-[86vh] w-full translate-x-0 translate-y-0 gap-0 overflow-hidden rounded-t-[28px] rounded-b-none border-x-0 border-b-0 bg-[linear-gradient(180deg,hsl(0_0%_100%),hsl(220_33%_98%))] p-0 data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom sm:left-[50%] sm:right-auto sm:top-[50%] sm:bottom-auto sm:max-h-[82vh] sm:w-[min(100%-2rem,54rem)] sm:max-w-[54rem] sm:translate-x-[-50%] sm:translate-y-[-50%] sm:rounded-[30px] sm:border"
      >
        <DialogHeader className="border-b border-border/50 px-4 pb-4 pt-5 text-left sm:px-5 sm:pb-5 sm:pt-5">
          <div className="flex items-start gap-3 pr-10">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary shadow-[0_14px_30px_-22px_hsl(224_94%_37%/0.7)]">
              <BellRing className="h-4.5 w-4.5" />
            </div>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-primary/60 sm:text-[11px]">
                Atualizações das suas candidaturas
              </p>
              <DialogTitle className="mt-1 text-lg font-bold tracking-tight text-foreground sm:text-xl">
                Central de notificações do motorista
              </DialogTitle>
              <DialogDescription className="mt-1 text-sm leading-relaxed text-muted-foreground">
                Aqui ficam guardadas as cargas em que você já se candidatou e também os retornos enviados pela equipe.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="max-h-[calc(86vh-7.5rem)] overflow-y-auto px-3 py-3 sm:max-h-[calc(82vh-8.5rem)] sm:px-4 sm:py-4">
          {notificationCount ? (
            <div className="grid gap-3">
              {notifications.map((notification) => {
                const routeLabel = `${notification.origem} -> ${notification.destino}`;
                const happenedAtLabel = formatShortDateTime(notification.happenedAt, "Agora");

                return (
                  <article
                    key={notification.id}
                    className={cn(
                      "rounded-[22px] border p-3.5 shadow-[0_18px_34px_-28px_hsl(223_56%_12%/0.22)] sm:rounded-[26px] sm:p-4",
                      notification.kind === "APPROVED"
                        ? "border-emerald-200 bg-[linear-gradient(135deg,hsl(145_77%_95%),hsl(148_46%_90%))]"
                        : notification.kind === "ALLOCATED_TO_OTHER_DRIVER"
                          ? "border-amber-200 bg-amber-50"
                          : "border-primary/20 bg-[linear-gradient(135deg,hsl(224_84%_97%),hsl(223_68%_93%))]",
                    )}
                  >
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
                      <div
                        className={cn(
                          "flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl sm:mt-0.5 sm:h-10 sm:w-10",
                          notification.kind === "APPROVED"
                            ? "bg-emerald-100 text-emerald-700"
                            : notification.kind === "ALLOCATED_TO_OTHER_DRIVER"
                              ? "bg-amber-100 text-amber-700"
                              : "bg-primary/12 text-primary",
                        )}
                      >
                        {notification.kind === "APPROVED" ? (
                          <CheckCircle2 className="h-4.5 w-4.5 sm:h-5 sm:w-5" />
                        ) : notification.kind === "ALLOCATED_TO_OTHER_DRIVER" ? (
                          <AlertCircle className="h-4.5 w-4.5 sm:h-5 sm:w-5" />
                        ) : (
                          <Activity className="h-4.5 w-4.5 sm:h-5 sm:w-5" />
                        )}
                      </div>

                      <div className="min-w-0 flex-1">
                        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
                          <p className="text-sm font-semibold text-foreground sm:text-base">{notification.title}</p>
                          <span className="max-w-full rounded-full bg-white/72 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                            {routeLabel}
                          </span>
                        </div>
                        <p className="mt-2 text-[13px] leading-6 text-muted-foreground sm:text-sm sm:leading-relaxed">
                          {notification.message}
                        </p>
                        <p className="mt-2 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                          Atualizado em {happenedAtLabel}
                        </p>
                        <div className="mt-3 flex flex-col gap-2 sm:mt-4 sm:flex-row sm:flex-wrap sm:items-center">
                          <Link
                            to={buildCargoPublicPath(notification.loadId)}
                            className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 sm:w-auto"
                            onClick={() => onOpenChange(false)}
                          >
                            {notification.kind === "PRE_REGISTERED"
                              ? "Abrir carga"
                              : notification.kind === "QUEUED"
                                ? "Acompanhar candidatura"
                                : "Abrir carga"}
                            <ArrowRight className="h-4 w-4" />
                          </Link>
                          <button
                            type="button"
                            onClick={() => onDismissNotification(notification)}
                            className="inline-flex w-full items-center justify-center gap-2 rounded-full border border-border/70 bg-white/85 px-4 py-2.5 text-sm font-semibold text-muted-foreground transition-colors hover:bg-white hover:text-foreground sm:w-auto"
                          >
                            Remover da central
                          </button>
                        </div>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="flex min-h-[240px] flex-col items-center justify-center gap-4 rounded-[24px] border border-border/60 bg-white/82 px-6 py-10 text-center shadow-[0_18px_34px_-28px_hsl(223_56%_12%/0.18)]">
              <div className="flex h-14 w-14 items-center justify-center rounded-[20px] bg-primary/10 text-primary">
                <BellRing className="h-6 w-6" />
              </div>
              <div>
                <p className="text-lg font-bold text-foreground">Nenhuma notificação salva</p>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  Quando você enviar uma candidatura ou receber retorno da equipe, tudo vai aparecer aqui automaticamente.
                </p>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
