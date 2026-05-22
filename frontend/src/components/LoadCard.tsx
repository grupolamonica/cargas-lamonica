import { memo, useState, useMemo } from "react";
import type { LucideIcon } from "lucide-react";
import { ArrowRight, Link2, Navigation, Share2, ShieldCheck, Truck } from "lucide-react";
import { Link } from "react-router-dom";
import { toast } from "sonner";

import ClientLogo from "@/components/ClientLogo";
import DriverClaimPanel from "@/components/driver/DriverClaimPanel";
import PacoteHeader from "@/components/load-card/PacoteHeader";
import PacoteStopsList from "@/components/load-card/PacoteStopsList";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { fixBrokenPortugueseText } from "@/lib/fixBrokenEncoding";
import type { PacoteMeta } from "@/services/readModels";

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
  /**
   * Meta do pacote (cargas casadas) — quando presente E `total_cargas > 1`, o card
   * renderiza a vista "viagem casada" (header + lista vertical de paradas + valor
   * do pacote). Caso ausente OU `total_cargas === 1`, render permanece idêntico
   * ao card avulsa pre-existente (CARGAS-CASADAS-08 zero regressão).
   */
  pacoteMeta?: PacoteMeta | null;
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
  pacoteMeta,
}: LoadCardProps) => {
  // Pacote degenerado (total_cargas === 1) é funcionalmente equivalente a avulsa
  // — renderiza como avulsa, sem header/lista de paradas. CARGAS-CASADAS-08.
  const renderPacote = Boolean(pacoteMeta && pacoteMeta.total_cargas > 1);
  const safeOrigemCidade = fixBrokenPortugueseText(origemCidade);
  const safeDestinoCidade = fixBrokenPortugueseText(destinoCidade);
  const safeClienteNome = fixBrokenPortugueseText(clienteNome);
  const originLabel = origemEstado ? `${safeOrigemCidade}, ${origemEstado}` : safeOrigemCidade;
  const destinationLabel = destinoEstado ? `${safeDestinoCidade}, ${destinoEstado}` : safeDestinoCidade;
  const topRightLabel = safeClienteNome || "Cliente não informado";
  const loadingLabel = carregamentoLabel?.trim() || "A confirmar";
  const unloadingLabel = descargaLabel?.trim() || "A confirmar";
  const kmLabel = routeDistanceLabel || "A confirmar";
  const routeDurationValue = routeDurationLabel?.replace(/^Tempo estimado:\s*/i, "").trim() || null;
  const clientHref = clienteId ? `/motorista/cliente/${clienteId}` : null;
  const clientLogoUrl = clienteLogoUrlCard ?? null;
  const [isInterestDialogOpen, setIsInterestDialogOpen] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);
  const shareUrl = detailsHref ? `${window.location.origin}${detailsHref}` : null;

  const shareText = useMemo(() => {
    if (!shareUrl) return "";
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
    return lines.join("\n");
  }, [shareUrl, originLabel, destinationLabel, tipoVeiculo, pagamento, clienteNome, valorCarga, bonusValor, loadingLabel, unloadingLabel, kmLabel, routeDurationValue]);

  const renderSharePopover = (trigger: React.ReactNode) => {
    if (!shareUrl) return null;

    const handleCopy = async () => {
      try { await navigator.clipboard.writeText(shareUrl); } catch { /* ignore */ }
      setShareCopied(true);
      setTimeout(() => setShareCopied(false), 2000);
    };

    return (
      <Popover>
        <PopoverTrigger asChild>{trigger}</PopoverTrigger>
        <PopoverContent align="end" side="top" className="w-44 p-1.5">
          <button type="button" onClick={() => window.open(`https://wa.me/?text=${encodeURIComponent(shareText)}`, "_blank")}
            className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-sm text-foreground transition-colors hover:bg-muted">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#25D366]">
              <svg viewBox="0 0 24 24" className="h-4 w-4 fill-white" aria-hidden="true"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
            </span>
            WhatsApp
          </button>
          <button type="button" onClick={() => window.open(`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(shareUrl)}`, "_blank")}
            className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-sm text-foreground transition-colors hover:bg-muted">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#1877F2]">
              <svg viewBox="0 0 24 24" className="h-4 w-4 fill-white" aria-hidden="true"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>
            </span>
            Facebook
          </button>
          <button type="button" onClick={() => { toast.success("Link copiado! Cole no Instagram."); void handleCopy(); }}
            className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-sm text-foreground transition-colors hover:bg-muted">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full" style={{ background: "linear-gradient(45deg,#f09433,#e6683c,#dc2743,#cc2366,#bc1888)" }}>
              <svg viewBox="0 0 24 24" className="h-4 w-4 fill-white" aria-hidden="true"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z"/></svg>
            </span>
            Instagram
          </button>
          <button type="button" onClick={() => window.open(`https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(shareUrl)}`, "_blank")}
            className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-sm text-foreground transition-colors hover:bg-muted">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#0A66C2]">
              <svg viewBox="0 0 24 24" className="h-4 w-4 fill-white" aria-hidden="true"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>
            </span>
            LinkedIn
          </button>
          <button type="button" onClick={() => void handleCopy()}
            className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-sm text-foreground transition-colors hover:bg-muted">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted">
              <Link2 className="h-3.5 w-3.5 text-muted-foreground" />
            </span>
            {shareCopied ? "Copiado!" : "Copiar link"}
          </button>
        </PopoverContent>
      </Popover>
    );
  };

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
      {renderPacote && pacoteMeta ? (
        <div
          className="group relative rounded-2xl border border-border/50 bg-card p-4 opacity-0 transition-shadow duration-300 ease-out premium-shadow hover:-translate-y-1 hover:transform-gpu hover:premium-shadow-hover sm:rounded-3xl sm:p-6 lg:rounded-[28px] lg:p-5 animate-fade-in-up"
          style={{
            animationDelay: `${index * 80}ms`,
            contentVisibility: "auto",
            containIntrinsicSize: "420px",
            contain: "layout paint style",
          }}
          data-testid="load-card-pacote"
        >
          <div className="pointer-events-none absolute inset-0 rounded-2xl bg-gradient-to-br from-primary/[0.02] to-accent/[0.02] opacity-0 transition-opacity duration-500 group-hover:opacity-100 sm:rounded-3xl" />
          <div className="pointer-events-none absolute inset-x-8 top-0 hidden h-px bg-gradient-to-r from-transparent via-primary/25 to-transparent lg:block" />

          <div className="relative">
            <PacoteHeader
              totalCargas={pacoteMeta.total_cargas}
              valorTotal={pacoteMeta.valor_total}
              status={pacoteMeta.status}
            />
            <PacoteStopsList pacoteId={pacoteMeta.id} version={pacoteMeta.version} />

            <div className="mt-5 flex flex-col gap-2 border-t border-border/40 pt-4 sm:flex-row sm:items-center sm:gap-3">
              <div className={cn(actionGridClassName, "flex-1")}>
                {renderInterestDialogTrigger("group/btn h-12 w-full rounded-full px-6")}
                {detailsHref ? (
                  <Button
                    asChild
                    variant="outline"
                    size="lg"
                    className="group/btn h-12 w-full rounded-full border-primary/30 px-6 text-primary hover:border-primary/50 hover:bg-primary/[0.06] hover:text-primary"
                  >
                    <Link to={detailsHref}>
                      <span>Detalhes</span>
                      <ArrowRight className="h-4 w-4 transition-transform duration-300 group-hover/btn:translate-x-1" />
                    </Link>
                  </Button>
                ) : null}
              </div>
              {renderSharePopover(
                <button
                  type="button"
                  aria-label="Compartilhar carga"
                  className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-primary/30 text-primary transition-colors hover:border-primary/50 hover:bg-primary/[0.06]"
                >
                  <Share2 className="h-4 w-4" />
                </button>,
              )}
            </div>
          </div>
        </div>
      ) : (
      <div
        className="group relative rounded-2xl border border-border/50 bg-card p-4 opacity-0 transition-shadow duration-300 ease-out premium-shadow hover:-translate-y-1 hover:transform-gpu hover:premium-shadow-hover sm:rounded-3xl sm:p-6 lg:rounded-[28px] lg:p-5 animate-fade-in-up"
        style={{
          animationDelay: `${index * 80}ms`,
          contentVisibility: "auto",
          containIntrinsicSize: "420px",
          contain: "layout paint style",
        }}
        data-testid="load-card-avulsa"
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
              {safeOrigemCidade}
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
              {safeDestinoCidade}
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

        <div className="mt-6 flex items-center gap-2">
          <div className={cn(actionGridClassName, "flex-1")}>
            {renderInterestDialogTrigger("group/btn h-12 w-full rounded-full px-6")}
            {detailsHref ? (
              <Button
                asChild
                variant="outline"
                size="lg"
                className="group/btn h-12 w-full rounded-full border-primary/30 px-6 text-primary hover:border-primary/50 hover:bg-primary/[0.06] hover:text-primary"
              >
                <Link to={detailsHref}>
                  <span>Detalhes</span>
                  <ArrowRight className="h-4 w-4 transition-transform duration-300 group-hover/btn:translate-x-1" />
                </Link>
              </Button>
            ) : null}
          </div>
          {renderSharePopover(
            <button
              type="button"
              aria-label="Compartilhar carga"
              className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-primary/30 text-primary transition-colors hover:border-primary/50 hover:bg-primary/[0.06]"
            >
              <Share2 className="h-4 w-4" />
            </button>
          )}
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
                className="group/btn w-full rounded-xl border-primary/30 px-5 text-primary hover:border-primary/50 hover:bg-primary/[0.06] hover:text-primary"
              >
                <Link to={detailsHref}>
                  <span>Detalhes</span>
                  <ArrowRight className="h-4 w-4 transition-transform duration-300 group-hover/btn:translate-x-1" />
                </Link>
              </Button>
            ) : null}
          </div>
          {renderSharePopover(
            <button
              type="button"
              className="mt-2.5 flex w-full items-center justify-center gap-2 rounded-xl border border-border/60 bg-muted/30 py-2.5 text-sm font-semibold text-muted-foreground transition-colors hover:border-border hover:bg-muted/60 hover:text-foreground active:scale-[0.98]"
            >
              <Share2 className="h-4 w-4" />
              Compartilhar carga
            </button>
          )}
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
              className="group/btn border-primary/30 px-5 text-primary hover:border-primary/50 hover:bg-primary/[0.06] hover:text-primary sm:w-auto sm:rounded-2xl sm:px-7"
            >
              <Link to={detailsHref}>
                <span>Detalhes</span>
                <ArrowRight className="h-4 w-4 transition-transform duration-300 group-hover/btn:translate-x-1" />
              </Link>
            </Button>
          ) : null}
          {renderSharePopover(
            <button
              type="button"
              aria-label="Compartilhar carga"
              className="inline-flex items-center justify-center rounded-2xl border border-border/40 p-3 text-muted-foreground transition-colors hover:border-border/70 hover:text-foreground"
            >
              <Share2 className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
      </div>
      )}
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
