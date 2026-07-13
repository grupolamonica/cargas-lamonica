import { useId, useRef, useState } from "react";
import { AlertCircle, Camera, CheckCircle2, CloudUpload, FileText, FileUp, Loader2, Pencil } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { humanizeOcrMessage, uploadDraftFile } from "@/services/cadastroApi";

import { OcrResultReview, type OcrResultField } from "./OcrResultReview";

export interface DraftPersistResult {
  slot: string;
  storage_path: string;
  signed_url: string;
  filename: string;
}

export type OcrTileState = "empty" | "uploading" | "success" | "failure" | "manual";

export interface OcrUploadTileProps {
  /** MIME types aceitos. Padrão: image/* + application/pdf. */
  accept?: string;
  /**
   * Captura preferida da câmera nativa (mobile). Quando definida, o botão
   * "Tirar foto" usa `capture` para abrir a câmera direto; o botão "Enviar
   * arquivo" ignora o capture e abre o picker nativo (galeria/arquivos/PDF).
   */
  capture?: "environment" | "user";
  /** Tamanho máximo em MB. Default: 8MB (alinhado com backend FastAPI). */
  maxSizeMb?: number;
  /** Callback acionado quando o arquivo passa na validação client. */
  onFile: (file: File) => void;
  /** Estado controlado pelo pai. */
  state: OcrTileState;
  /** Label principal (ex.: "Foto da sua CNH"). */
  label: string;
  /** Helper text abaixo do label (ex.: "Frente, com todos os dados visíveis"). */
  helper?: string;
  /** Campos extraídos do OCR para o estado success. */
  extractedData?: OcrResultField[];
  /** Mensagem de erro retornada pelo backend (state=failure). */
  errorMessage?: string;
  /** Botão "Tentar novamente" no estado failure. */
  onRetry: () => void;
  /** Botão "Digitar manualmente" no estado failure. */
  onManualFallback: () => void;
  /** Nome do arquivo selecionado (mostrado em uploading/success/failure). */
  previewName?: string;
  /**
   * Slot identifier para persistência no Supabase Storage. Quando definido
   * (junto com `cargaId`), o tile dispara `uploadDraftFile` em background
   * após a validação client-side, e expõe o resultado via `onDraftPersisted`.
   * Best-effort: falha não bloqueia o fluxo do OCR.
   */
  slot?: string;
  /** ID da carga (obrigatório quando `slot` está definido). */
  cargaId?: string;
  /** CPF do motorista (usado como fallback público quando sem accessToken). */
  cpf?: string;
  /** Bearer token do motorista logado (preferido sobre cpf). */
  accessToken?: string | null;
  /**
   * Callback acionado quando o upload draft retorna sucesso. Pai usa para
   * persistir storage_path/signed_url no draft.
   */
  onDraftPersisted?: (result: DraftPersistResult) => void;
  /**
   * Marca o tile como "já guardado" (hidratação a partir do draft). Quando true,
   * exibe um pequeno indicador "guardado" ao lado de "Dados extraídos…" no
   * estado success.
   */
  draftPersisted?: boolean;
}

const DEFAULT_ACCEPT = "image/jpeg,image/png,image/heic,application/pdf";
const DEFAULT_MAX_SIZE_MB = 8;
// Bug-2: arquivos < 1KB sao quase sempre lixo (header truncado / placeholder
// gerado por bot) e o OCR backend nao consegue extrair nada deles.
const MIN_SIZE_BYTES = 1024;

// DC-195 — trava de qualidade: além de rejeitar lixo (< 1KB), exige um mínimo de
// resolução/tamanho para o OCR/IA conseguir ler (evita foto borrada/pequena).
// Imagem: maior lado >= 1000px. Todos: >= 20KB. HEIC não é decodificável no
// browser → cai só no floor de tamanho.
const MIN_IMAGE_LONG_SIDE_PX = 1000;
const MIN_QUALITY_BYTES = 20 * 1024;

// Magic numbers — protege contra arquivos renomeados com extensao mentirosa.
const MAGIC_NUMBERS: Array<{ mime: RegExp; bytes: number[] }> = [
  { mime: /^image\/jpeg$/i, bytes: [0xff, 0xd8, 0xff] },
  { mime: /^image\/png$/i, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: /^application\/pdf$/i, bytes: [0x25, 0x50, 0x44, 0x46] }, // "%PDF"
];

async function readFirstBytes(file: File, count: number): Promise<Uint8Array> {
  const slice = file.slice(0, count);
  const buf = await slice.arrayBuffer();
  return new Uint8Array(buf);
}

