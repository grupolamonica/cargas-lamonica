import { BadgeCheck, FileBadge2, Phone, ShieldX, Truck, UserRound, XCircle } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { parseDateStringAsLocal } from "@/lib/dateDisplay";
import { cn } from "@/lib/utils";
import TorreRankingCard from "@/components/operator/TorreRankingCard";
import type { PublicLeadValidationSummary, PublicLeadValidationPlate } from "@/services/loadClaims";

export interface DriverDetailModalData {
  name: string | null;
  cpf: string | null;
  phone: string | null;
  vehicleType: string | null;
  plates: {
    horsePlate: string | null;
    trailerPlate: string | null;
    trailerPlate2: string | null;
  } | null;
  validation: PublicLeadValidationSummary | null;
  angelliraDetails: {
    name: string | null;
    cpf: string | null;
    birthDate: string | null;
    rg: string | null;
    uf: string | null;
    fatherName: string | null;
    motherName: string | null;
    cnhNumber: string | null;
    cnhCategory: string | null;
    cnhSecurityCode: string | null;
    cnhValidity: string | null;
    phone: string | null;
    city: string | null;
    naturalness: string | null;
  } | null;
}

interface DriverDetailModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  data: DriverDetailModalData | null;
  hideValidation?: boolean;
}

function getLookupBadgeClasses(status: string) {
  if (status === "FOUND") return "admin-tint-success";
  if (status === "UNAVAILABLE") return "admin-tint-neutral";
  return "admin-tint-danger";
}

function getLookupLabel(source: string, status: string) {
  if (status === "FOUND") return `${source}: Encontrado`;
  if (status === "UNAVAILABLE") return `${source}: Indisponível`;
  return `${source}: Não encontrado`;
}

function renderPlateValidation(plate: PublicLeadValidationPlate) {
  return (
    <span
      key={plate.field}
      className={cn("inline-flex rounded-full border px-2.5 py-1 text-[11px] font-semibold", getLookupBadgeClasses(plate.status))}
    >
      {plate.label}: {plate.status === "FOUND" ? "Validada" : plate.status === "UNAVAILABLE" ? "Não validada" : "Não encontrada"}
      {plate.validUntil ? ` (ate ${parseDateStringAsLocal(plate.validUntil)?.toLocaleDateString("pt-BR") ?? ""})` : ""}
    </span>
  );
}

function DetailRow({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <div>
      <p className="text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">{label}</p>
      <p className="mt-0.5 font-medium text-foreground text-sm">{value}</p>
    </div>
  );
}

