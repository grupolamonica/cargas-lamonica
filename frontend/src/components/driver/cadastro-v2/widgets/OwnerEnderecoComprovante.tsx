import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { consultaCep, ocrComprovante } from "@/pages/cadastro/cadastroApi";

import { OcrUploadTile, type OcrTileState } from "./OcrUploadTile";
import type { OcrResultField } from "./OcrResultReview";
import { ProgressiveSection } from "./ProgressiveSection";

/**
 * Versão reutilizável do A3Endereco (motorista) para coletar o endereço dos
 * proprietários (cavalo, carreta, ANTT titular). Espelha o mesmo pipeline:
 *   1) Upload + OCR `ocrComprovante` extrai CEP + número.
 *   2) ViaCEP autopopula logradouro/bairro/cidade/UF.
 *   3) Fallback manual quando o OCR falha — campos editáveis, toast informativo.
 *
 * Diferenças face ao A3 original:
 *   - `slot` configurável (recebe slots de owners + ANTT titular).
 *   - `idPrefix` para evitar colisão de `id` no DOM quando múltiplas instâncias
 *     do widget convivem na mesma tela (ex.: dono cavalo + dono ANTT cavalo).
 *   - Inclui `ocr_comprovante_fallback_manual` no `OwnerEnderecoData`.
 *
 * Validade: igual ao A3 — sub-etapa só avança se `comprovanteUrl` (arquivo
 * salvo no Supabase Storage) + CEP válido + número estiverem preenchidos.
 */

export interface OwnerEnderecoData {
  cep: string;
  numero: string;
  logradouro: string;
  bairro: string;
  cidade: string;
  uf: string;
  comprovanteUrl?: string;
  ocr_comprovante_fallback_manual?: boolean;
}

export interface OwnerEnderecoComprovanteProps {
  value?: OwnerEnderecoData;
  onChange: (data: OwnerEnderecoData) => void;
  onValid?: (valid: boolean) => void;
  /** Slot do bucket cadastro-drafts (ex.: cavalo_owner_comprovante). */
  slot:
    | "cavalo_owner_comprovante"
    | "carreta_owner_comprovante_0"
    | "carreta_owner_comprovante_1"
    | "cavalo_antt_owner_comprovante"
    | "carreta_antt_owner_comprovante_0"
    | "carreta_antt_owner_comprovante_1";
  /** Identificador único pra DOM ids. Evita colisão entre múltiplos widgets. */
  idPrefix: string;
  /** Título da sub-seção (ex.: "Endereço do proprietário do cavalo"). */
  title?: string;
  description?: string;
  cargaId?: string;
  cpf?: string;
  accessToken?: string | null;
  expandOptional?: boolean;
  /**
   * 2026-05-26 — Comprovante de residência só é obrigatório para proprietário
   * PF. Para PJ (CNPJ), a consulta Infosimples (cartão CNPJ) já traz o
   * endereço cadastral — não faz sentido exigir conta de luz. Quando false,
   * o tile de upload vira opcional e a validade não exige `comprovanteUrl`
   * (apenas CEP + número + cidade + UF). Default true (compat. PF).
   */
  requireComprovante?: boolean;
}

const EMPTY_DATA: OwnerEnderecoData = {
  cep: "",
  numero: "",
  logradouro: "",
  bairro: "",
  cidade: "",
  uf: "",
};

function formatCep(value: string) {
  const digits = value.replace(/\D/g, "").slice(0, 8);
  if (digits.length <= 5) return digits;
  return `${digits.slice(0, 5)}-${digits.slice(5)}`;
}

function digitsOnly(value: string): string {
  return value.replace(/\D/g, "");
}

function buildExtractedFields(data: OwnerEnderecoData): OcrResultField[] {
  const fields: OcrResultField[] = [];
  if (data.cep) fields.push({ label: "CEP", value: data.cep });
  if (data.logradouro) fields.push({ label: "Logradouro", value: data.logradouro });
  if (data.bairro) fields.push({ label: "Bairro", value: data.bairro });
  if (data.cidade) fields.push({ label: "Cidade", value: data.cidade });
  if (data.uf) fields.push({ label: "UF", value: data.uf });
  return fields;
}

