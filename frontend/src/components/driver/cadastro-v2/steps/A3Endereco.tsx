import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { consultaCep, ocrComprovante } from "@/pages/cadastro/cadastroApi";

import { OcrUploadTile, type OcrTileState } from "../widgets/OcrUploadTile";
import type { OcrResultField } from "../widgets/OcrResultReview";
import { ProgressiveSection } from "../widgets/ProgressiveSection";

export interface A3Data {
  cep: string;
  numero: string;
  logradouro: string;
  bairro: string;
  cidade: string;
  uf: string;
  comprovanteUrl?: string;
}

export interface A3EnderecoProps {
  value?: A3Data;
  onChange: (data: A3Data) => void;
  onValid: (valid: boolean) => void;
  /** Quando true, força expansão da seção de logradouro/bairro (toggle StepA). */
  expandOptional?: boolean;
  /** Contexto p/ persistência no bucket `cadastro-drafts` (slot motorista_comprovante). */
  cargaId?: string;
  cpf?: string;
  accessToken?: string | null;
}

const EMPTY_DATA: A3Data = {
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

function buildExtractedFields(data: A3Data): OcrResultField[] {
  const fields: OcrResultField[] = [];
  if (data.cep) fields.push({ label: "CEP", value: data.cep });
  if (data.logradouro) fields.push({ label: "Logradouro", value: data.logradouro });
  if (data.bairro) fields.push({ label: "Bairro", value: data.bairro });
  if (data.cidade) fields.push({ label: "Cidade", value: data.cidade });
  if (data.uf) fields.push({ label: "UF", value: data.uf });
  return fields;
}


/**
 * Sub-etapa A3 — Endereco com 2 blocos:
 *  1) Upload do comprovante de residencia (EasyOCR via FastAPI) extrai SOMENTE
 *     CEP + numero da casa. Logradouro/bairro/cidade/UF sao resolvidos via
 *     ViaCEP (autoritativo) a partir do CEP — disparado automaticamente apos OCR.
 *  2) Fallback manual: usuario digita CEP -> ViaCEP preenche o resto.
 *
 * Numero pode vir do OCR ou ser digitado pelo usuario (sempre obrigatorio).
 */
export function A3Endereco({
  value,
  onChange,
  onValid,
  expandOptional,
  cargaId,
  cpf,
  accessToken,
}: A3EnderecoProps) {
  const [data, setData] = useState<A3Data>(value ?? EMPTY_DATA);
  const [tileState, setTileState] = useState<OcrTileState>(value?.comprovanteUrl ? "success" : "empty");
  const [previewName, setPreviewName] = useState<string | undefined>(undefined);
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);
  const [cepLookupLoading, setCepLookupLoading] = useState(false);
  const [cepLookupError, setCepLookupError] = useState<string | null>(null);
  const [ocrSuccess, setOcrSuccess] = useState(Boolean(value?.comprovanteUrl));

  const cepLookupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastLookedUpCepRef = useRef<string>("");

  // Sync externo → state interno. Roda no mount E quando o parent troca `value`
  // (ex.: hidratacao tardia via GET /api/candidatura/draft/me?cpf=XXX no F5
  // publico). Guard: so substitui quando os digits do CEP, numero ou outros
  // campos divergem do state atual — evita loop com onChange→setStepAData→novo ref.
  useEffect(() => {
    if (!value) return;
    const sameCep = digitsOnly(value.cep) === digitsOnly(data.cep);
    const sameNumero = (value.numero || "") === (data.numero || "");
    const sameLogradouro = (value.logradouro || "") === (data.logradouro || "");
    const sameBairro = (value.bairro || "") === (data.bairro || "");
    const sameCidade = (value.cidade || "") === (data.cidade || "");
    const sameUf = (value.uf || "") === (data.uf || "");
    const sameComprovante = (value.comprovanteUrl || "") === (data.comprovanteUrl || "");
    if (sameCep && sameNumero && sameLogradouro && sameBairro && sameCidade && sameUf && sameComprovante) {
      return;
    }
    setData(value);
    if (value.comprovanteUrl) {
      setTileState("success");
      setOcrSuccess(true);
    }
    // Auto-resolve ViaCEP quando o draft hidratou um CEP válido SEM cidade/UF
    // (race condition em fechamentos rápidos: flushAndClose dispara antes do
    // setTimeout 400ms do ViaCEP). Sem isso o motorista veria o CEP preenchido
    // mas os outros campos vazios após F5.
    const cepDigits = digitsOnly(value.cep);
    if (cepDigits.length === 8 && (!value.cidade || !value.uf)) {
      void lookupCep(cepDigits);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  useEffect(() => {
    onChange(data);
    const cepDigits = digitsOnly(data.cep);
    // Validity exige documento salvo (storage_path) + CEP + numero. Cidade/UF
    // vem do ViaCEP — se o CEP for valido a consulta preenche e a validacao
    // passa. OCR pode falhar sem bloquear o motorista; o que NAO pode falhar
    // e o upload do arquivo (comprovanteUrl). Sem ele a sub-etapa nao avanca.
    const hasComprovante = Boolean(data.comprovanteUrl);
    const valid =
      hasComprovante &&
      cepDigits.length === 8 &&
      data.numero.trim().length > 0 &&
      data.cidade.trim().length > 0 &&
      data.uf.trim().length > 0;
    onValid(valid);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  useEffect(() => {
    return () => {
      if (cepLookupTimerRef.current) clearTimeout(cepLookupTimerRef.current);
    };
  }, []);

  const updateData = (patch: Partial<A3Data>) => {
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
      setCepLookupError("CEP nao encontrado. Confira os digitos ou preencha manualmente.");
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
      // OCR de comprovante extrai SOMENTE cep+numero (contrato reduzido em 16/05).
      // Logradouro/bairro/cidade/UF vem do ViaCEP, autoritativo.
      const extracted = await ocrComprovante(file);
      const cepDigits = digitsOnly(extracted.cep);
      const formattedCep = cepDigits.length === 8 ? formatCep(cepDigits) : extracted.cep;
      const numero = extracted.numero || data.numero;
      const extractedSomething = cepDigits.length === 8 || (extracted.numero?.trim().length ?? 0) > 0;

      updateData({ cep: formattedCep, numero });
      if (cepDigits.length === 8) {
        // Sempre consulta ViaCEP — OCR nao traz mais logradouro/bairro/cidade/UF.
        // Nao pre-seta o ref aqui — lookupCep faz isso internamente apos rodar.
        void lookupCep(cepDigits);
      }

      // 2026-05-26 BUG fix — OCR pode "succeed" sem extrair nada útil (comprovante
      // ilegível, doc com layout não suportado). Antes setávamos ocrSuccess=true
      // sempre, mostrando "Dados extraídos com sucesso" com campos vazios — UX
      // enganosa: motorista achava que tinha funcionado e não preenchia manual.
      // Agora só marca success quando há CEP válido OU número, e instrui o
      // motorista quando precisamos do preenchimento manual.
      if (!extractedSomething) {
        setOcrSuccess(false);
        setTileState("success");
        toast.message(
          "Não conseguimos ler CEP nem número desse comprovante. Digite abaixo.",
        );
        return;
      }
      setOcrSuccess(true);
      setTileState("success");
    } catch (err) {
      // OCR falhou (foto borrada, doc cortado etc) — NAO bloqueia o motorista.
      // O arquivo continua sendo salvo em paralelo via uploadDraftFile do
      // OcrUploadTile (onDraftPersisted seta `comprovanteUrl`). O tile fica
      // em "success" pra mostrar que o documento foi recebido, e o motorista
      // pode digitar CEP + numero manualmente nos campos abaixo (cidade/UF
      // sao puxados via ViaCEP). A validacao da sub-etapa exige
      // `comprovanteUrl` — sem upload nao avanca.
      setOcrSuccess(false);
      setTileState("success");
      setErrorMessage(undefined);
      toast.message(
        "Não conseguimos ler o comprovante automaticamente. Digite CEP e número abaixo.",
      );
      if (import.meta.env.DEV) {
        console.warn("[A3Endereco] OCR comprovante falhou, fallback manual:", err);
      }
    }
  };

  const handleManualFallback = () => {
    setOcrSuccess(false);
    setTileState("empty");
    setErrorMessage(undefined);
  };

  const handleRetry = () => {
    setTileState("empty");
    setErrorMessage(undefined);
    setPreviewName(undefined);
  };

  const extractedFields = ocrSuccess ? buildExtractedFields(data) : [];

  return (
    <section className="space-y-4" aria-labelledby="step-a3-title">
      <header className="space-y-1">
        <h3 id="step-a3-title" className="text-base font-semibold text-foreground">
          Seu endereço
        </h3>
        <p className="text-sm text-muted-foreground">
          Envie um comprovante recente (foto ou arquivo) ou preencha manualmente.
        </p>
      </header>

      <OcrUploadTile
        accept="image/*,application/pdf"
        maxSizeMb={8}
        label="Comprovante de residência"
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
        slot="motorista_comprovante"
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
            <Label htmlFor="a3-cep">
              CEP <span className="text-destructive">*</span>
            </Label>
            <Input
              id="a3-cep"
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
            <Label htmlFor="a3-numero">
              Número <span className="text-destructive">*</span>
            </Label>
            <Input
              id="a3-numero"
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
            (data.logradouro.trim().length === 0 ||
              data.bairro.trim().length === 0)
          }
          forceExpanded={expandOptional}
        >
          <div className="space-y-1.5">
            <Label htmlFor="a3-logradouro">Logradouro</Label>
            <Input
              id="a3-logradouro"
              value={data.logradouro}
              onChange={(event) => updateData({ logradouro: event.target.value })}
              autoComplete="street-address"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="a3-bairro">Bairro</Label>
            <Input
              id="a3-bairro"
              value={data.bairro}
              onChange={(event) => updateData({ bairro: event.target.value })}
            />
          </div>
        </ProgressiveSection>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_120px]">
          <div className="space-y-1.5">
            <Label htmlFor="a3-cidade">
              Cidade <span className="text-destructive">*</span>
            </Label>
            <Input
              id="a3-cidade"
              value={data.cidade}
              onChange={(event) => updateData({ cidade: event.target.value })}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="a3-uf">
              UF <span className="text-destructive">*</span>
            </Label>
            <Input
              id="a3-uf"
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