function magicNumberMatches(actual: Uint8Array, expected: number[]): boolean {
  if (actual.length < expected.length) return false;
  for (let i = 0; i < expected.length; i++) {
    if (actual[i] !== expected[i]) return false;
  }
  return true;
}

/**
 * Bug-2 P2: valida tipo real do arquivo lendo magic numbers em vez de confiar
 * so em `file.type`. Retorna null quando OK ou a mensagem de erro.
 *
 *  - tamanho < 1KB → "danificado"
 *  - PDF/JPEG/PNG: assinatura precisa bater
 *  - HEIC: aceito por MIME (formato ISO/BMFF varia — sem magic check)
 *  - outros MIMEs: rejeitados
 */
async function validateFileContent(file: File): Promise<string | null> {
  if (file.size < MIN_SIZE_BYTES) {
    return "Esse arquivo tá muito pequeno ou veio cortado. Tira outra foto.";
  }

  const mime = (file.type || "").toLowerCase();

  if (mime === "image/heic" || mime === "image/heif") {
    return null;
  }

  const expected = MAGIC_NUMBERS.find((m) => m.mime.test(mime));
  if (!expected) {
    const head = await readFirstBytes(file, 8);
    const matchesAny = MAGIC_NUMBERS.some((m) => magicNumberMatches(head, m.bytes));
    if (matchesAny) return null;
    return "Tipo de arquivo não aceito. Manda foto (JPG/PNG) ou PDF.";
  }

  const head = await readFirstBytes(file, expected.bytes.length);
  if (!magicNumberMatches(head, expected.bytes)) {
    return "Esse arquivo tá danificado. Tira outra foto ou escolhe outro PDF.";
  }
  return null;
}

/**
 * DC-195 — trava de qualidade. Rejeita arquivos de baixa qualidade (borrados/
 * pequenos demais para o OCR/IA). Retorna null quando OK ou a mensagem de erro.
 * Para imagens, mede a maior dimensão via createImageBitmap (HEIC não decodifica
 * no browser → cai só no floor de tamanho).
 */
async function getImageLongSide(file: File): Promise<number | null> {
  try {
    if (typeof createImageBitmap === "function") {
      const bmp = await createImageBitmap(file);
      const longSide = Math.max(bmp.width, bmp.height);
      bmp.close?.();
      return longSide;
    }
  } catch {
    /* browser não decodificou (ex.: HEIC) — pula a checagem de dimensão */
  }
  return null;
}

async function validateFileQuality(file: File): Promise<string | null> {
  const mime = (file.type || "").toLowerCase();
  const isPdf = mime === "application/pdf";
  if (file.size < MIN_QUALITY_BYTES) {
    return isPdf
      ? "Esse PDF está muito leve e pode estar ilegível. Gere um PDF de melhor qualidade ou tire uma foto nítida."
      : "Essa imagem está com qualidade muito baixa. Tire outra foto de perto, com boa luz e sem tremer.";
  }
  if (mime.startsWith("image/") && mime !== "image/heic" && mime !== "image/heif") {
    const longSide = await getImageLongSide(file);
    if (longSide != null && longSide < MIN_IMAGE_LONG_SIDE_PX) {
      return "Essa foto está pequena demais para o sistema ler. Fotografe o documento de perto, preenchendo a tela.";
    }
  }
  return null;
}

/**
 * Wrapper local — centralizamos a lógica de scrubbing em
 * `cadastroApi.humanizeOcrMessage` para que extractDetail (cadastroApi),
 * ocr*() e este tile compartilhem o mesmo filtro de jargão técnico.
 */
function humanizeOcrError(message?: string): string {
  return humanizeOcrMessage(message);
}

/**
 * Tile de upload para OCR com 4 estados visuais:
 *  - empty:     dashed border + Camera icon + label + helper. Tile inteiro e click target.
 *  - uploading: thumb + filename + spinner + "Extraindo dados do documento..."
 *  - success:   CheckCircle2 + OcrResultReview + botao "Trocar arquivo"
 *  - failure:   AlertCircle + admin-tint-danger banner + retry / fallback manual
 */
