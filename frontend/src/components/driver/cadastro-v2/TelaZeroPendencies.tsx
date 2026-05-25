import { memo } from "react";
import { AlertCircle, CheckCircle2, Clock3, FastForward, ShieldAlert } from "lucide-react";

import { cn } from "@/lib/utils";
import type { CandidaturaCompleto, CandidaturaPendency } from "@/api/candidaturaApi";

export interface TelaZeroPendenciesProps {
  pendencias: CandidaturaPendency[];
  completos: CandidaturaCompleto[];
  onConfirm: () => void;
  onDismiss: () => void;
  /**
   * Iter #7 — Callback quando o motorista clica em "Enviar candidatura agora"
   * a partir do card DUPLICATE_PENDING_REGISTRATION. Dispara apenas o lead/
   * claim na carga atual SEM reabrir o wizard.
   */
  onSkipWizardAndClaim?: () => void;
}

/**
 * Detecta se ha alguma pendencia bloqueante (tipo de veiculo errado) — quando
 * houver, o CTA "Completar agora" fica desabilitado porque o motorista precisa
 * corrigir a placa no DriverClaimPanel antes de seguir.
 */
function hasBlockingMismatch(pendencias: CandidaturaPendency[]): boolean {
  return pendencias.some((p) => p.reason === "VEHICLE_TYPE_MISMATCH");
}

/**
 * Tela 0 — lista pendências cadastrais (warning), completos (success) e
 * info footer com tempo estimado + SLA da análise. Apresenta CTAs primaria
 * "Completar agora" (accent gradient) e secundária "Agora não".
 *
 * Copy strings PT-BR locked per UI-SPEC.md Copywriting Contract.
 */
function TelaZeroPendenciesImpl({
  pendencias,
  completos,
  onConfirm,
  onDismiss,
  onSkipWizardAndClaim,
}: TelaZeroPendenciesProps) {
  const blocked = hasBlockingMismatch(pendencias);
  // Iter #7: detecta duplicate pra surfaceaer card especial com skip-wizard CTA.
  const duplicate = pendencias.find((p) => p.reason === "DUPLICATE_PENDING_REGISTRATION");

  return (
    <section className="space-y-5">
      <header className="space-y-2">
        <h2 className="text-2xl font-semibold tracking-tight text-foreground">
          {blocked ? "A placa nao bate" : "Antes de enviar"}
        </h2>
        <p className="text-base text-foreground/80 leading-relaxed">
          {blocked
            ? "Confira a placa antes de prosseguir — a candidatura nao pode aceitar carreta como cavalo (ou o contrario)."
            : "Falta pouco. Confira o que precisa atualizar."}
        </p>
      </header>

      {/* Iter #7 — Duplicate card (sticky no topo, com CTA skip-wizard). */}
      {duplicate && onSkipWizardAndClaim ? (
        <div className="rounded-[22px] border border-amber-300 bg-amber-50 p-4 sm:rounded-3xl sm:p-5">
          <div className="flex items-start gap-3">
            <FastForward className="mt-0.5 size-6 shrink-0 text-amber-700" />
            <div className="flex-1 space-y-2">
              <p className="text-base font-semibold text-foreground">
                Cadastro em analise
              </p>
              <p className="text-sm leading-relaxed text-foreground/80">
                {duplicate.label}
              </p>
              <button
                type="button"
                onClick={onSkipWizardAndClaim}
                className="inline-flex items-center justify-center gap-2 rounded-full bg-amber-600 px-4 py-2.5 text-sm font-bold text-white shadow-sm transition-colors hover:bg-amber-700"
              >
                Enviar candidatura agora
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {pendencias.length > 0 ? (
        <ul className="space-y-2.5" aria-label="Pendências cadastrais">
          {pendencias.map((pendencia, index) => {
            if (pendencia.reason === "DUPLICATE_PENDING_REGISTRATION") {
              return null; // ja renderizado no card especial acima
            }
            const isMismatch = pendencia.reason === "VEHICLE_TYPE_MISMATCH";
            return (
              <li
                key={`${pendencia.step}-${pendencia.plate ?? ""}-${index}`}
                className={cn(
                  "rounded-[22px] border p-3.5 sm:rounded-3xl sm:p-4",
                  isMismatch
                    ? "border-destructive/40 bg-destructive/5"
                    : "admin-tint-warning",
                )}
              >
                <div className="flex items-start gap-2.5 sm:gap-3">
                  {isMismatch ? (
                    <ShieldAlert className="mt-0.5 size-5 shrink-0 text-destructive" />
                  ) : (
                    <AlertCircle className="mt-0.5 size-5 shrink-0 text-amber-700" />
                  )}
                  <p className="text-base font-medium text-foreground">
                    {pendencia.label}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}

      {completos.length > 0 ? (
        <ul className="space-y-2.5" aria-label="Itens já registrados e vigentes">
          {completos.map((completo) => (
            <li
              key={completo.plate}
              className={cn(
                "admin-tint-success rounded-[22px] border p-3.5 sm:rounded-3xl sm:p-4",
              )}
            >
              <div className="flex items-start gap-2.5 sm:gap-3">
                <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-700" />
                <p className="text-base font-medium text-foreground">
                  {completo.plate} já está registrado e vigente
                </p>
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="admin-tint-info rounded-[22px] border p-3.5 sm:rounded-3xl sm:p-4">
        <div className="flex items-start gap-2.5 sm:gap-3">
          <Clock3 className="mt-0.5 size-5 shrink-0 text-primary" />
          <p className="text-base text-foreground">
            Leva cerca de 10 minutos. A Lamônica analisa em até 2 dias úteis.
          </p>
        </div>
      </div>

      <div className="flex flex-col-reverse gap-2.5 pt-1 sm:flex-row sm:items-center sm:justify-end sm:gap-3">
        <button
          type="button"
          onClick={onDismiss}
          className="inline-flex w-full items-center justify-center gap-2 rounded-full border border-transparent px-5 py-3 text-sm font-semibold text-muted-foreground transition-colors hover:bg-muted/60 sm:w-auto"
        >
          {blocked ? "Voltar e corrigir placa" : "Agora não"}
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={blocked}
          className={cn(
            "inline-flex w-full items-center justify-center gap-2 rounded-full px-5 py-3.5 text-sm font-bold transition-all sm:w-auto",
            blocked
              ? "cursor-not-allowed bg-muted text-muted-foreground"
              : "bg-gradient-to-r from-accent to-[hsl(155_70%_44%)] text-accent-foreground shadow-[0_4px_14px_hsl(155_70%_38%/0.3)] hover:-translate-y-0.5 hover:shadow-[0_6px_20px_hsl(155_70%_38%/0.4)] active:translate-y-0 active:shadow-[0_2px_8px_hsl(155_70%_38%/0.3)]",
          )}
        >
          Completar agora
        </button>
      </div>
    </section>
  );
}

export const TelaZeroPendencies = memo(TelaZeroPendenciesImpl);
