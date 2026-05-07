import { memo, useState, useCallback } from "react";
import type { LucideIcon } from "lucide-react";
import { ArrowRight, Navigation, Share2, ShieldCheck, Truck } from "lucide-react";
import { Link } from "react-router-dom";
import { toast } from "sonner";

import ClientLogo from "@/components/ClientLogo";
import DriverClaimPanel from "@/components/driver/DriverClaimPanel";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

interface LoadCardProps {
  id: string;
  loadId?: string;
  dateTime: string;
  clienteNome?: string | null;
  clienteDescricao?: string | null;
  origemCidade: string;
  origemEstado: string;
  destinoCidade: string;
  destinoEstado: string;
  tipoVeiculo: string;
  secondaryValue: string;
  secondarySupportText?: string;
  pagamento: string;
  paymentDetails?: string | null;
  clienteId?: string | null;
  valorCarga?: number | null;
  bonusValor?: number | null;
  detailsHref?: string;
  interestHref?: string;
  carregamentoLabel?: string | null;
  descargaLabel?: string | null;
  routeDistanceLabel?: string;
  routeDurationLabel?: string;
  index?: number;
  secondaryLabel?: string;
  SecondaryIcon?: LucideIcon;
  clienteLogoUrlCard?: string | null;
  onInterestDialogOpenChange?: (isOpen: boolean) => void;
}

