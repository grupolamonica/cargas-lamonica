import { memo, useState } from "react";

import { CheckCircle2, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { onlyDigits } from "@/lib/brazilianValidators";
import { ocrRntrc } from "@/services/cadastroApi";

import { StepHeader } from "../StepHeader";
import { BankSelector } from "../widgets/BankSelector";
import { OcrUploadTile, type OcrTileState } from "../widgets/OcrUploadTile";
import { OwnerDocumentUploader } from "../widgets/OwnerDocumentUploader";
import { OwnerEnderecoComprovante, type OwnerEnderecoData } from "../widgets/OwnerEnderecoComprovante";
import type { AnttTitularData, AnttTitularBank } from "../widgets/AnttTitularPrompt";
import type { StepCData } from "./StepCProprietarioCavalo";

/**
 * Step C-ANTT — Proprietário ANTT do cavalo.
 *
 * Fluxo redesenhado (2026-06-03):
 *   1. Motorista envia o documento RNTRC (foto/PDF).
 *   2. Vision API extrai CPF/CNPJ e nome do titular.
 *   3. Sistema compara automaticamente com o dono do CRLV:
 *      a) Mesmo proprietário → só coleta os dados que faltam:
 *         PIS/PASEP, estado civil, cor/raça e dados bancários.
 *      b) Proprietário diferente → coleta identidade completa:
 *         CNH/CNPJ do titular + endereço + PIS/banco.
 *
 * Elimina o radio button "É o mesmo dono?" — o RNTRC já diz.
 * Elimina duplicidade de CNH/endereço quando é o mesmo proprietário.
 */

const ESTADO_CIVIL_OPTIONS = [
  { value: "solteiro", label: "Solteiro(a)" },
  { value: "casado", label: "Casado(a)" },
  { value: "divorciado", label: "Divorciado(a)" },
  { value: "viuvo", label: "Viúvo(a)" },
  { value: "separado", label: "Separado(a)" },
  { value: "uniao_estavel", label: "União estável" },
];

const COR_RACA_OPTIONS = [
  { value: "branca", label: "Branca" },
  { value: "preta", label: "Preta" },
  { value: "parda", label: "Parda" },
  { value: "amarela", label: "Amarela" },
  { value: "indigena", label: "Indígena" },
  { value: "prefere_nao_declarar", label: "Prefere não declarar" },
];

export interface StepCAnttCavaloProps {
  currentStep: number;
  totalSteps: number;
  /** Dados atuais do Step C (anttTitular + storage paths restaurados do draft). */
  value: StepCData;
  /** CPF/CNPJ do proprietário do CRLV (digits only) — para comparar com o RNTRC. */
  ownerDocFromCrlv: string;
  /** Nome do proprietário do CRLV. */
  ownerNomeFromCrlv?: string;
  onChange?: (data: StepCData) => void;
  onComplete: (data: StepCData) => void;
  onBack: () => void;
  cargaId?: string;
  cpf?: string;
  accessToken?: string | null;
}

function maskDoc(value: string): string {
  const digits = onlyDigits(value);
  if (digits.length <= 11) {
    return digits
      .replace(/^(\d{3})(\d)/, "$1.$2")
      .replace(/^(\d{3})\.(\d{3})(\d)/, "$1.$2.$3")
      .replace(/\.(\d{3})(\d)/, ".$1-$2")
      .slice(0, 14);
  }
  return digits
    .replace(/^(\d{2})(\d)/, "$1.$2")
    .replace(/^(\d{2})\.(\d{3})(\d)/, "$1.$2.$3")
    .replace(/\.(\d{3})(\d)/, ".$1/$2")
    .replace(/(\d{4})(\d)/, "$1-$2")
    .slice(0, 18);
}

function StepCAnttCavaloImpl({
  currentStep,
  totalSteps,
  value,
  ownerDocFromCrlv,
  ownerNomeFromCrlv,
  onChange,
  onComplete,
  onBack,
  cargaId,
  cpf,
  accessToken,
}: StepCAnttCavaloProps) {
  // ─── RNTRC upload ────────────────────────────────────────────────────────────
  const [rntrcTileState, setRntrcTileState] = useState<OcrTileState>(() =>
    value.anttTitular?.doc ? "success" : "empty",
  );
  const [rntrcFileName, setRntrcFileName] = useState<string | undefined>();
  const [rntrcOcrError, setRntrcOcrError] = useState<string | undefined>();

  // Dados extraídos do RNTRC via OCR (ou restaurados do draft).
  const [rntrcExtracted, setRntrcExtracted] = useState<{
    doc: string;
    nome: string;
    tipo: "pf" | "pj";
    rntrc?: string;
  } | null>(() => {
    if (value.anttTitular?.doc) {
      return {
        doc: value.anttTitular.doc,
        nome: value.anttTitular.nome ?? "",
        tipo: value.anttTitular.tipo ?? "pf",
        rntrc: value.anttTitular.rntrc,
      };
    }
    return null;
  });

  // isSameAsOwner: null = RNTRC não enviado ainda; true/false = comparação feita.
  const isSameAsOwner =
    rntrcExtracted !== null
      ? onlyDigits(rntrcExtracted.doc) === onlyDigits(ownerDocFromCrlv)
      : null;
  const anttIsPJ = rntrcExtracted?.tipo === "pj";

  // ─── Campos sociais (PF titular cavalo) ─────────────────────────────────────
  const [pis, setPis] = useState(value.anttTitular?.pis ?? "");
  const [estadoCivil, setEstadoCivil] = useState(
    value.anttTitular?.estado_civil ?? "",
  );
  const [corRaca, setCorRaca] = useState(value.anttTitular?.cor_raca ?? "");

  // ─── Dados bancários ─────────────────────────────────────────────────────────
  const [banco, setBanco] = useState<AnttTitularBank>(
    value.anttTitular?.banco ?? { bank: null, agencia: "", conta: "", tipo: "" },
  );

  // ─── Dados do titular diferente ─────────────────────────────────────────────
  const [anttOwnerDocPath, setAnttOwnerDocPath] = useState<string | undefined>(
    value.anttTitular?.anttOwnerDocStoragePath,
  );
  const [enderecoAnttOwner, setEnderecoAnttOwner] = useState<OwnerEnderecoData>(() => ({
    cep: value.anttTitular?.endereco?.cep ?? "",
    numero: value.anttTitular?.endereco?.numero ?? "",
    logradouro: value.anttTitular?.endereco?.logradouro ?? "",
    bairro: value.anttTitular?.endereco?.bairro ?? "",
    cidade: value.anttTitular?.endereco?.cidade ?? "",
    uf: value.anttTitular?.endereco?.uf ?? "",
    comprovanteUrl: value.anttTitular?.endereco?.comprovanteUrl,
    ocr_comprovante_fallback_manual:
      value.anttTitular?.endereco?.ocr_comprovante_fallback_manual,
  }));

  // ─── OCR handler ─────────────────────────────────────────────────────────────
  const handleRntrcFile = async (file: File) => {
    setRntrcFileName(file.name);
    setRntrcTileState("uploading");
    setRntrcOcrError(undefined);
    try {
      const extracted = await ocrRntrc(file, cargaId);
      const doc = onlyDigits(extracted.documento ?? "");
      const nome = extracted.nome ?? "";
      const tipo: "pf" | "pj" = extracted.tipo === "PJ" ? "pj" : "pf";
      const rntrc = extracted.rntrc || undefined;
      setRntrcExtracted({ doc, nome, tipo, rntrc });
      setRntrcTileState("success");
      // Propaga para draft imediatamente.
      emitOnChange({ doc, nome, tipo, rntrc });
    } catch (err) {
      setRntrcTileState("failure");
      setRntrcOcrError(
        err instanceof Error
          ? err.message
          : "Não conseguimos ler o RNTRC. Tente novamente ou preencha manualmente.",
      );
    }
  };

  // ─── Helpers ─────────────────────────────────────────────────────────────────
  const buildAnttTitular = (
    overrideExtracted?: typeof rntrcExtracted,
  ): AnttTitularData | null => {
    const ex = overrideExtracted ?? rntrcExtracted;
    if (!ex) return null;
    const base: AnttTitularData = {
      tipo: ex.tipo,
      doc: ex.doc,
      nome: ex.nome,
      rntrc: ex.rntrc,
      pis: pis || undefined,
      estado_civil: estadoCivil || undefined,
      cor_raca: corRaca || undefined,
      banco: banco.bank ? banco : undefined,
    };
    if (isSameAsOwner === false) {
      base.anttOwnerDocStoragePath = anttOwnerDocPath;
      base.endereco = {
        cep: enderecoAnttOwner.cep,
        numero: enderecoAnttOwner.numero,
        logradouro: enderecoAnttOwner.logradouro,
        bairro: enderecoAnttOwner.bairro,
        cidade: enderecoAnttOwner.cidade,
        uf: enderecoAnttOwner.uf,
        comprovanteUrl: enderecoAnttOwner.comprovanteUrl,
        ocr_comprovante_fallback_manual:
          enderecoAnttOwner.ocr_comprovante_fallback_manual,
      };
    }
    return base;
  };

  const emitOnChange = (overrideExtracted?: typeof rntrcExtracted) => {
    if (!onChange) return;
    const anttTitular = buildAnttTitular(overrideExtracted);
    onChange({ ...value, anttTitular: anttTitular ?? undefined });
  };

  // ─── Validação ───────────────────────────────────────────────────────────────
  const socialComplete =
    anttIsPJ ||
    (pis.replace(/\D/g, "").length >= 11 &&
      !!estadoCivil.trim() &&
      !!corRaca.trim());

  const bankComplete =
    !!banco.bank &&
    (banco.agencia ?? "").trim().length > 0 &&
    (banco.conta ?? "").trim().length > 0 &&
    !!banco.tipo;

  const differentOwnerComplete =
    isSameAsOwner !== false ||
    (!!anttOwnerDocPath &&
      enderecoAnttOwner.cep.replace(/\D/g, "").length === 8 &&
      !!enderecoAnttOwner.numero.trim() &&
      !!enderecoAnttOwner.cidade.trim() &&
      !!enderecoAnttOwner.uf.trim() &&
      (anttIsPJ ? true : !!enderecoAnttOwner.comprovanteUrl));

  const canContinue =
    isSameAsOwner !== null && // RNTRC enviado
    differentOwnerComplete &&
    socialComplete &&
    bankComplete;

  const handleContinue = () => {
    if (!canContinue) return;
    const anttTitular = buildAnttTitular();
    onComplete({ ...value, anttTitular: anttTitular ?? undefined });
  };

  // ─── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      <StepHeader
        eyebrow={`ETAPA ${currentStep} DE ${totalSteps}`}
        title="Proprietário ANTT do cavalo"
        description="Quem detém o RNTRC do cavalo — é quem a Lamônica paga o frete."
        currentStep={currentStep}
        totalSteps={totalSteps}
      />

      {/* ── Card 1: Documento RNTRC ─────────────────────────────────── */}
      <div className="space-y-3 rounded-2xl border border-border bg-card p-4">
        <div>
          <h3 className="text-base font-semibold text-foreground">
            Documento RNTRC
          </h3>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Envie o documento RNTRC (Registro Nacional de Transportadores).
            Vamos identificar o titular automaticamente.
          </p>
        </div>

        <OcrUploadTile
          accept="image/*,application/pdf"
          maxSizeMb={8}
          label="Documento RNTRC / ANTT"
          helper="Comprovante de inscrição no RNTRC (PDF ou foto)"
          state={rntrcTileState}
          previewName={rntrcFileName}
          errorMessage={rntrcOcrError}
          onFile={(file) => { void handleRntrcFile(file); }}
          onRetry={() => {
            setRntrcTileState("empty");
            setRntrcFileName(undefined);
            setRntrcOcrError(undefined);
            setRntrcExtracted(null);
          }}
          onManualFallback={() => {
            setRntrcTileState("manual");
            setRntrcOcrError(undefined);
          }}
          slot="cavalo_antt"
          cargaId={cargaId}
          cpf={cpf}
          accessToken={accessToken}
        />

        {/* Resultado da extração */}
        {isSameAsOwner === true && rntrcExtracted && (
          <div className="flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3 dark:border-emerald-800 dark:bg-emerald-950">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
            <p className="text-sm text-emerald-800 dark:text-emerald-200">
              <strong>Confirmado:</strong>{" "}
              {rntrcExtracted.nome || maskDoc(rntrcExtracted.doc)} é o titular do
              RNTRC — o mesmo proprietário do CRLV.
            </p>
          </div>
        )}
        {isSameAsOwner === false && rntrcExtracted && (
          <div className="flex items-start gap-2 rounded-xl border border-blue-200 bg-blue-50 p-3 dark:border-blue-800 dark:bg-blue-950">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400" />
            <p className="text-sm text-blue-800 dark:text-blue-200">
              RNTRC em nome de{" "}
              <strong>
                {rntrcExtracted.nome || maskDoc(rntrcExtracted.doc)}
              </strong>{" "}
              ({rntrcExtracted.tipo === "pj" ? "CNPJ" : "CPF"}{" "}
              {maskDoc(rntrcExtracted.doc)}) — diferente do proprietário do CRLV.
              Precisamos de mais alguns dados.
            </p>
          </div>
        )}
      </div>

      {/* ── Card 2: Documento de identidade (só se titular diferente) ─ */}
      {isSameAsOwner === false && (
        <div className="space-y-3 rounded-2xl border border-border bg-card p-4">
          <div>
            <h3 className="text-base font-semibold text-foreground">
              Documento do titular do RNTRC
            </h3>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {rntrcExtracted?.tipo === "pj"
                ? "Envie o cartão CNPJ do titular."
                : "Envie a CNH do titular do RNTRC."}
            </p>
          </div>
          <OwnerDocumentUploader
            key="antt-doc-different"
            ownerDocType={rntrcExtracted?.tipo === "pj" ? "cnpj" : "cpf"}
            expectedDocument={onlyDigits(rntrcExtracted?.doc ?? "")}
            onExtracted={(extracted) => {
              // Corrige nome se OCR confirmou
              if (extracted.nome && rntrcExtracted) {
                setRntrcExtracted((prev) =>
                  prev ? { ...prev, nome: extracted.nome ?? prev.nome } : prev,
                );
              }
            }}
            slot="cavalo_antt_owner_cnh"
            cargaId={cargaId}
            cpf={cpf}
            accessToken={accessToken}
            onDraftPersisted={(storagePath) => {
              setAnttOwnerDocPath(storagePath);
              emitOnChange();
            }}
            draftPersisted={Boolean(anttOwnerDocPath)}
          />
        </div>
      )}

      {/* ── Card 3: Endereço do titular (só se titular diferente e PF) ─ */}
      {isSameAsOwner === false && (
        <div className="rounded-2xl border border-border bg-card p-4">
          <OwnerEnderecoComprovante
            idPrefix="step-c-antt-owner-end"
            slot="cavalo_antt_owner_comprovante"
            title="Endereço do titular ANTT"
            description="Conta de luz/água/internet — últimos 3 meses."
            requireComprovante={!anttIsPJ}
            value={enderecoAnttOwner}
            onChange={(data) => {
              setEnderecoAnttOwner(data);
              emitOnChange();
            }}
            cargaId={cargaId}
            cpf={cpf}
            accessToken={accessToken}
          />
        </div>
      )}

      {/* ── Card 4: PIS / estado civil / cor/raça / banco ───────────── */}
      {isSameAsOwner !== null && (
        <div className="space-y-4 rounded-2xl border border-border bg-card p-4">
          <div>
            <h3 className="text-base font-semibold text-foreground">
              Dados para pagamento e registro
            </h3>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Necessários para emissão de nota, pagamento e conformidade
              trabalhista.
            </p>
          </div>

          {/* Campos sociais — só PF */}
          {!anttIsPJ && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="antt-pis">PIS / PASEP</Label>
                <Input
                  id="antt-pis"
                  inputMode="numeric"
                  value={pis}
                  onChange={(e) => {
                    const v = onlyDigits(e.target.value).slice(0, 11);
                    setPis(v);
                    emitOnChange();
                  }}
                  className="h-12"
                  placeholder="11 dígitos"
                  maxLength={11}
                />
              </div>

              <div className="space-y-1">
                <Label htmlFor="antt-civil">Estado civil</Label>
                <Select
                  value={estadoCivil}
                  onValueChange={(v) => {
                    setEstadoCivil(v);
                    emitOnChange();
                  }}
                >
                  <SelectTrigger id="antt-civil" className="h-12">
                    <SelectValue placeholder="Selecione" />
                  </SelectTrigger>
                  <SelectContent>
                    {ESTADO_CIVIL_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor="antt-raca">Cor / raça</Label>
                <Select
                  value={corRaca}
                  onValueChange={(v) => {
                    setCorRaca(v);
                    emitOnChange();
                  }}
                >
                  <SelectTrigger id="antt-raca" className="h-12">
                    <SelectValue placeholder="Selecione" />
                  </SelectTrigger>
                  <SelectContent>
                    {COR_RACA_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}

          {/* Banco */}
          <div className="space-y-2">
            <Label>Banco para pagamento</Label>
            <p className="text-xs text-muted-foreground">
              Conta para onde a Lamônica deposita o frete.
            </p>
            <BankSelector
              value={banco.bank ?? null}
              onChange={(bank) => {
                setBanco((prev) => ({ ...prev, bank }));
                emitOnChange();
              }}
            />
            {banco.bank ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div className="space-y-1">
                  <Label htmlFor="antt-agencia">Agência</Label>
                  <Input
                    id="antt-agencia"
                    value={banco.agencia}
                    onChange={(e) => {
                      setBanco((prev) => ({ ...prev, agencia: e.target.value }));
                      emitOnChange();
                    }}
                    className="h-12"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="antt-conta">Conta</Label>
                  <Input
                    id="antt-conta"
                    value={banco.conta}
                    onChange={(e) => {
                      setBanco((prev) => ({ ...prev, conta: e.target.value }));
                      emitOnChange();
                    }}
                    className="h-12"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="antt-tipo-conta">Tipo</Label>
                  <Select
                    value={banco.tipo || ""}
                    onValueChange={(v) => {
                      setBanco((prev) => ({
                        ...prev,
                        tipo: v as AnttTitularBank["tipo"],
                      }));
                      emitOnChange();
                    }}
                  >
                    <SelectTrigger id="antt-tipo-conta" className="h-12">
                      <SelectValue placeholder="Tipo de conta" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="corrente">Conta corrente</SelectItem>
                      <SelectItem value="poupanca">Conta poupança</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            ) : null}
          </div>

          {/* Indicador de completude */}
          {canContinue ? (
            <p className="text-xs text-emerald-700 dark:text-emerald-300">
              ✓ Dados do titular ANTT confirmados.
            </p>
          ) : !bankComplete ? (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              Preencha os dados bancários para continuar.
            </p>
          ) : !socialComplete ? (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              Preencha PIS, estado civil e cor/raça para continuar.
            </p>
          ) : null}
        </div>
      )}

      {/* ── Rodapé ──────────────────────────────────────────────────── */}
      <div className="flex flex-col-reverse items-stretch gap-2 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
        <Button type="button" variant="ghost" onClick={onBack} className="sm:w-auto">
          Voltar
        </Button>
        <Button
          type="button"
          variant="cta"
          onClick={handleContinue}
          aria-disabled={!canContinue}
          disabled={!canContinue}
          className="py-3.5 sm:w-auto sm:py-2.5"
        >
          Continuar
        </Button>
      </div>
    </div>
  );
}

export const StepCAnttCavalo = memo(StepCAnttCavaloImpl);
