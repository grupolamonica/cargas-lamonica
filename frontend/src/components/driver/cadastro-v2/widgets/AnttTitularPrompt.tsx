import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DriverAlert } from "@/components/driver/ui";
import {
  isValidBrazilianPhone,
  isValidCnpj,
  isValidCpf,
  onlyDigits,
} from "@/lib/brazilianValidators";
import type { BrazilianBank } from "@/lib/brazilianBanks";
import { ocrRntrc } from "@/services/cadastroApi";

import { ProgressiveSection } from "./ProgressiveSection";
import { BankSelector } from "./BankSelector";
import { OcrUploadTile, type OcrTileState } from "./OcrUploadTile";
import { OwnerDocumentUploader } from "./OwnerDocumentUploader";

/**
 * FEAT-ANTT-TITULAR — captura do titular do RNTRC (cavalo ou carreta).
 *
 * Decisão 2026-05-18 (refator): o componente AGORA pergunta SEMPRE pelo
 * proprietario do RNTRC, mesmo quando o cascade ANTT confirma que titular ==
 * owner CRLV. Motivo: Lamonica precisa do registro explicito do detentor do
 * RNTRC para fins legais/operacionais — nao basta inferir.
 *
 * Três cenários de UI:
 *   A) Cascade SUCEDEU + `titular_doc === ownerDoc` → toggle radio
 *      "É o mesmo proprietário do CRLV" (default) vs "Outra pessoa é o titular".
 *      - Default: emite onChange com `{ tipo, doc: ownerDoc, nome: ownerNome }`,
 *        sem renderizar form (motorista nao toca em nada).
 *      - "Outra pessoa": expande mini-form em branco.
 *   B) Cascade SUCEDEU + `titular_doc !== ownerDoc` → DriverAlert info + mini-form
 *      pre-preenchido com cascade.titular_doc/nome (comportamento anterior).
 *   C) Cascade NAO RODOU ou retornou sem titular_doc → aviso "Não conseguimos
 *      confirmar o titular do RNTRC" + mini-form em branco (motorista preenche
 *      manual). Nao bloqueia — `antt_titular` continua opcional no backend.
 *
 * Decisão prévia (2026-05-18 manhã) — campos financeiros (banco) + sociais
 * (PIS, estado civil, cor/raça) vivem AQUI, e somente quando
 * `kind === "cavalo" && tipo === "pf"`. Para `kind === "carreta"` o banco também
 * é omitido — só identidade + endereço + telefone.
 */

export type AnttTitularTipo = "pf" | "pj";
export type AnttTitularKind = "cavalo" | "carreta";

export interface AnttTitularEndereco {
  cep?: string;
  numero?: string;
  logradouro?: string;
  bairro?: string;
  cidade?: string;
  uf?: string;
  /**
   * Path do comprovante de residência do titular ANTT no bucket
   * `cadastro-drafts`. Preenchido pelo OwnerEnderecoComprovante widget
   * quando o motorista anexa o documento. 2026-05-20.
   */
  comprovanteUrl?: string;
  /** Marcador quando o motorista digitou CEP/número sem OCR. */
  ocr_comprovante_fallback_manual?: boolean;
}

export interface AnttTitularBank {
  bank: BrazilianBank | null;
  agencia: string;
  conta: string;
  tipo: "corrente" | "poupanca" | "";
}

export interface AnttTitularData {
  tipo: AnttTitularTipo;
  doc: string;
  nome: string;
  rntrc?: string;
  telefone?: string;
  endereco?: AnttTitularEndereco;
  banco?: AnttTitularBank;
  /**
   * Campos sociais/fiscais — apenas quando `kind === "cavalo" && tipo === "pf"`.
   * Lamonica paga o detentor do RNTRC; PJ não tem PIS/estado civil/cor.
   */
  pis?: string;
  estado_civil?: string;
  cor_raca?: string;
  /**
   * Path do documento (CNH PF ou cartão CNPJ) do titular ANTT no bucket
   * `cadastro-drafts` (slot `cavalo_antt_owner_cnh` ou
   * `carreta_antt_owner_cnh_<idx>`). 2026-05-20.
   */
  anttOwnerDocStoragePath?: string;
  /**
   * Path do comprovante de residência do titular ANTT (slot
   * `cavalo_antt_owner_comprovante` ou `carreta_antt_owner_comprovante_<idx>`).
   */
  anttOwnerComprovanteStoragePath?: string;
}