export function OwnerEnderecoComprovante({
  value,
  onChange,
  onValid,
  slot,
  idPrefix,
  title = "Endereço do proprietário",
  description = "Envie um comprovante recente (foto ou arquivo) ou preencha manualmente.",
  cargaId,
  cpf,
  accessToken,
  expandOptional,
  requireComprovante = true,
}: OwnerEnderecoComprovanteProps) {
  const [data, setData] = useState<OwnerEnderecoData>(value ?? EMPTY_DATA);
  const [tileState, setTileState] = useState<OcrTileState>(
    value?.comprovanteUrl ? "success" : "empty",
  );
  const [previewName, setPreviewName] = useState<string | undefined>(undefined);
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);
  const [cepLookupLoading, setCepLookupLoading] = useState(false);
  const [cepLookupError, setCepLookupError] = useState<string | null>(null);
  const [ocrSuccess, setOcrSuccess] = useState(Boolean(value?.comprovanteUrl));

  const cepLookupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastLookedUpCepRef = useRef<string>("");

  // Hidratação tardia (F5 público): sincroniza `data` quando o parent troca
  // `value` (depois do mount). Mesmo padrão do A3Endereco. Guard por
  // digit-equality evita loop com onChange.
  useEffect(() => {
    if (!value) return;
    const sameCep = digitsOnly(value.cep) === digitsOnly(data.cep);
    const sameNumero = (value.numero || "") === (data.numero || "");
    const sameLogradouro = (value.logradouro || "") === (data.logradouro || "");
    const sameBairro = (value.bairro || "") === (data.bairro || "");
    const sameCidade = (value.cidade || "") === (data.cidade || "");
    const sameUf = (value.uf || "") === (data.uf || "");
    const sameComprovante = (value.comprovanteUrl || "") === (data.comprovanteUrl || "");
    if (
      sameCep &&
      sameNumero &&
      sameLogradouro &&
      sameBairro &&
      sameCidade &&
      sameUf &&
      sameComprovante
    ) {
      return;
    }
    setData(value);
    if (value.comprovanteUrl) {
      setTileState("success");
      setOcrSuccess(true);
    }
    // Auto-resolve ViaCEP em hidratação quando o CEP veio sem cidade/UF
    // (race do flushAndClose vs setTimeout do ViaCEP).
    const cepDigits = digitsOnly(value.cep);
    if (cepDigits.length === 8 && (!value.cidade || !value.uf)) {
      void lookupCep(cepDigits);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  useEffect(() => {
    onChange(data);
    const cepDigits = digitsOnly(data.cep);
    // Validity: CEP + número + cidade + UF sempre exigidos. Comprovante só
    // obrigatório quando requireComprovante (PF) — para PJ o endereço vem do
    // cartão CNPJ (Infosimples), sem necessidade de conta de luz.
    const hasComprovante = Boolean(data.comprovanteUrl);
    const enderecoOk =
      cepDigits.length === 8 &&
      data.numero.trim().length > 0 &&
      data.cidade.trim().length > 0 &&
      data.uf.trim().length > 0;
    const valid = enderecoOk && (requireComprovante ? hasComprovante : true);
    if (onValid) onValid(valid);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, requireComprovante]);

  useEffect(() => {
    return () => {
      if (cepLookupTimerRef.current) clearTimeout(cepLookupTimerRef.current);
    };
  }, []);

  const updateData = (patch: Partial<OwnerEnderecoData>) => {
    setData((current) => ({ ...current, ...patch }));
  };

  const lookupCep = async (rawCep: string) => {
    const digits = digitsOnly(rawCep);
    if (digits.length !== 8) return;
    if (digits === lastLookedUpCepRef.current) return;
    lastLookedUpCepRef.current = digits;
    setCepLookupLoading(true);
    setCepLookupError(null);
    try {
      const result = await consultaCep(digits);
      updateData({
        logradouro: result.logradouro || "",
        bairro: result.bairro || "",
        cidade: result.cidade || "",
        uf: (result.uf || "").toUpperCase(),
      });
    } catch {
      setCepLookupError(
        "CEP não encontrado. Confira os dígitos ou preencha manualmente.",
      );
    } finally {
      setCepLookupLoading(false);
    }
  };

  const handleCepChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const masked = formatCep(event.target.value);
    updateData({ cep: masked });
    if (cepLookupTimerRef.current) clearTimeout(cepLookupTimerRef.current);
    const digits = digitsOnly(masked);
    if (digits.length === 8) {
      cepLookupTimerRef.current = setTimeout(() => {
        void lookupCep(masked);
      }, 400);
    } else {
      lastLookedUpCepRef.current = "";
    }
  };

  const handleFile = async (file: File) => {
    setPreviewName(file.name);
    setTileState("uploading");
    setErrorMessage(undefined);
    try {
      const extracted = await ocrComprovante(file);
      const cepDigits = digitsOnly(extracted.cep);
      const formattedCep =
        cepDigits.length === 8 ? formatCep(cepDigits) : extracted.cep;
      const numero = extracted.numero || data.numero;
      updateData({ cep: formattedCep, numero, ocr_comprovante_fallback_manual: false });
      if (cepDigits.length === 8) {
        void lookupCep(cepDigits);
      }
      setOcrSuccess(true);
      setTileState("success");
    } catch (err) {
      // OCR falhou — mesmo comportamento do A3: tile fica "success" porque o
      // upload em background segue salvando, motorista digita CEP+número.
      setOcrSuccess(false);
      setTileState("success");
      setErrorMessage(undefined);
      updateData({ ocr_comprovante_fallback_manual: true });
      toast.message(
        "Não conseguimos ler o comprovante automaticamente. Digite CEP e número abaixo.",
      );
      if (import.meta.env.DEV) {
        console.warn(
          `[OwnerEnderecoComprovante/${slot}] OCR falhou, fallback manual:`,
          err,
        );
      }
    }
  };

  const handleManualFallback = () => {
    setOcrSuccess(false);
    setTileState("empty");
    setErrorMessage(undefined);
    updateData({ ocr_comprovante_fallback_manual: true });
  };

  const handleRetry = () => {
    setTileState("empty");
    setErrorMessage(undefined);
    setPreviewName(undefined);
  };

  const extractedFields = ocrSuccess ? buildExtractedFields(data) : [];
  const headingId = `${idPrefix}-title`;

  return (
    <section className="space-y-4" aria-labelledby={headingId}>
      <header className="space-y-1">
        <h3 id={headingId} className="text-base font-semibold text-foreground">
          {title}
        </h3>
        <p className="text-sm text-muted-foreground">
          {requireComprovante
            ? description
            : "Endereço preenchido pelo Cartão CNPJ. Confira abaixo (anexar comprovante é opcional)."}
        </p>
      </header>

      <OcrUploadTile
        accept="image/*,application/pdf"
        maxSizeMb={8}
        label={
          requireComprovante
            ? "Comprovante de residência"
            : "Comprovante de endereço (opcional)"
        }
        helper="Conta de luz, água, internet ou similar — últimos 3 meses"
        state={tileState}
        previewName={previewName}
        extractedData={tileState === "success" ? extractedFields : undefined}
        errorMessage={errorMessage}
        onFile={(file) => {
          void handleFile(file);
        }}
        onRetry={handleRetry}
        onManualFallback={handleManualFallback}
        slot={slot}
        cargaId={cargaId}
        cpf={cpf}
        accessToken={accessToken}
        onDraftPersisted={(result) => {
          setData((current) => ({ ...current, comprovanteUrl: result.storage_path }));
        }}
        draftPersisted={Boolean(value?.comprovanteUrl || data.comprovanteUrl)}
      />

      <div className="space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor={`${idPrefix}-cep`}>
              CEP <span className="text-destructive">*</span>
            </Label>
            <Input
              id={`${idPrefix}-cep`}
              inputMode="numeric"
              value={data.cep}
              onChange={handleCepChange}
              placeholder="00000-000"
              autoComplete="postal-code"
              required
            />
            {cepLookupLoading ? (
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                Buscando endereço...
              </p>
            ) : null}
            {cepLookupError ? (
              <p className="text-xs text-destructive">{cepLookupError}</p>
            ) : null}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${idPrefix}-numero`}>
              Número <span className="text-destructive">*</span>
            </Label>
            <Input
              id={`${idPrefix}-numero`}
              inputMode="numeric"
              value={data.numero}
              onChange={(event) => updateData({ numero: event.target.value })}
              required
            />
          </div>
        </div>
        <ProgressiveSection
          title="Logradouro e bairro"
          description="Preenchemos a partir do CEP. Mostre se quiser conferir."
          defaultExpanded={
            digitsOnly(data.cep).length === 8 &&
            (data.logradouro.trim().length === 0 || data.bairro.trim().length === 0)
          }
          forceExpanded={expandOptional}
        >
          <div className="space-y-1.5">
            <Label htmlFor={`${idPrefix}-logradouro`}>Logradouro</Label>
            <Input
              id={`${idPrefix}-logradouro`}
              value={data.logradouro}
              onChange={(event) => updateData({ logradouro: event.target.value })}
              autoComplete="street-address"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${idPrefix}-bairro`}>Bairro</Label>
            <Input
              id={`${idPrefix}-bairro`}
              value={data.bairro}
              onChange={(event) => updateData({ bairro: event.target.value })}
            />
          </div>
        </ProgressiveSection>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_120px]">
          <div className="space-y-1.5">
            <Label htmlFor={`${idPrefix}-cidade`}>
              Cidade <span className="text-destructive">*</span>
            </Label>
            <Input
              id={`${idPrefix}-cidade`}
              value={data.cidade}
              onChange={(event) => updateData({ cidade: event.target.value })}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${idPrefix}-uf`}>
              UF <span className="text-destructive">*</span>
            </Label>
            <Input
              id={`${idPrefix}-uf`}
              value={data.uf}
              onChange={(event) =>
                updateData({ uf: event.target.value.toUpperCase().slice(0, 2) })
              }
              maxLength={2}
              required
            />
          </div>
        </div>
      </div>
    </section>
  );
}