export function OcrUploadTile({
  accept = DEFAULT_ACCEPT,
  capture,
  maxSizeMb = DEFAULT_MAX_SIZE_MB,
  onFile,
  state,
  label,
  helper,
  extractedData,
  errorMessage,
  onRetry,
  onManualFallback,
  previewName,
  slot,
  cargaId,
  cpf,
  accessToken,
  onDraftPersisted,
  draftPersisted = false,
}: OcrUploadTileProps) {
  const inputId = useId();
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [sizeError, setSizeError] = useState<string | null>(null);
  const [localDraftPersisted, setLocalDraftPersisted] = useState<boolean>(false);

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const maxBytes = maxSizeMb * 1024 * 1024;
    if (file.size > maxBytes) {
      setSizeError(`Arquivo muito grande. Máximo ${maxSizeMb}MB. Tente outra foto.`);
      // Reset value para permitir reescolher o mesmo arquivo após correção
      event.target.value = "";
      return;
    }
    // Bug-2: valida conteudo real (magic number + tamanho minimo) antes de
    // chamar o pai. Evita que arquivo de 12 bytes ("PNG fake") suba pro OCR
    // e retorne sucesso ilusorio.
    const contentError = await validateFileContent(file);
    if (contentError) {
      setSizeError(contentError);
      event.target.value = "";
      return;
    }
    // DC-195 — trava de qualidade (resolução/tamanho mínimos) antes de aceitar.
    const qualityError = await validateFileQuality(file);
    if (qualityError) {
      setSizeError(qualityError);
      event.target.value = "";
      return;
    }
    setSizeError(null);
    setLocalDraftPersisted(false);
    onFile(file);
    // Reset para permitir re-upload do mesmo nome depois de "Trocar arquivo"
    event.target.value = "";

    // Best-effort persistência no Supabase Storage (draft files).
    // Dispara em paralelo ao OCR — não bloqueia o success state. Falha = toast
    // discreto + telemetria; o wizard continua funcionando normalmente.
    if (slot && cargaId) {
      void uploadDraftFile(file, slot, cargaId, { cpf, accessToken })
        .then((result) => {
          setLocalDraftPersisted(true);
          if (onDraftPersisted) {
            onDraftPersisted({
              slot: result.slot,
              storage_path: result.storage_path,
              signed_url: result.signed_url,
              filename: result.filename,
            });
          }
        })
        .catch((err) => {
          if (import.meta.env.DEV) {
            console.warn(`[OcrUploadTile/${slot}] draft upload failed`, err);
          }
          // Toast discreto — não usa "Erro" forte porque o motorista ainda pode
          // submeter o cadastro; o arquivo só não foi guardado pra próxima sessão.
          toast.message(
            "Não conseguimos guardar esse arquivo agora — refaça depois se precisar.",
          );
        });
    }
  };

  const showDraftBadge = draftPersisted || localDraftPersisted;

  const openCamera = () => {
    setSizeError(null);
    cameraInputRef.current?.click();
  };

  const openFilePicker = () => {
    setSizeError(null);
    fileInputRef.current?.click();
  };

  // Botão "Trocar arquivo" (states success/failure) re-abre o picker de
  // arquivos por padrão — motorista que já enviou geralmente quer trocar
  // por outra versão (galeria/PDF), não tirar foto nova.
  const reopenPicker = openFilePicker;

  // 19/05 — quando `capture` esta undefined (default em uploads de documento),
  // ocultamos a opcao "Tirar foto" e mostramos apenas o picker de arquivos.
  // Para selfie (A1bSelfie) o caller passa `capture="user"` e mantemos os dois
  // botoes — selfie pela camera continua viavel.
  const showCameraOption = Boolean(capture);

  return (
    <div className="space-y-3">
      {/* Input 1: câmera nativa (mobile). `capture` força camera; em desktop ignora. */}
      {showCameraOption ? (
        <input
          ref={cameraInputRef}
          id={`${inputId}-camera`}
          type="file"
          accept={accept}
          capture={capture}
          className="sr-only"
          onChange={handleFileChange}
          aria-label={`${label} (tirar foto)`}
        />
      ) : null}
      {/* Input 2: picker de arquivos (PDF/galeria/Drive). Sem `capture`. */}
      <input
        ref={fileInputRef}
        id={inputId}
        type="file"
        accept={accept}
        className="sr-only"
        onChange={handleFileChange}
        aria-label={`${label} (enviar arquivo)`}
      />

      {state === "empty" ? (
        <div
          className={cn(
            "admin-card-surface space-y-3 rounded-2xl border-2 border-dashed border-primary/30 px-4 py-4",
            "transition-colors focus-within:border-primary/60",
          )}
        >
          <div className="text-center">
            <p className="text-sm font-semibold text-foreground">{label}</p>
            {helper ? (
              <p className="mt-0.5 text-xs text-muted-foreground">{helper}</p>
            ) : null}
          </div>
          <div className={cn("grid gap-2", showCameraOption ? "grid-cols-2" : "grid-cols-1")}>
            {showCameraOption ? (
              <button
                type="button"
                onClick={openCamera}
                className={cn(
                  "flex min-h-[64px] flex-col items-center justify-center gap-1 rounded-xl",
                  "border border-primary/20 bg-primary/5 px-3 py-2 text-xs font-semibold text-foreground",
                  "transition-colors hover:bg-primary/10 hover:border-primary/40",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                )}
              >
                <Camera className="h-5 w-5 text-primary" aria-hidden="true" />
                Tirar foto
              </button>
            ) : null}
            <button
              type="button"
              onClick={openFilePicker}
              className={cn(
                "flex min-h-[64px] flex-col items-center justify-center gap-1 rounded-xl",
                "border border-primary/20 bg-primary/5 px-3 py-2 text-xs font-semibold text-foreground",
                "transition-colors hover:bg-primary/10 hover:border-primary/40",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
              )}
            >
              <FileUp className="h-5 w-5 text-primary" aria-hidden="true" />
              Enviar arquivo
            </button>
          </div>
          <p className="text-center text-xs text-muted-foreground">
            {showCameraOption
              ? `Aceita PDF ou foto (até ${maxSizeMb}MB)`
              : `Aceita PDF (até ${maxSizeMb}MB)`}
          </p>
        </div>
      ) : null}

      {state === "uploading" ? (
        <div
          className="admin-card-surface flex items-center gap-3 rounded-2xl border p-3.5"
          aria-live="polite"
          aria-atomic="true"
        >
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <FileText className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-foreground">
              {previewName ?? "Arquivo selecionado"}
            </p>
            <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              Extraindo dados do documento…
            </div>
          </div>
        </div>
      ) : null}

      {state === "success" ? (
        <div className="space-y-3">
          <div className="admin-card-surface flex items-center gap-3 rounded-2xl border p-3.5">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/15 text-accent">
              <CheckCircle2 className="h-5 w-5" aria-hidden="true" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-foreground">
                {previewName ?? "Arquivo enviado"}
              </p>
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span>Dados extraídos com sucesso.</span>
                {showDraftBadge ? (
                  <span
                    className="inline-flex items-center gap-0.5 text-emerald-600"
                    title="Arquivo guardado — você pode sair e voltar sem perder."
                  >
                    <CloudUpload className="h-3 w-3" aria-hidden="true" />
                    guardado
                  </span>
                ) : null}
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              type="button"
              onClick={reopenPicker}
              className="shrink-0"
            >
              Trocar arquivo
            </Button>
          </div>
          {extractedData && extractedData.length > 0 ? (
            <OcrResultReview fields={extractedData} onCorrectManually={onManualFallback} />
          ) : null}
        </div>
      ) : null}

      {state === "failure" ? (
        <div className="space-y-3">
          <div className="admin-card-surface flex items-center gap-3 rounded-2xl border p-3.5">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-destructive/10 text-destructive">
              <AlertCircle className="h-5 w-5" aria-hidden="true" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-foreground sm:text-base">
                {previewName ?? "Falha no processamento"}
              </p>
              <p className="text-sm text-foreground/80">
                Esse arquivo não deu certo.
              </p>
            </div>
          </div>
          <div className="admin-tint-danger rounded-2xl border p-4 text-base">
            <p className="text-sm font-semibold text-foreground sm:text-base">
              {humanizeOcrError(errorMessage)}
            </p>
            {/* 2026-05-21 Fase H.1: copy quebrada em 2 frases curtas, text-sm
                (em vez de text-xs), text-foreground/80 (em vez de muted) pra
                contraste em fundo danger. Motorista com baixa visão. */}
            <ul className="mt-2 space-y-1 text-sm text-foreground/80">
              <li>• Foto pode estar borrada ou documento cortado.</li>
              <li>• Tente outra foto com boa luz, ou digite os dados.</li>
            </ul>
            <div className="mt-4 flex flex-col gap-2 sm:flex-row">
              <Button
                type="button"
                onClick={onRetry}
                className="min-h-[44px] w-full sm:w-auto"
              >
                Tentar novamente
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={onManualFallback}
                className="min-h-[44px] w-full sm:w-auto"
              >
                Digitar manualmente
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {state === "manual" ? (
        <div className="admin-card-surface flex items-center gap-3 rounded-2xl border p-3.5">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
            <Pencil className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-foreground">Preenchimento manual</p>
            <p className="text-xs text-muted-foreground">Digite os dados abaixo.</p>
          </div>
        </div>
      ) : null}

      {sizeError ? (
        <p className="text-xs text-destructive" role="alert">
          {sizeError}
        </p>
      ) : null}
    </div>
  );
}