export interface AnttTitularCascadeResult {
  /** CPF/CNPJ do titular ANTT detectado pelo cascade (digits only). */
  titular_doc?: string | null;
  /** Nome/razao social do titular ANTT detectado pelo cascade. */
  titular_nome?: string | null;
  /** RNTRC retornado (pode ser util para pre-preenchimento). */
  rntrc?: string | null;
}

export interface AnttTitularPromptProps {
  /** Resultado do cascade ANTT (com titular_doc/titular_nome do backend). */
  cascadeResult: AnttTitularCascadeResult | null | undefined;
  /** Documento do proprietario CRLV (digits only). */
  ownerDoc: string;
  /** Nome do proprietario CRLV — usado para pre-popular cenario A "mesmo proprietario". */
  ownerNome?: string;
  /** Estado atual (state lift no step pai). */
  value: AnttTitularData | null;
  /** Callback emitido quando o motorista completa/edita o mini-form. */
  onChange: (data: AnttTitularData | null) => void;
  /** Contexto para namespacing aria/id (cavalo ou carreta_0 etc.). */
  context: string;
  /**
   * Categoria do veículo cujo RNTRC está sendo capturado.
   *   - `cavalo`: titular do RNTRC do cavalo — Lamonica paga ele.
   *     Banco + PIS/estado_civil/cor_raça (quando tipo=pf) renderizados.
   *   - `carreta`: titular do RNTRC da carreta — sem banco, sem campos sociais.
   */
  kind: AnttTitularKind;
  /**
   * 2026-05-20 — Contexto para upload de documento do titular RNTRC quando
   * difere do owner CRLV (cenarios B/C). Sub-card "Documento do titular"
   * exige CNH (PF) ou cartao CNPJ (PJ) e valida via OwnerDocumentUploader
   * que o doc OCR'd bate com cascadeResult.titular_doc. Quando ausente,
   * sub-card e omitido (compat com call-sites antigos).
   */
  cargaId?: string;
  cpf?: string;
  accessToken?: string | null;
  /** Slot p/ persistência draft (ex.: "cavalo_antt_owner_cnh"). */
  titularDocSlot?: string;
  /**
   * 2026-05-20 — Modo "sem cascade frontend": o caller nao executa a cascade
   * ANTT antes de renderizar. O componente sempre apresenta a pergunta
   * "É o mesmo proprietário do CRLV?" (sem pre-selecao). Quando "outra pessoa",
   * mini-form com upload do RNTRC (OCR backend) + CNH/CNPJ cruzado. Backend
   * faz a cascade no submit.
   */
  noCascadeMode?: boolean;
  /** Slot p/ persistência do documento RNTRC (ex.: "cavalo_antt"). */
  rntrcSlot?: string;
}

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

/**
 * Helper exportado — true quando cascade detectou um titular_doc DIFERENTE
 * do owner CRLV. Mantido por compat de imports externos (mesma assinatura).
 */
export function isTitularDiff(
  cascade: AnttTitularCascadeResult | null | undefined,
  ownerDoc: string,
): boolean {
  if (!cascade?.titular_doc) return false;
  const a = onlyDigits(cascade.titular_doc);
  const b = onlyDigits(ownerDoc);
  if (!a || !b) return false;
  return a !== b;
}

function inferTipoFromDoc(doc: string): AnttTitularTipo {
  return onlyDigits(doc).length === 14 ? "pj" : "pf";
}

function buildInitialFromCascade(
  cascade: AnttTitularCascadeResult | null | undefined,
): AnttTitularData {
  const doc = onlyDigits(cascade?.titular_doc ?? "");
  return {
    tipo: inferTipoFromDoc(doc),
    doc,
    nome: cascade?.titular_nome ?? "",
    rntrc: cascade?.rntrc ?? undefined,
  };
}

function buildBlankData(
  cascade: AnttTitularCascadeResult | null | undefined,
): AnttTitularData {
  return {
    tipo: "pf",
    doc: "",
    nome: "",
    rntrc: cascade?.rntrc ?? undefined,
  };
}

