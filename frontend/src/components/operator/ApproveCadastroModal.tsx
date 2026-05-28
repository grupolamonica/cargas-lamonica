import { useState } from "react";
import {
  AlertTriangle,
  Building2,
  Check,
  Loader2,
  Truck,
  UserRound,
} from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export type ApproveJob = "angellira" | "spx";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  motoristaNome?: string;
  motoristaCpf?: string;
  hasCavalo?: boolean;
  hasCarreta?: boolean;
  /** invocado com o array de jobs ['angellira'] (ou vazio se só criar conta) */
  onConfirm: (jobs: ApproveJob[]) => void;
  isSubmitting?: boolean;
};

/**
 * Modal de aprovação de cadastro com opt-in para disparar cadastro externo.
 *
 * Sprint 1: Angellira disponível (default ligado).
 * Sprint 2: SPX virá habilitado.
 *
 * Quando o usuário clica "Aprovar", chama onConfirm(['angellira']) ou [] se
 * desmarcou.
 */
export default function ApproveCadastroModal({
  open,
  onOpenChange,
  motoristaNome,
  motoristaCpf,
  hasCavalo,
  hasCarreta,
  onConfirm,
  isSubmitting,
}: Props) {
  const [angelliraChecked, setAngelliraChecked] = useState(true);

  const handleConfirm = () => {
    const jobs: ApproveJob[] = [];
    if (angelliraChecked) jobs.push("angellira");
    onConfirm(jobs);
  };

  const nomeFmt = motoristaNome?.toUpperCase() || "—";
  const cpfFmt = motoristaCpf?.replace(/\D/g, "") || "";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Check className="h-5 w-5 text-emerald-600" />
            Aprovar cadastro
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm">
            <p className="flex items-center gap-2 font-semibold text-foreground">
              <UserRound className="h-4 w-4 text-muted-foreground" />
              {nomeFmt}
            </p>
            {cpfFmt ? (
              <p className="mt-1 text-xs text-muted-foreground">CPF {cpfFmt}</p>
            ) : null}
            <div className="mt-2 flex flex-wrap gap-2 text-xs">
              {hasCavalo ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 text-blue-700">
                  <Truck className="h-3 w-3" /> Cavalo
                </span>
              ) : null}
              {hasCarreta ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 text-blue-700">
                  <Truck className="h-3 w-3" /> Carreta
                </span>
              ) : null}
            </div>
          </div>

          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Após aprovar, também:
            </p>
            <div className="space-y-2">
              <label
                className={cn(
                  "flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors",
                  angelliraChecked
                    ? "border-emerald-300 bg-emerald-50/60"
                    : "border-border bg-background hover:border-emerald-200",
                )}
              >
                <input
                  type="checkbox"
                  checked={angelliraChecked}
                  onChange={(e) => setAngelliraChecked(e.target.checked)}
                  className="mt-0.5 h-4 w-4 cursor-pointer accent-emerald-600"
                />
                <div className="flex-1 text-sm">
                  <p className="flex items-center gap-2 font-semibold text-foreground">
                    <Building2 className="h-4 w-4 text-emerald-700" />
                    Cadastrar no Angellira
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Proprietário {hasCavalo ? "+ cavalo " : ""}
                    {hasCarreta ? "+ carreta " : ""}
                    + motorista. Tempo médio ~30-60s.
                  </p>
                </div>
              </label>

              {/* SPX placeholder — Sprint 2 */}
              <label
                className="flex cursor-not-allowed items-start gap-3 rounded-lg border border-border bg-muted/30 p-3 opacity-60"
                title="Disponível no Sprint 2"
              >
                <input type="checkbox" disabled className="mt-0.5 h-4 w-4" />
                <div className="flex-1 text-sm">
                  <p className="flex items-center gap-2 font-semibold text-muted-foreground">
                    <Truck className="h-4 w-4" />
                    Cadastrar no SPX/Shopee
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Em breve (Sprint 2 — DC-111).
                  </p>
                </div>
              </label>
            </div>
          </div>

          {angelliraChecked ? (
            <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50/70 p-3 text-xs text-amber-800">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <p>
                Acompanhe o resultado no painel após a aprovação. Você poderá
                re-tentar cada etapa individualmente em caso de erro.
              </p>
            </div>
          ) : null}
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <button
            type="button"
            disabled={isSubmitting}
            onClick={() => onOpenChange(false)}
            className="inline-flex items-center justify-center rounded-xl border border-border bg-background px-4 py-2 text-sm font-semibold text-foreground hover:bg-muted disabled:opacity-60 transition-colors"
          >
            Cancelar
          </button>
          <button
            type="button"
            disabled={isSubmitting}
            onClick={handleConfirm}
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:opacity-60 transition-colors"
          >
            {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            Aprovar
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
