import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ocrRntrc, type RntrcExtracted } from "@/pages/cadastro/cadastroApi";

import { OcrUploadTile, type OcrTileState } from "./OcrUploadTile";

export type AnttCascadeState = "idle" | "loading" | "success" | "not-found" | "error";

export interface AnttCascadeResult {
  rntrc: string;
  tipo?: string;
  situacao?: string;
  validade?: string;
}

export interface AnttCascadeStatusProps {
  state: AnttCascadeState;
  result?: AnttCascadeResult;
  errorMessage?: string;
  /** Tile state for the manual RNTRC upload fallback (CADASTRO-06). */
  uploadState?: OcrTileState;
  uploadFileName?: string;
  uploadErrorMessage?: string;
  onRntrcUpload: (file: File) => void;
  onRntrcUploadRetry?: () => void;
  onRntrcUploadManualFallback?: () => void;
  onRetry?: () => void;
  /** Slot p/ persistência (ex.: "cavalo_antt", "carreta_antt_0"). */
  slot?: string;
  cargaId?: string;
  cpf?: string;
  accessToken?: string | null;
  onDraftPersisted?: (storagePath: string) => void;
  draftPersisted?: boolean;
  /**
   * 2026-05-20 — Callback acionado quando o OCR do RNTRC consegue extrair
   * titular (CPF/CNPJ + tipo PF/PJ + nome). Parent usa pra propagar ao
   * AnttTitularPrompt como cascadeResult e exigir validacao cruzada via
   * CNH/CNPJ do titular. Quando OCR falhar ou nao encontrar documento,
   * callback nao e chamado (parent mantem fluxo antigo: motorista declara
   * manual no AnttTitularPrompt).
   */
  onRntrcExtracted?: (extracted: RntrcExtracted) => void;
}

interface EyebrowValueProps {
  label: string;
  value: string;
}

function EyebrowValue({ label, value }: EyebrowValueProps) {
  return (
    <div className="admin-card-surface rounded-2xl border p-3 shadow-[0_14px_26px_-22px_hsl(223_56%_12%/0.18)]">
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
        {label}
      </p>
      <p className="mt-2 text-sm font-semibold text-foreground break-words">{value}</p>
    </div>
  );
}

/**
 * Widget que reflete os 5 estados da cascata ANTT (W-03) consumida inline pelo Step C2:
 *  - idle:      nada renderizado (caller decide quando inicia)
 *  - loading:   spinner + "Consultando ANTT..."
 *  - success:   card admin-tint-success + grid eyebrow/value (RNTRC, Tipo, Situacao, Validade)
 *  - not-found: admin-tint-warning + upload manual RNTRC (CADASTRO-06)
 *  - error:     admin-tint-danger + botao retry
 *
 * Copy travada pela UI-SPEC (PT-BR com acentos preservados).
 */