function buildSameAsOwnerData(
  ownerDoc: string,
  ownerNome: string | undefined,
  cascade: AnttTitularCascadeResult | null | undefined,
): AnttTitularData {
  const doc = onlyDigits(ownerDoc);
  return {
    tipo: inferTipoFromDoc(doc),
    doc,
    nome: (ownerNome ?? cascade?.titular_nome ?? "").trim(),
    rntrc: cascade?.rntrc ?? undefined,
  };
}

function isValidDoc(tipo: AnttTitularTipo, doc: string): boolean {
  return tipo === "pj" ? isValidCnpj(doc) : isValidCpf(doc);
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

function maskCep(value: string): string {
  return onlyDigits(value).replace(/^(\d{5})(\d)/, "$1-$2").slice(0, 9);
}

function maskPhone(value: string): string {
  const d = onlyDigits(value);
  if (d.length <= 10) {
    return d.replace(/^(\d{2})(\d)/, "($1) $2").replace(/(\d{4})(\d)/, "$1-$2");
  }
  return d.replace(/^(\d{2})(\d)/, "($1) $2").replace(/(\d{5})(\d)/, "$1-$2").slice(0, 15);
}

type Scenario = "A" | "B" | "C";

function resolveScenario(
  cascade: AnttTitularCascadeResult | null | undefined,
  ownerDoc: string,
): Scenario {
  if (!cascade?.titular_doc) return "C";
  const a = onlyDigits(cascade.titular_doc);
  const b = onlyDigits(ownerDoc);
  if (!a || !b) return "C";
  return a === b ? "A" : "B";
}

export function AnttTitularPrompt({
  cascadeResult,
  ownerDoc,
  ownerNome,
  value,
  onChange,
  context,
  kind,
  cargaId,
  cpf,
  accessToken,
  titularDocSlot,
  noCascadeMode = false,
  rntrcSlot,
}: AnttTitularPromptProps) {
  const scenario = useMemo(
    () =>
      noCascadeMode ? ("A" as Scenario) : resolveScenario(cascadeResult, ownerDoc),
    [cascadeResult, ownerDoc, noCascadeMode],
  );

  // Cenario A: motorista escolhe entre "mesmo do CRLV" e "outra pessoa".
  // - noCascadeMode=true: defaultmente `null` (motorista tem que escolher).
  // - cascade rodou e titular === owner: default `true` (auto-confirmado).
  // - Valor prévio com doc != ownerDoc: assume "outra pessoa".
  const [sameAsOwner, setSameAsOwner] = useState<boolean | null>(() => {
    if (scenario !== "A") return false;
    if (noCascadeMode) {
      if (!value) return null;
      return onlyDigits(value.doc) === onlyDigits(ownerDoc);
    }
    if (!value) return true;
    return onlyDigits(value.doc) === onlyDigits(ownerDoc);
  });

  // RNTRC upload tile state (apenas em noCascadeMode + "outra pessoa").
  const [rntrcTileState, setRntrcTileState] = useState<OcrTileState>("empty");
  const [rntrcFileName, setRntrcFileName] = useState<string | undefined>(undefined);
  const [rntrcOcrError, setRntrcOcrError] = useState<string | undefined>(undefined);
  const lastRntrcOcrRef = useRef<string>("");

  // State interno do mini-form. Inicializa conforme o cenario:
  //   A "mesmo": copia do owner
  //   A "outra"/B: pre-populado pelo cascade (B) ou owner-copy editavel (A)
  //   C: em branco
  const [data, setData] = useState<AnttTitularData>(() => {
    if (value) return value;
    if (scenario === "A" && !noCascadeMode) {
      return buildSameAsOwnerData(ownerDoc, ownerNome, cascadeResult);
    }
    if (scenario === "B") {
      return buildInitialFromCascade(cascadeResult);
    }
    return buildBlankData(cascadeResult);
  });

  // Re-sync defaults quando cascade/ownerDoc mudam (re-tentativa do step pai).
  // Só reescreve quando NAO ha valor previamente confirmado pelo motorista.
  // Em noCascadeMode nao reescreve — motorista tem que escolher manualmente.
  useEffect(() => {
    if (value) return;
    if (noCascadeMode) return;
    if (scenario === "A") {
      setData(buildSameAsOwnerData(ownerDoc, ownerNome, cascadeResult));
      setSameAsOwner(true);
    } else if (scenario === "B") {
      setData(buildInitialFromCascade(cascadeResult));
    } else {
      setData(buildBlankData(cascadeResult));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cascadeResult?.titular_doc, ownerDoc, scenario]);

  // CENARIO A — "mesmo proprietario": emite onChange com cópia do owner SEMPRE
  // que o toggle estiver marcado. Garante que o payload SEMPRE leva antt_titular
  // mesmo quando o motorista nao tocou no form.
  useEffect(() => {
    if (scenario !== "A") return;
    if (!sameAsOwner) return;
    const sameData = buildSameAsOwnerData(ownerDoc, ownerNome, cascadeResult);
    // Evita loop: só emite quando difere do `value` atual.
    if (
      !value ||
      onlyDigits(value.doc) !== sameData.doc ||
      value.nome !== sameData.nome ||
      value.tipo !== sameData.tipo
    ) {
      onChange(sameData);
      setData(sameData);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenario, sameAsOwner, ownerDoc, ownerNome, cascadeResult?.titular_doc]);

  const docValid = isValidDoc(data.tipo, data.doc);
  const nomeValid = data.nome.trim().length >= 2;
  const formComplete = docValid && nomeValid;

  const showBankBlock = kind === "cavalo";
  const showSocialBlock = kind === "cavalo" && data.tipo === "pf";

  const sectionTitle =
    kind === "cavalo"
      ? "Endereço, telefone e banco (opcional)"
      : "Endereço e telefone (opcional)";

  const handleField = useCallback(
    <K extends keyof AnttTitularData>(key: K, next: AnttTitularData[K]) => {
      const updated = { ...data, [key]: next };
      setData(updated);
      if (isValidDoc(updated.tipo, updated.doc) && updated.nome.trim().length >= 2) {
        onChange(updated);
      }
    },
    [data, onChange],
  );

  const handleEnderecoField = (
    key: keyof AnttTitularEndereco,
    next: string,
  ) => {
    const endereco = { ...(data.endereco ?? {}), [key]: next };
    const updated = { ...data, endereco };
    setData(updated);
    if (formComplete) onChange(updated);
  };

  const handleBankField = <K extends keyof AnttTitularBank>(
    key: K,
    next: AnttTitularBank[K],
  ) => {
    const banco: AnttTitularBank = {
      bank: data.banco?.bank ?? null,
      agencia: data.banco?.agencia ?? "",
      conta: data.banco?.conta ?? "",
      tipo: data.banco?.tipo ?? "",
      [key]: next,
    };
    const updated = { ...data, banco };
    setData(updated);
    if (formComplete) onChange(updated);
  };

  const handleToggleSame = (next: boolean) => {
    setSameAsOwner(next);
    if (next) {
      const sameData = buildSameAsOwnerData(ownerDoc, ownerNome, cascadeResult);
      setData(sameData);
      onChange(sameData);
    } else {
      // Limpa o form para o motorista preencher manualmente.
      const blank = buildBlankData(cascadeResult);
      setData(blank);
      // Nao emite ainda — espera o motorista validar doc+nome para emitir.
      onChange(null);
    }
  };

  // Handler do upload do RNTRC em noCascadeMode. Roda ocrRntrc no backend,
  // popula tipo/doc/nome no mini-form quando OCR succeeds. Mismatch nao bloqueia
  // aqui — o OwnerDocumentUploader (CNH/CNPJ subsequente) faz o cross-check.
  const handleRntrcFile = async (file: File) => {
    setRntrcFileName(file.name);
    setRntrcTileState("uploading");
    setRntrcOcrError(undefined);
    try {
      const extracted = await ocrRntrc(file);
      lastRntrcOcrRef.current = extracted.documento || "";
      const next: AnttTitularData = {
        ...data,
        tipo: extracted.tipo === "PJ" ? "pj" : "pf",
        doc: extracted.documento || data.doc,
        nome: extracted.nome || data.nome,
        rntrc: extracted.rntrc || data.rntrc,
      };
      setData(next);
      setRntrcTileState("success");
      if (isValidDoc(next.tipo, next.doc) && next.nome.trim().length >= 2) {
        onChange(next);
      }
    } catch (err) {
      setRntrcTileState("failure");
      setRntrcOcrError(
        err instanceof Error
          ? err.message
          : "Não conseguimos ler o RNTRC. Preencha os dados manualmente.",
      );
    }
  };

  // 2026-05-26 — Quando o motorista escolhe "É o mesmo proprietário do CRLV"
  // (cenário A, sameAsOwner=true) e o kind é cavalo, ainda precisamos coletar
  // os dados bancários do titular do RNTRC (a Lamônica paga o detentor do
  // RNTRC). Antes desse fix, o BankSelector vivia DENTRO do mini-form, que
  // só renderizava quando "outra pessoa" — resultado: para cavalo PJ + mesmo
  // proprietário, o motorista nunca via os campos bancários e o banner
  // "Faltam dados bancários" aparecia sem onde corrigir.
  const renderStandaloneBankCard = () => (
    <div className="space-y-3 rounded-xl border border-border bg-card p-4">
      <h4 className="text-sm font-semibold text-foreground">
        Banco para pagamento
      </h4>
      <p className="text-xs text-muted-foreground">
        Conta da pessoa/empresa que detém o RNTRC. É para onde a Lamônica
        deposita o frete.
      </p>
      <BankSelector
        value={data.banco?.bank ?? null}
        onChange={(bank) => handleBankField("bank", bank)}
      />
      {data.banco?.bank ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="space-y-1">
            <Label htmlFor={`antt-tit-ag-same-${context}`}>Agência</Label>
            <Input
              id={`antt-tit-ag-same-${context}`}
              value={data.banco?.agencia ?? ""}
              onChange={(e) => handleBankField("agencia", e.target.value)}
              className="h-12"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`antt-tit-conta-same-${context}`}>Conta</Label>
            <Input
              id={`antt-tit-conta-same-${context}`}
              value={data.banco?.conta ?? ""}
              onChange={(e) => handleBankField("conta", e.target.value)}
              className="h-12"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`antt-tit-tipo-same-${context}`}>Tipo</Label>
            <Select
              value={data.banco?.tipo || ""}
              onValueChange={(v) =>
                handleBankField("tipo", v as AnttTitularBank["tipo"])
              }
            >
              <SelectTrigger
                id={`antt-tit-tipo-same-${context}`}
                className="h-12"
              >
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
  );

  // Render do mini-form (compartilhado entre B, C e A-outra-pessoa).
  const renderMiniForm = () => (
    <div className="space-y-3 rounded-xl border border-border bg-card p-4">
      <h4 className="text-sm font-semibold text-foreground">
        Dados do titular do RNTRC
      </h4>

      {/* 2026-05-20 — Em noCascadeMode, motorista pode anexar o RNTRC pra
          extracao automatica de CPF/CNPJ via OCR backend. */}
      {noCascadeMode && rntrcSlot && cargaId ? (
        <div className="space-y-1.5">
          <p className="text-sm font-medium text-foreground">
            Anexar documento RNTRC (opcional)
          </p>
          <p className="text-xs text-muted-foreground">
            Se você tem o documento, anexe — vamos extrair o CPF/CNPJ e o nome
            do titular automaticamente.
          </p>
          <OcrUploadTile
            accept="image/*,application/pdf"
            maxSizeMb={8}
            label="Documento RNTRC / ANTT"
            helper="Comprovante de inscrição no RNTRC (PDF ou foto)"
            state={rntrcTileState}
            previewName={rntrcFileName}
            errorMessage={rntrcOcrError}
            onFile={(file) => {
              void handleRntrcFile(file);
            }}
            onRetry={() => {
              setRntrcTileState("empty");
              setRntrcFileName(undefined);
              setRntrcOcrError(undefined);
            }}
            onManualFallback={() => {
              setRntrcTileState("manual");
              setRntrcOcrError(undefined);
            }}
            slot={rntrcSlot}
            cargaId={cargaId}
            cpf={cpf}
            accessToken={accessToken}
          />
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor={`antt-tit-tipo-${context}`}>Tipo</Label>
          <Select
            value={data.tipo}
            onValueChange={(v) => handleField("tipo", v as AnttTitularTipo)}
          >
            <SelectTrigger id={`antt-tit-tipo-${context}`} className="h-12">
              <SelectValue placeholder="PF ou PJ" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="pf">Pessoa Física (CPF)</SelectItem>
              <SelectItem value="pj">Pessoa Jurídica (CNPJ)</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <Label htmlFor={`antt-tit-doc-${context}`}>
            {data.tipo === "pj" ? "CNPJ" : "CPF"}
          </Label>
          <Input
            id={`antt-tit-doc-${context}`}
            inputMode="numeric"
            value={maskDoc(data.doc)}
            onChange={(e) => handleField("doc", onlyDigits(e.target.value))}
            aria-invalid={!docValid && data.doc.length > 0}
            className="h-12"
            placeholder={data.tipo === "pj" ? "00.000.000/0000-00" : "000.000.000-00"}
          />
        </div>
      </div>

      <div className="space-y-1">
        <Label htmlFor={`antt-tit-nome-${context}`}>
          {data.tipo === "pj" ? "Razão social" : "Nome completo"}
        </Label>
        <Input
          id={`antt-tit-nome-${context}`}
          value={data.nome}
          onChange={(e) => handleField("nome", e.target.value)}
          aria-invalid={!nomeValid && data.nome.length > 0}
          className="h-12"
          placeholder={data.tipo === "pj" ? "Razão Social Ltda" : "João da Silva"}
        />
      </div>

      {/* 2026-05-20 — Documento do titular RNTRC (CNH PF ou cartao CNPJ PJ).
          Quando cascade ou OCR do RNTRC trouxe titular_doc, OwnerDocumentUploader
          valida cruzado e bloqueia avanco em mismatch (logica reusada da Fase B.4).
          Renderiza so quando ha doc valido e contexto draft completo. */}
      {titularDocSlot && cargaId && docValid ? (
        <div className="space-y-2 rounded-lg bg-muted/30 p-3">
          <p className="text-sm font-semibold text-foreground">
            Documento do titular do RNTRC
          </p>
          <p className="text-xs text-muted-foreground">
            Envie {data.tipo === "pj" ? "o cartão CNPJ" : "a CNH"} de{" "}
            <strong>{data.nome || maskDoc(data.doc)}</strong> para confirmar que
            é o mesmo {data.tipo === "pj" ? "CNPJ" : "CPF"} indicado no RNTRC.
          </p>
          <OwnerDocumentUploader
            ownerDocType={data.tipo === "pj" ? "cnpj" : "cpf"}
            expectedDocument={onlyDigits(data.doc)}
            onExtracted={(extracted) => {
              // Sincroniza nome se OCR trouxe e o motorista ainda nao editou.
              if (extracted.nome && !data.nome.trim()) {
                handleField("nome", extracted.nome);
              }
            }}
            slot={titularDocSlot}
            cargaId={cargaId}
            cpf={cpf}
            accessToken={accessToken}
            onDraftPersisted={(storagePath) => {
              const updated = { ...data, anttOwnerDocStoragePath: storagePath };
              setData(updated);
              if (
                isValidDoc(updated.tipo, updated.doc) &&
                updated.nome.trim().length >= 2
              ) {
                onChange(updated);
              }
            }}
            draftPersisted={Boolean(data.anttOwnerDocStoragePath)}
          />
        </div>
      ) : null}

      <ProgressiveSection
        title={sectionTitle}
        description="Ajuda a gente a pagar e contactar o titular se precisar."
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor={`antt-tit-cep-${context}`}>CEP</Label>
            <Input
              id={`antt-tit-cep-${context}`}
              inputMode="numeric"
              value={maskCep(data.endereco?.cep ?? "")}
              onChange={(e) =>
                handleEnderecoField("cep", onlyDigits(e.target.value))
              }
              className="h-12"
              placeholder="00000-000"
            />
          </div>

          <div className="space-y-1">
            <Label htmlFor={`antt-tit-cidade-${context}`}>Cidade</Label>
            <Input
              id={`antt-tit-cidade-${context}`}
              value={data.endereco?.cidade ?? ""}
              onChange={(e) => handleEnderecoField("cidade", e.target.value)}
              className="h-12"
            />
          </div>

          <div className="space-y-1">
            <Label htmlFor={`antt-tit-uf-${context}`}>UF</Label>
            <Input
              id={`antt-tit-uf-${context}`}
              value={data.endereco?.uf ?? ""}
              maxLength={2}
              onChange={(e) =>
                handleEnderecoField("uf", e.target.value.toUpperCase())
              }
              className="h-12"
            />
          </div>

          <div className="space-y-1">
            <Label htmlFor={`antt-tit-tel-${context}`}>Telefone</Label>
            <Input
              id={`antt-tit-tel-${context}`}
              inputMode="tel"
              value={maskPhone(data.telefone ?? "")}
              onChange={(e) => handleField("telefone", onlyDigits(e.target.value))}
              aria-invalid={
                Boolean(data.telefone) && !isValidBrazilianPhone(data.telefone)
              }
              className="h-12"
              placeholder="(00) 00000-0000"
            />
          </div>
        </div>

        {showSocialBlock ? (
          <div className="grid grid-cols-1 gap-3 pt-2 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor={`antt-tit-pis-${context}`}>
                PIS / PASEP (opcional)
              </Label>
              <Input
                id={`antt-tit-pis-${context}`}
                inputMode="numeric"
                value={onlyDigits(data.pis ?? "").slice(0, 11)}
                onChange={(e) =>
                  handleField(
                    "pis",
                    onlyDigits(e.target.value).slice(0, 11),
                  )
                }
                className="h-12"
                placeholder="11 dígitos"
                maxLength={11}
              />
            </div>

            <div className="space-y-1">
              <Label htmlFor={`antt-tit-civil-${context}`}>
                Estado civil (opcional)
              </Label>
              <Select
                value={data.estado_civil ?? ""}
                onValueChange={(v) => handleField("estado_civil", v)}
              >
                <SelectTrigger
                  id={`antt-tit-civil-${context}`}
                  className="h-12"
                >
                  <SelectValue placeholder="Selecione" />
                </SelectTrigger>
                <SelectContent>
                  {ESTADO_CIVIL_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor={`antt-tit-raca-${context}`}>
                Cor / raça (opcional)
              </Label>
              <Select
                value={data.cor_raca ?? ""}
                onValueChange={(v) => handleField("cor_raca", v)}
              >
                <SelectTrigger
                  id={`antt-tit-raca-${context}`}
                  className="h-12"
                >
                  <SelectValue placeholder="Selecione" />
                </SelectTrigger>
                <SelectContent>
                  {COR_RACA_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        ) : null}

        {showBankBlock ? (
          <div className="space-y-2 pt-2">
            <Label>Banco para pagamento (opcional)</Label>
            <BankSelector
              value={data.banco?.bank ?? null}
              onChange={(bank) => handleBankField("bank", bank)}
            />
            {data.banco?.bank ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div className="space-y-1">
                  <Label htmlFor={`antt-tit-ag-${context}`}>Agência</Label>
                  <Input
                    id={`antt-tit-ag-${context}`}
                    value={data.banco?.agencia ?? ""}
                    onChange={(e) => handleBankField("agencia", e.target.value)}
                    className="h-12"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`antt-tit-conta-${context}`}>Conta</Label>
                  <Input
                    id={`antt-tit-conta-${context}`}
                    value={data.banco?.conta ?? ""}
                    onChange={(e) => handleBankField("conta", e.target.value)}
                    className="h-12"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`antt-tit-tipo-conta-${context}`}>Tipo</Label>
                  <Select
                    value={data.banco?.tipo || ""}
                    onValueChange={(v) =>
                      handleBankField(
                        "tipo",
                        v as AnttTitularBank["tipo"],
                      )
                    }
                  >
                    <SelectTrigger
                      id={`antt-tit-tipo-conta-${context}`}
                      className="h-12"
                    >
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
        ) : null}
      </ProgressiveSection>

      {formComplete ? (
        <p className="text-xs text-emerald-700 dark:text-emerald-300">
          ✓ Dados do titular ANTT confirmados.
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          Preencha tipo, documento e nome para confirmar.
        </p>
      )}
    </div>
  );

  // ─── Cenario A ─── (a) cascade SUCEDEU e titular_doc === ownerDoc OU
  //                  (b) noCascadeMode=true (motorista escolhe manual).
  if (scenario === "A") {
    // noCascadeMode usa styling neutro (sem emerald — nao houve cascade) e
    // exige que o motorista escolha (radios sem pre-selecao quando null).
    const accentClass = noCascadeMode
      ? "rounded-lg border border-border bg-muted/30 p-3"
      : "rounded-lg border border-emerald-300 bg-emerald-50 p-3 dark:border-emerald-800 dark:bg-emerald-950";
    const legendClass = noCascadeMode
      ? "px-1 text-sm font-semibold text-foreground"
      : "px-1 text-sm font-semibold text-emerald-900 dark:text-emerald-100";
    const labelClass = noCascadeMode
      ? "flex cursor-pointer items-start gap-2 text-sm text-foreground"
      : "flex cursor-pointer items-start gap-2 text-sm text-emerald-900 dark:text-emerald-100";
    const radioClass = noCascadeMode
      ? "mt-1 h-4 w-4 accent-primary"
      : "mt-1 h-4 w-4 accent-emerald-600";

    return (
      <div className="space-y-4">
        <fieldset
          className={`space-y-2 ${accentClass}`}
          aria-labelledby={`antt-tit-toggle-legend-${context}`}
        >
          <legend id={`antt-tit-toggle-legend-${context}`} className={legendClass}>
            Quem é o titular do RNTRC?
          </legend>
          <label className={labelClass}>
            <input
              type="radio"
              name={`antt-tit-same-${context}`}
              checked={sameAsOwner === true}
              onChange={() => handleToggleSame(true)}
              className={radioClass}
            />
            <span>
              É o mesmo proprietário do CRLV
              {noCascadeMode ? null : (
                <span className="text-xs text-emerald-700 dark:text-emerald-300">
                  {" "}(titular do RNTRC confirmado automaticamente)
                </span>
              )}
            </span>
          </label>
          <label className={labelClass}>
            <input
              type="radio"
              name={`antt-tit-same-${context}`}
              checked={sameAsOwner === false}
              onChange={() => handleToggleSame(false)}
              className={radioClass}
            />
            <span>Outra pessoa é o titular do RNTRC</span>
          </label>
        </fieldset>

        {sameAsOwner === false ? renderMiniForm() : null}
        {/* 2026-05-26 — Quando "É o mesmo proprietário do CRLV" e kind=cavalo,
            ainda precisamos coletar os dados bancários do titular ANTT (a
            Lamônica paga quem detém o RNTRC). O resto dos dados (nome/doc)
            vem do owner do CRLV automaticamente via buildSameAsOwnerData. */}
        {sameAsOwner === true && showBankBlock ? renderStandaloneBankCard() : null}
      </div>
    );
  }

  // ─── Cenario B ─── cascade SUCEDEU + titular_doc !== ownerDoc.
  if (scenario === "B") {
    return (
      <div className="space-y-4">
        <DriverAlert
          variant="info"
          title="RNTRC em nome de outra pessoa"
          description={
            <>
              Identificamos que o RNTRC está em nome de{" "}
              <strong>
                {cascadeResult?.titular_nome ||
                  maskDoc(cascadeResult?.titular_doc ?? "")}
              </strong>
              . Confirma os dados do titular pra gente cadastrar direito.
            </>
          }
        />

        {renderMiniForm()}
      </div>
    );
  }

  // ─── Cenario C ─── cascade NAO RODOU ou retornou sem titular_doc.
  return (
    <div className="space-y-4">
      <DriverAlert
        variant="warning"
        title="Não conseguimos confirmar o titular do RNTRC"
        description="Não conseguimos confirmar quem é o dono do RNTRC. Quem é o dono? Pode preencher abaixo (opcional) — se não souber, dá pra prosseguir e a gente revisa depois."
      />

      {renderMiniForm()}
    </div>
  );
}