const LoadCard = memo(({
  loadId,
  dateTime,
  clienteNome,
  origemCidade,
  origemEstado,
  destinoCidade,
  destinoEstado,
  tipoVeiculo,
  secondaryValue,
  secondarySupportText,
  pagamento,
  paymentDetails,
  clienteId,
  valorCarga,
  bonusValor,
  detailsHref,
  carregamentoLabel,
  descargaLabel,
  routeDistanceLabel,
  routeDurationLabel,
  index = 0,
  secondaryLabel = "Percurso recomendado",
  SecondaryIcon = Navigation,
  clienteLogoUrlCard,
  onInterestDialogOpenChange,
}: LoadCardProps) => {
  const originLabel = origemEstado ? `${origemCidade}, ${origemEstado}` : origemCidade;
  const destinationLabel = destinoEstado ? `${destinoCidade}, ${destinoEstado}` : destinoCidade;
  const topRightLabel = clienteNome || "Cliente não informado";
  const loadingLabel = carregamentoLabel?.trim() || "A confirmar";
  const unloadingLabel = descargaLabel?.trim() || "A confirmar";
  const kmLabel = routeDistanceLabel || "A confirmar";
  const routeDurationValue = routeDurationLabel?.replace(/^Tempo estimado:\s*/i, "").trim() || null;
  const clientHref = clienteId ? `/motorista/cliente/${clienteId}` : null;
  const clientLogoUrl = clienteLogoUrlCard ?? null;
  const [isInterestDialogOpen, setIsInterestDialogOpen] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);
  const shareUrl = detailsHref ? `${window.location.origin}${detailsHref}` : null;

  const handleShare = useCallback(async () => {
    if (!shareUrl) return;

    const fmtBRL = (v: number) =>
      new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(v);

    const hasValor = typeof valorCarga === "number" && Number.isFinite(valorCarga);
    const hasBonus = typeof bonusValor === "number" && Number.isFinite(bonusValor) && bonusValor > 0;
    const hasBreakdown = hasValor || hasBonus;

    const lines: string[] = ["🚚 *CARGA DISPONÍVEL*", ""];
    lines.push(`🚛 Veículo: ${tipoVeiculo}`);
    const nomeCliente = clienteNome?.trim();
    if (nomeCliente) lines.push(`🏢 Cliente: ${nomeCliente}`);
    lines.push("", `📍 Coleta: ${originLabel}`);
    if (loadingLabel !== "A confirmar") lines.push(`📅 Carregamento: ${loadingLabel}`);
    lines.push("", `🏁 Entrega: ${destinationLabel}`);
    if (unloadingLabel !== "A confirmar") lines.push(`📅 Descarga: ${unloadingLabel}`);
    const routeParts: string[] = [];
    if (kmLabel !== "A confirmar") routeParts.push(kmLabel);
    if (routeDurationValue) routeParts.push(routeDurationValue);
    if (routeParts.length > 0) lines.push("", `🛣️ Percurso: ${routeParts.join(" | ")}`);
    lines.push("");
    if (hasBreakdown) {
      lines.push("💰 Pagamento");
      if (hasValor) lines.push(`• Frete: ${fmtBRL(valorCarga!)}`);
      if (hasBonus) lines.push(`• Bônus: ${fmtBRL(bonusValor!)}`);
      lines.push(`• Total: ${pagamento}`);
    } else {
      lines.push(`💰 Total: ${pagamento}`);
    }
    lines.push("", "🔗 Detalhes e candidatura:", shareUrl);
    const shareText = lines.join("\n");

    // ── Share ──
    if (navigator.share) {
      try { await navigator.share({ text: shareText }); } catch { /* user cancelled */ }
    } else {
      // No Web Share API — use WhatsApp URL scheme (works on mobile + desktop WhatsApp Web)
      const waUrl = `https://wa.me/?text=${encodeURIComponent(shareText)}`;
      // Best-effort clipboard copy
      try { await navigator.clipboard.writeText(shareText); } catch { /* ignore */ }
      const opened = window.open(waUrl, "_blank");
      if (opened) {
        setShareCopied(true);
        toast.success("WhatsApp aberto! Escolha o contato e envie.");
        setTimeout(() => setShareCopied(false), 3000);
      } else {
        // Popup blocked — last resort: clipboard-only
        try {
          await navigator.clipboard.writeText(shareText);
          setShareCopied(true);
          toast.success("Copiado! Cole no WhatsApp.");
          setTimeout(() => setShareCopied(false), 2000);
        } catch {
          toast.error("Não foi possível abrir o WhatsApp. Tente no navegador Chrome.");
        }
      }
    }
  }, [shareUrl, originLabel, destinationLabel, tipoVeiculo, pagamento, clienteNome, valorCarga, bonusValor, loadingLabel, unloadingLabel, kmLabel, routeDurationValue, paymentDetails]);

  const hasInterestDialog = Boolean(loadId);
  const hasDetailsAction = Boolean(detailsHref);
  const actionCount = Number(hasInterestDialog) + Number(hasDetailsAction);
  const actionGridClassName = cn("grid gap-2", actionCount > 1 ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-1");
  const handleInterestDialogOpenChange = (nextOpen: boolean) => {
    setIsInterestDialogOpen(nextOpen);
    onInterestDialogOpenChange?.(nextOpen);
  };

  const renderInterestDialogTrigger = (buttonClassName: string) => {
    if (!loadId) {
      return null;
    }

    return (
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="cta"
          size="lg"
          className={buttonClassName}
        >
          <span>Candidatar-se</span>
          <ShieldCheck className="h-4 w-4 transition-transform duration-300 group-hover/btn:translate-x-1" />
        </Button>
      </DialogTrigger>
    );
  };

  return (
    <Dialog open={isInterestDialogOpen} onOpenChange={handleInterestDialogOpenChange}>
      <div
        className="group relative rounded-2xl border border-border/50 bg-card p-4 opacity-0 transition-shadow duration-300 ease-out premium-shadow hover:-translate-y-1 hover:transform-gpu hover:premium-shadow-hover sm:rounded-3xl sm:p-6 lg:rounded-[28px] lg:p-5 animate-fade-in-up"
        style={{
          animationDelay: `${index * 80}ms`,
          contentVisibility: "auto",
          containIntrinsicSize: "420px",
          contain: "layout paint style",
        }}
      >
      <div className="pointer-events-none absolute inset-0 rounded-2xl bg-gradient-to-br from-primary/[0.02] to-accent/[0.02] opacity-0 transition-opacity duration-500 group-hover:opacity-100 sm:rounded-3xl" />
      <div className="pointer-events-none absolute inset-x-8 top-0 hidden h-px bg-gradient-to-r from-transparent via-primary/25 to-transparent lg:block" />
      <div className="pointer-events-none absolute -right-8 top-8 hidden h-28 w-28 rounded-full bg-primary/8 blur-3xl lg:block" />

      <div className="relative mb-3 flex items-center sm:mb-5 lg:hidden">
        <span className="inline-flex items-center gap-1.5 rounded-lg bg-badge px-2.5 py-1 text-[11px] font-bold tracking-wide text-badge-text sm:gap-2 sm:rounded-xl sm:px-3.5 sm:py-1.5 sm:text-xs">
          <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse-glow" />
          {dateTime}
        </span>
        {clientLogoUrl ? (
          clientHref ? (
            <Link to={clientHref} aria-label={`Ver dados de ${topRightLabel}`} className="absolute right-0 top-[45%] -translate-y-1/2">
              <ClientLogo name={topRightLabel} logoUrl={clientLogoUrl} noBg className="h-12 w-[84px] rounded-none border-0 shadow-none" imageClassName="p-0" />
            </Link>
          ) : (
            <ClientLogo name={topRightLabel} logoUrl={clientLogoUrl} className="absolute right-0 top-[45%] -translate-y-1/2 h-12 w-[84px] rounded-none border-0 shadow-none bg-transparent" imageClassName="p-0" />
          )
        ) : clientHref ? (
          <Link
            to={clientHref}
            title={`Ver dados de ${topRightLabel}`}
            aria-label={`Abrir dados de ${topRightLabel}`}
            className="inline-flex max-w-[132px] flex-col items-end gap-0.5 rounded-lg bg-muted/40 px-2.5 py-1 text-[10px] font-semibold text-muted-foreground/80 transition-colors duration-200 hover:bg-primary/10 hover:text-primary sm:max-w-[180px] sm:bg-muted/50 sm:px-3 sm:text-[11px]"
          >
            <span className="flex max-w-full items-center gap-1">
              <span className="min-w-0 truncate">{topRightLabel}</span>
              <ArrowRight className="h-3 w-3 shrink-0" />
            </span>
          </Link>
        ) : (
          <span className="inline-flex max-w-[132px] flex-col items-end gap-0.5 rounded-lg bg-muted/40 px-2.5 py-1 text-[10px] font-semibold text-muted-foreground/80 sm:max-w-[180px] sm:bg-muted/50 sm:px-3 sm:text-[11px]">
            <span className="block max-w-full truncate">{topRightLabel}</span>
          </span>
        )}
      </div>

      <div className="relative mb-4 rounded-2xl border border-border/40 bg-muted/25 p-3 sm:hidden">
        <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.15em] text-muted-foreground">
          Trecho
        </p>
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <span className="block truncate text-sm font-extrabold tracking-tight text-card-foreground">
              {originLabel}
            </span>
            <p className="mt-0.5 text-[0.72rem] font-semibold tracking-[0.02em] text-primary/80">
              {loadingLabel}
            </p>
          </div>
          <ArrowRight className="h-4 w-4 shrink-0 text-primary" />
          <div className="min-w-0 flex-1 text-right">
            <span className="block truncate text-sm font-extrabold tracking-tight text-card-foreground">
              {destinationLabel}
            </span>
            <p className="mt-0.5 text-[0.72rem] font-semibold tracking-[0.02em] text-accent/80">
              {unloadingLabel}
            </p>
          </div>
        </div>
      </div>

      <div className="relative mb-4 hidden gap-3 sm:mb-5 sm:flex sm:gap-5 lg:hidden">
        <div className="flex flex-col items-center pb-0.5 pt-1.5">
          <div className="h-3.5 w-3.5 rounded-full border-[2.5px] border-primary bg-card shadow-sm ring-4 ring-primary/10 sm:h-4 sm:w-4" />
          <div className="my-1 w-[2px] flex-1 rounded-full bg-gradient-to-b from-primary/40 via-primary/20 to-accent/40 sm:my-1.5" />
          <div className="h-3.5 w-3.5 rounded-full bg-accent shadow-sm ring-4 ring-accent/10 sm:h-4 sm:w-4" />
        </div>

        <div className="flex-1 space-y-3 sm:space-y-4">
          <div className="space-y-0.5">
            <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-muted-foreground">
              Coleta
            </p>
            <p className="text-sm font-extrabold tracking-tight text-card-foreground sm:text-base">
              {origemCidade}
              {origemEstado ? (
                <>
                  {", "}
                  <span className="font-extrabold text-primary">{origemEstado}</span>
                </>
              ) : null}
            </p>
          </div>
          <div className="space-y-0.5">
            <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-muted-foreground">
              Entrega
            </p>
            <p className="text-sm font-extrabold tracking-tight text-card-foreground sm:text-base">
              {destinoCidade}
              {destinoEstado ? (
                <>
                  {", "}
                  <span className="font-extrabold text-accent">{destinoEstado}</span>
                </>
              ) : null}
            </p>
          </div>
        </div>
      </div>

      <div className="mb-4 space-y-2 sm:hidden">
        <div className="rounded-2xl border border-border/30 bg-muted/40 p-3">
          <div className="mb-1 flex items-center gap-2">
            <div className="flex h-6 w-6 items-center justify-center rounded-lg bg-primary/10">
              <span className="h-2 w-2 rounded-full bg-primary" />
            </div>
            <span className="text-[10px] font-bold uppercase tracking-[0.15em] text-muted-foreground">
              Pagamento
            </span>
          </div>
          <p className="text-lg font-extrabold tracking-tight text-gradient-primary">{pagamento}</p>
          {paymentDetails ? (
            <p className="mt-1 text-[0.68rem] font-medium leading-relaxed text-muted-foreground/85">
              {paymentDetails}
            </p>
          ) : null}
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-xl border border-border/30 bg-muted/40 p-2.5">
            <div className="mb-1 flex items-center gap-1.5">
              <div className="flex h-5 w-5 items-center justify-center rounded-md bg-primary/10">
                <Truck className="h-3 w-3 text-primary" />
              </div>
              <span className="text-[9px] font-bold uppercase tracking-[0.15em] text-muted-foreground">
                Veículo
              </span>
            </div>
            <p className="text-xs font-extrabold text-card-foreground">{tipoVeiculo}</p>
          </div>

          <div className="rounded-xl border border-border/30 bg-muted/40 p-2.5">
            <div className="mb-1 flex items-center gap-1.5">
              <div className="flex h-5 w-5 items-center justify-center rounded-md bg-primary/10">
                <SecondaryIcon className="h-3 w-3 text-primary" />
              </div>
              <span className="text-[9px] font-bold uppercase tracking-[0.15em] text-muted-foreground">
                {secondaryLabel}
              </span>
            </div>
            <p className="text-xs font-extrabold text-card-foreground">{secondaryValue}</p>
            {secondarySupportText ? (
              <p className="mt-0.5 truncate text-[0.62rem] font-medium leading-tight text-muted-foreground/80">
                {secondarySupportText}
              </p>
            ) : null}
          </div>
        </div>
      </div>

      <div className="mb-4 hidden gap-2 sm:mb-5 sm:flex sm:gap-3 lg:hidden">
        <div className="flex-1 rounded-xl border border-border/30 bg-muted/40 p-2.5 transition-colors duration-200 group-hover:bg-muted/60 sm:rounded-2xl sm:p-3.5">
          <div className="mb-1 flex items-center gap-1.5 sm:mb-1.5 sm:gap-2">
            <div className="flex h-5 w-5 items-center justify-center rounded-md bg-primary/10 sm:h-6 sm:w-6 sm:rounded-lg">
              <Truck className="h-3 w-3 text-primary sm:h-3.5 sm:w-3.5" />
            </div>
            <span className="text-[9px] font-bold uppercase tracking-[0.15em] text-muted-foreground sm:text-[10px]">
              Veículo
            </span>
          </div>
          <p className="text-xs font-extrabold text-card-foreground sm:text-sm">{tipoVeiculo}</p>
        </div>
        <div className="flex-1 rounded-xl border border-border/30 bg-muted/40 p-2.5 transition-colors duration-200 group-hover:bg-muted/60 sm:rounded-2xl sm:p-3.5">
          <div className="mb-1 flex items-center gap-1.5 sm:mb-1.5 sm:gap-2">
            <div className="flex h-5 w-5 items-center justify-center rounded-md bg-primary/10 sm:h-6 sm:w-6 sm:rounded-lg">
              <SecondaryIcon className="h-3 w-3 text-primary sm:h-3.5 sm:w-3.5" />
            </div>
            <span className="text-[9px] font-bold uppercase tracking-[0.15em] text-muted-foreground sm:text-[10px]">
              {secondaryLabel}
            </span>
          </div>
          <p className="text-xs font-extrabold text-card-foreground sm:text-sm">{secondaryValue}</p>
          {secondarySupportText ? (
            <p className="mt-1 truncate text-[0.68rem] font-medium leading-tight text-muted-foreground/80 sm:text-[0.7rem]">
              {secondarySupportText}
            </p>
          ) : null}
        </div>
      </div>

      <div className="hidden lg:block">
        <div className="relative flex items-center gap-4">
          <span className="inline-flex items-center gap-1.5 rounded-lg bg-badge px-3 py-1.5 text-[11px] font-semibold tracking-wide text-badge-text">
            <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse-glow" />
            {dateTime}
          </span>
          {clientLogoUrl ? (
            clientHref ? (
              <Link to={clientHref} aria-label={`Ver dados de ${topRightLabel}`} className="absolute right-0 top-[45%] -translate-y-1/2">
                <ClientLogo name={topRightLabel} logoUrl={clientLogoUrl} noBg className="h-12 w-[84px] rounded-none border-0 shadow-none" imageClassName="p-0" />
              </Link>
            ) : (
              <ClientLogo name={topRightLabel} logoUrl={clientLogoUrl} className="absolute right-0 top-[45%] -translate-y-1/2 h-12 w-[84px] rounded-none border-0 shadow-none bg-transparent" imageClassName="p-0" />
            )
          ) : clientHref ? (
            <Link
              to={clientHref}
              title={`Ver dados de ${topRightLabel}`}
              aria-label={`Abrir dados de ${topRightLabel}`}
              className="inline-flex max-w-[220px] flex-col items-end gap-0.5 rounded-xl bg-muted/45 px-3 py-1.5 text-[0.95rem] font-medium text-muted-foreground/85 transition-colors duration-200 hover:bg-primary/10 hover:text-primary"
            >
              <span className="flex max-w-full items-center gap-1">
                <span className="min-w-0 truncate">{topRightLabel}</span>
                <ArrowRight className="h-3.5 w-3.5 shrink-0" />
              </span>
            </Link>
          ) : (
            <span className="inline-flex max-w-[220px] flex-col items-end gap-0.5 rounded-xl bg-muted/45 px-3 py-1.5 text-[0.95rem] font-medium text-muted-foreground/85">
              <span className="block max-w-full truncate">{topRightLabel}</span>
            </span>
          )}
        </div>

        <div className="mt-6 grid grid-cols-[18px_minmax(0,1fr)_156px] items-center gap-5">
          <div className="flex flex-col items-center pt-1">
            <span className="h-3 w-3 rounded-full border-[2.5px] border-primary bg-card shadow-sm" />
            <span className="my-1 h-16 w-px rounded-full bg-gradient-to-b from-primary/35 via-primary/16 to-accent/35" />
            <span className="h-3 w-3 rounded-full bg-accent shadow-sm" />
          </div>

          <div className="space-y-5">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground/80">
                Coleta
              </p>
              <p className="mt-1 text-[1.15rem] font-bold tracking-tight text-card-foreground">
                {originLabel}
              </p>
              <p className="mt-1 text-[0.76rem] font-semibold tracking-[0.02em] text-primary/80">
                {loadingLabel}
              </p>
            </div>

            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground/80">
                Entrega
              </p>
              <p className="mt-1 text-[1.15rem] font-bold tracking-tight text-card-foreground">
                {destinationLabel}
              </p>
              <p className="mt-1 text-[0.76rem] font-semibold tracking-[0.02em] text-accent/80">
                {unloadingLabel}
              </p>
            </div>
          </div>

          <div className="admin-accent-tint self-center rounded-[22px] border border-primary/10 px-4 py-4 shadow-[0_18px_34px_-26px_hsl(224_94%_37%/0.3)]">
            <div className="flex items-center gap-2 text-primary">
              <span className="flex h-8 w-8 items-center justify-center rounded-2xl bg-primary/10">
                <Navigation className="h-4 w-4" />
              </span>
            </div>
            <p className="mt-3 text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground/80">
              Percurso recomendado
            </p>
            <p className="mt-2 text-[0.98rem] font-bold tracking-tight text-card-foreground">
              {kmLabel}
            </p>
            {routeDurationValue ? (
              <div className="mt-2 space-y-0.5">
                <p className="text-[0.62rem] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70">
                  Tempo estimado
                </p>
                <p className="text-[0.82rem] font-semibold leading-tight text-muted-foreground/85">
                  {routeDurationValue}
                </p>
              </div>
            ) : (
              <p className="mt-2 text-[0.76rem] font-medium tracking-[0.02em] text-muted-foreground/80">
                Distância e tempo da rota sugerida
              </p>
            )}
          </div>
        </div>

        <div className="mt-7 grid grid-cols-[minmax(0,1fr)_200px] gap-4 border-t border-border/50 pt-5">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground/80">
              Pagamento total
            </p>
            <p className="mt-2 text-[1.7rem] font-bold tracking-tight text-gradient-primary">
              {pagamento}
            </p>
            {paymentDetails ? (
              <p className="mt-2 max-w-[28rem] text-[0.78rem] font-medium leading-relaxed text-muted-foreground/82">
                {paymentDetails}
              </p>
            ) : null}
          </div>

          <div className="admin-card-surface rounded-[22px] border border-border/50 px-4 py-4 text-right">
            <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground/80">
              Veículo
            </p>
            <p className="mt-2 text-[1.02rem] font-bold tracking-tight text-card-foreground">
              {tipoVeiculo}
            </p>
          </div>
        </div>

        <div className="mt-6">
          <div className={actionGridClassName}>
            {renderInterestDialogTrigger("group/btn h-12 w-full rounded-full px-6")}
            {detailsHref ? (
              <Button
                asChild
                variant="outline"
                size="lg"
                className="group/btn h-12 w-full rounded-full border-primary/30 px-6 text-primary hover:border-primary/50 hover:bg-primary/[0.06]"
              >
                <Link to={detailsHref}>
                  <span>Detalhes</span>
                  <ArrowRight className="h-4 w-4 transition-transform duration-300 group-hover/btn:translate-x-1" />
                </Link>
              </Button>
            ) : null}
          </div>
          {shareUrl ? (
            <div className="mt-3 flex justify-end">
              <button
                type="button"
                onClick={handleShare}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground/60 transition-colors hover:text-muted-foreground"
              >
                <Share2 className="h-3.5 w-3.5" />
                {shareCopied ? "Copiado!" : "Compartilhar carga"}
              </button>
            </div>
          ) : null}
        </div>
      </div>

      <div className="relative flex flex-col gap-3 border-t border-border/40 pt-4 sm:flex-row sm:items-center sm:justify-between sm:gap-0 sm:pt-5 lg:hidden">
        <div className="sm:hidden">
          <div className={actionGridClassName}>
            {renderInterestDialogTrigger("group/btn w-full rounded-xl px-5")}
            {detailsHref ? (
              <Button
                asChild
                variant="outline"
                size="lg"
                className="group/btn w-full rounded-xl border-primary/30 px-5 text-primary hover:border-primary/50 hover:bg-primary/[0.06]"
              >
                <Link to={detailsHref}>
                  <span>Detalhes</span>
                  <ArrowRight className="h-4 w-4 transition-transform duration-300 group-hover/btn:translate-x-1" />
                </Link>
              </Button>
            ) : null}
          </div>
          {shareUrl ? (
            <button
              type="button"
              onClick={handleShare}
              className="mt-2.5 flex w-full items-center justify-center gap-2 rounded-xl border border-border/60 bg-muted/30 py-2.5 text-sm font-semibold text-muted-foreground transition-colors hover:border-border hover:bg-muted/60 hover:text-foreground active:scale-[0.98]"
            >
              <Share2 className="h-4 w-4" />
              {shareCopied ? "Link copiado!" : "Compartilhar carga"}
            </button>
          ) : null}
        </div>

        <div className="hidden sm:block lg:hidden">
          <p className="mb-1 text-[10px] font-bold uppercase tracking-[0.15em] text-muted-foreground">
            Pagamento
          </p>
          <p className="hidden text-xl font-extrabold tracking-tight text-gradient-primary sm:block sm:text-2xl lg:hidden">
            {pagamento}
          </p>
          {paymentDetails ? (
            <p className="mt-1 max-w-xs text-[0.72rem] font-medium leading-relaxed text-muted-foreground/82">
              {paymentDetails}
            </p>
          ) : null}
        </div>
        <div className="hidden items-center gap-2 sm:flex lg:hidden">
          {renderInterestDialogTrigger("group/btn sm:w-auto sm:rounded-2xl sm:px-7")}
          {detailsHref ? (
            <Button
              asChild
              variant="outline"
              size="lg"
              className="group/btn border-primary/30 px-5 text-primary hover:border-primary/50 hover:bg-primary/[0.06] sm:w-auto sm:rounded-2xl sm:px-7"
            >
              <Link to={detailsHref}>
                <span>Detalhes</span>
                <ArrowRight className="h-4 w-4 transition-transform duration-300 group-hover/btn:translate-x-1" />
              </Link>
            </Button>
          ) : null}
          {shareUrl ? (
            <button
              type="button"
              onClick={handleShare}
              title={shareCopied ? "Copiado!" : "Compartilhar carga"}
              aria-label="Compartilhar carga"
              className="inline-flex items-center justify-center rounded-2xl border border-border/40 p-3 text-muted-foreground transition-colors hover:border-border/70 hover:text-foreground"
            >
              <Share2 className="h-4 w-4" />
            </button>
          ) : null}
        </div>
      </div>
      </div>
      {isInterestDialogOpen && loadId ? (
        <DialogContent
          overlayClassName="bg-[hsl(223_56%_12%/0.72)] backdrop-blur-[4px]"
          className="driver-theme max-h-[94vh] max-w-5xl overflow-y-auto border-none bg-transparent p-0 shadow-none [&>button]:right-4 [&>button]:top-4 [&>button]:rounded-full [&>button]:border [&>button]:border-primary/18 [&>button]:bg-white/96 [&>button]:p-2 [&>button]:text-primary [&>button]:opacity-100 [&>button]:shadow-[0_12px_28px_-18px_hsl(223_56%_10%/0.65)] [&>button]:hover:bg-white [&>button]:focus:ring-primary/25 [&>button]:data-[state=open]:bg-white [&>button]:data-[state=open]:text-primary sm:[&>button]:right-5 sm:[&>button]:top-5"
        >
          <DialogTitle className="sr-only">
            Candidatura para a carga de {originLabel} para {destinationLabel}
          </DialogTitle>
          <DialogDescription className="sr-only">
            Preencha seus dados para enviar sua candidatura nesta carga.
          </DialogDescription>
          <DriverClaimPanel
            loadId={loadId}
            panelId={`driver-claim-dialog-${loadId}`}
            className="admin-dialog-surface rounded-[28px] border shadow-[0_32px_64px_-38px_hsl(223_56%_10%/0.38)] sm:rounded-[32px]"
          />
        </DialogContent>
      ) : null}
    </Dialog>
  );
});

LoadCard.displayName = "LoadCard";

export default LoadCard;