export function AnttCascadeStatus({
  state,
  result,
  errorMessage,
  uploadState = "empty",
  uploadFileName,
  uploadErrorMessage,
  onRntrcUpload,
  onRntrcUploadRetry,
  onRntrcUploadManualFallback,
  onRetry,
  slot,
  cargaId,
  cpf,
  accessToken,
  onDraftPersisted,
  draftPersisted,
  onRntrcExtracted,
}: AnttCascadeStatusProps) {
  // Wrapper que dispara o OCR do RNTRC em paralelo ao upload draft + callback
  // do parent. Se o backend extrair titular_doc + tipo, propaga via
  // onRntrcExtracted pra parent renderizar AnttTitularPrompt (validacao da
  // CNH/CNPJ do titular). Falha do OCR nao bloqueia: parent ainda recebe
  // o file via onRntrcUpload (fluxo antigo segue).
  const handleRntrcFile = (file: File) => {
    onRntrcUpload(file);
    if (!onRntrcExtracted) return;
    void ocrRntrc(file)
      .then((extracted) => {
        if (extracted.documento) {
          onRntrcExtracted(extracted);
        }
      })
      .catch((err) => {
        if (import.meta.env.DEV) {
          console.warn("[AnttCascadeStatus] ocrRntrc falhou:", err);
        }
      });
  };

  if (state === "idle") {
    return null;
  }

  if (state === "loading") {
    return (
      <div
        className="flex items-center gap-3 text-sm text-muted-foreground"
        aria-live="polite"
        aria-atomic="true"
      >
        <Loader2 className="size-5 animate-spin text-primary" aria-hidden="true" />
        Consultando ANTT…
      </div>
    );
  }

  if (state === "success") {
    return (
      <div role="status" aria-live="polite" className="admin-tint-success rounded-2xl border p-3.5 sm:p-4">
        <div className="flex items-start gap-2.5 sm:gap-3">
          <CheckCircle2
            className="mt-0.5 size-5 shrink-0 text-emerald-700"
            aria-hidden="true"
          />
          <div className="flex-1 space-y-3">
            <div>
              <p className="text-sm font-semibold text-foreground sm:text-base">
                RNTRC encontrado
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Dados confirmados na ANTT.
              </p>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <EyebrowValue label="RNTRC" value={result?.rntrc || "—"} />
              {result?.tipo ? <EyebrowValue label="Tipo" value={result.tipo} /> : null}
              {result?.situacao ? (
                <EyebrowValue label="Situação" value={result.situacao} />
              ) : null}
              {result?.validade ? (
                <EyebrowValue label="Validade" value={result.validade} />
              ) : null}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (state === "not-found") {
    return (
      <div className="space-y-3">
        <div role="status" aria-live="polite" className="admin-tint-warning rounded-2xl border p-3.5 sm:p-4">
          <div className="flex items-start gap-2.5 sm:gap-3">
            <AlertCircle
              className="mt-0.5 size-5 shrink-0 text-amber-700"
              aria-hidden="true"
            />
            <div className="space-y-1">
              <p className="text-sm font-semibold text-foreground sm:text-base">
                Não encontramos o RNTRC automaticamente.
              </p>
              <p className="text-xs leading-5 text-muted-foreground sm:text-sm sm:leading-relaxed">
                Envie a foto do documento ANTT para a equipe analisar.
              </p>
            </div>
          </div>
        </div>
        <OcrUploadTile
          accept="image/*,application/pdf"
          maxSizeMb={8}
          label="Documento RNTRC / ANTT"
          helper="Documento ANTT do transportador (PDF ou foto)"
          state={uploadState}
          previewName={uploadFileName}
          errorMessage={uploadErrorMessage}
          onFile={handleRntrcFile}
          onRetry={onRntrcUploadRetry ?? (() => {})}
          onManualFallback={onRntrcUploadManualFallback ?? (() => undefined)}
          slot={slot}
          cargaId={cargaId}
          cpf={cpf}
          accessToken={accessToken}
          onDraftPersisted={(result) => {
            if (onDraftPersisted) onDraftPersisted(result.storage_path);
          }}
          draftPersisted={draftPersisted}
        />
      </div>
    );
  }

  // state === "error"
  return (
    <div role="alert" className="admin-tint-danger rounded-2xl border p-3.5 sm:p-4">
      <div className="flex items-start gap-2.5 sm:gap-3">
        <AlertCircle
          className="mt-0.5 size-5 shrink-0 text-destructive"
          aria-hidden="true"
        />
        <div className="flex-1 space-y-2">
          <p className="text-sm font-semibold text-foreground sm:text-base">
            Erro ao consultar ANTT
          </p>
          <p className="text-xs text-muted-foreground sm:text-sm">
            {errorMessage ?? "Tente novamente em alguns instantes."}
          </p>
          {onRetry ? (
            <div className="pt-1">
              <Button
                type="button"
                onClick={onRetry}
                className="min-h-[44px] w-full sm:w-auto"
              >
                Tentar novamente
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