export default function DriverDetailModal({ open, onOpenChange, data, hideValidation = false }: DriverDetailModalProps) {
  const driverName = data?.angelliraDetails?.name || data?.name || "Motorista";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto rounded-3xl p-0">
        {data && (
        <>
        {/* Header */}
        <DialogHeader className="border-b border-border/70 px-6 pt-6 pb-4">
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-[linear-gradient(135deg,#022483,#0b4de8)] text-white">
              <UserRound className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <DialogTitle className="text-lg font-semibold tracking-tight truncate">
                {driverName}
              </DialogTitle>
              <DialogDescription className="text-sm text-muted-foreground">
                Detalhes do motorista e veiculo
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-5 px-6 pb-6 pt-2">
          {/* Contact */}
          <section>
            <h4 className="text-xs font-semibold uppercase tracking-[0.24em] text-muted-foreground mb-3">Contato</h4>
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-foreground">
              {data.phone ? (
                <span className="inline-flex items-center gap-1.5">
                  <Phone className="h-3.5 w-3.5 text-primary" />
                  {data.phone}
                </span>
              ) : null}
              {data.cpf ? (
                <span className="inline-flex items-center gap-1.5">
                  <FileBadge2 className="h-3.5 w-3.5 text-primary" />
                  {data.cpf}
                </span>
              ) : null}
              {data.vehicleType ? (
                <span className="inline-flex items-center gap-1.5">
                  <Truck className="h-3.5 w-3.5 text-primary" />
                  {data.vehicleType}
                </span>
              ) : null}
            </div>
          </section>

          {/* Ranking Torre de Controle — posição + métricas por CPF */}
          {data.cpf && data.cpf.replace(/\D/g, "").length === 11 ? (
            <TorreRankingCard cpf={data.cpf} />
          ) : null}

          {/* Validation Badges */}
          {!hideValidation && data.validation ? (
            <section>
              <h4 className="text-xs font-semibold uppercase tracking-[0.24em] text-muted-foreground mb-3">Validacao</h4>
              <div className="flex flex-wrap gap-1.5">
                <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold", getLookupBadgeClasses(data.validation.driver.angelira.status))}>
                  {data.validation.driver.angelira.status === "FOUND" ? <BadgeCheck className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
                  {getLookupLabel("Angellira", data.validation.driver.angelira.status)}
                </span>
                <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold", getLookupBadgeClasses(data.validation.driver.aspx.status))}>
                  {data.validation.driver.aspx.status === "FOUND" ? <BadgeCheck className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
                  {getLookupLabel("ASPX", data.validation.driver.aspx.status)}
                </span>
              </div>
            </section>
          ) : null}

          {/* Plates */}
          {data.plates ? (
            <section>
              <h4 className="text-xs font-semibold uppercase tracking-[0.24em] text-muted-foreground mb-3">Placas</h4>
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div className="admin-soft-panel px-4 py-3">
                  <p className="text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Cavalo</p>
                  <p className="mt-1 font-mono font-semibold text-foreground">{data.plates.horsePlate || "Nao informado"}</p>
                </div>
                <div className="admin-soft-panel px-4 py-3">
                  <p className="text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Carreta 1</p>
                  <p className="mt-1 font-mono font-semibold text-foreground">{data.plates.trailerPlate || "Nao informado"}</p>
                </div>
                {data.plates.trailerPlate2 ? (
                  <div className="admin-soft-panel px-4 py-3">
                    <p className="text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Carreta 2</p>
                    <p className="mt-1 font-mono font-semibold text-foreground">{data.plates.trailerPlate2}</p>
                  </div>
                ) : null}
              </div>

              {/* Plate validation badges */}
              {!hideValidation && data.validation?.plates.length ? (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {data.validation.plates.map(renderPlateValidation)}
                </div>
              ) : null}
            </section>
          ) : null}

          {/* Angellira Details */}
          {data.angelliraDetails ? (
            <section>
              <h4 className="text-xs font-semibold uppercase tracking-[0.24em] text-muted-foreground mb-3">Dados Angellira</h4>
              <div className="rounded-2xl border border-border/60 bg-muted/20 p-4">
                <div className="grid grid-cols-2 gap-x-6 gap-y-3">
                  <DetailRow label="Nome" value={data.angelliraDetails.name} />
                  <DetailRow label="CPF" value={data.angelliraDetails.cpf} />
                  <DetailRow label="RG" value={data.angelliraDetails.rg} />
                  <DetailRow label="UF" value={data.angelliraDetails.uf} />
                  <DetailRow label="Data Nascimento" value={data.angelliraDetails.birthDate ? parseDateStringAsLocal(data.angelliraDetails.birthDate)?.toLocaleDateString("pt-BR") ?? null : null} />
                  <DetailRow label="Cidade" value={data.angelliraDetails.city} />
                  <DetailRow label="Naturalidade" value={data.angelliraDetails.naturalness} />
                  <DetailRow label="Nome do Pai" value={data.angelliraDetails.fatherName} />
                  <DetailRow label="Nome da Mae" value={data.angelliraDetails.motherName} />
                  <DetailRow label="Numero CNH" value={data.angelliraDetails.cnhNumber} />
                  <DetailRow label="Categoria CNH" value={data.angelliraDetails.cnhCategory} />
                  <DetailRow label="Cod. Seguranca CNH" value={data.angelliraDetails.cnhSecurityCode} />
                  <DetailRow label="Validade CNH" value={data.angelliraDetails.cnhValidity ? parseDateStringAsLocal(data.angelliraDetails.cnhValidity)?.toLocaleDateString("pt-BR") ?? null : null} />
                  <DetailRow label="Telefone" value={data.angelliraDetails.phone} />
                </div>
              </div>
            </section>
          ) : null}

          {/* Vigency info from validation */}
          {!hideValidation && data.validation?.vigency ? (
            <section>
              <h4 className="text-xs font-semibold uppercase tracking-[0.24em] text-muted-foreground mb-3">Vigência</h4>
              <div className="flex flex-wrap gap-2 text-sm">
                <span className={cn(
                  "inline-flex rounded-full border px-3 py-1.5 text-xs font-semibold",
                  data.validation.vigency.status === "VALID"
                    ? "admin-tint-success"
                    : data.validation.vigency.status === "EXPIRING"
                      ? "admin-tint-warning"
                      : data.validation.vigency.status === "UNAVAILABLE"
                        ? "admin-tint-neutral"
                        : "admin-tint-danger",
                )}>
                  {data.validation.vigency.status === "VALID"
                    ? `Vigência válida${data.validation.vigency.validUntil ? ` até ${parseDateStringAsLocal(data.validation.vigency.validUntil)?.toLocaleDateString("pt-BR") ?? ""}` : ""}`
                    : data.validation.vigency.status === "EXPIRING"
                      ? `Vence em ${data.validation.vigency.daysUntilExpiry ?? "?"} dia(s)`
                      : data.validation.vigency.status === "UNAVAILABLE"
                        ? "Vigência não validada"
                        : "Vigência vencida"}
                </span>
              </div>
            </section>
          ) : null}

          {/* Warnings */}
          {!hideValidation && data.validation?.warnings.length ? (
            <section>
              <h4 className="text-xs font-semibold uppercase tracking-[0.24em] text-muted-foreground mb-2">Alertas</h4>
              <ul className="space-y-1 text-xs text-muted-foreground">
                {data.validation.warnings.map((warning, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <ShieldX className="h-3.5 w-3.5 mt-0.5 text-amber-500 shrink-0" />
                    {warning}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
        </>
        )}
      </DialogContent>
    </Dialog>
  );
}
