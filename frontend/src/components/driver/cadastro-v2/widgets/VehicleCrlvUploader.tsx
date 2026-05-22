import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Info, ShieldAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MoreOptionsToggle } from "@/components/driver/ui";
import { onlyDigits } from "@/lib/brazilianValidators";
import { formatExpiryLabel } from "@/lib/expiryLabel";
import { ocrCrlv } from "@/pages/cadastro/cadastroApi";

import { OcrUploadTile, type OcrTileState } from "./OcrUploadTile";
import type { OcrResultField } from "./OcrResultReview";
import {
  classifyVehicleType,
  type VehicleClassification,
} from "../lib/classifyVehicleType";

export interface VehicleCrlvExtractedData {
  placa: string;
  renavam: string;
  chassi: string;
  marca: string;
  ano: string;
  cor: string;
  ownerNome: string;
  /** CPF do proprietário (digits only) quando o CRLV indica PF. */
  cpf_proprietario?: string;
  /** CNPJ do proprietário (digits only) quando o CRLV indica PJ. */
  cnpj_proprietario?: string;
  /** CADASTRO-14: motorista preencheu manualmente (OCR falhou ou clicou fallback). */
  ocr_fallback_manual?: boolean;
  // PLAN-CADASTRO-PARITY (19/05) — campos extras propagados ao sub-card
  // "Detalhes do cavalo/carreta" (BcData). O OCR Infosimples já retorna esses
  // valores; antes eram descartados aqui e o motorista precisava redigitar.
  modelo?: string;
  tipo?: string;
  carroceria?: string;
  ano_fabricacao?: string;
  eixos?: string;
  uf_emplacamento?: string;
  cidade_emplacamento?: string;
  ultimo_licenciamento?: string;
  antt?: string;
}

export interface VehicleCrlvUploaderProps {
  /** Placa esperada (vem do pre-check). Usada como fallback e para o label. */
  plate: string;
  /** Acionado quando OCR sucesso OU campos manuais validos. */
  onExtracted: (data: VehicleCrlvExtractedData) => void;
  /** Acionado quando o uploader entra em modo manual (2 falhas OCR ou click). */
  onManualFallback?: () => void;
  /** Forca modo manual desde o inicio (caller controla). */
  manualMode?: boolean;
  /** Label customizavel para o tile (cavalo vs carreta). */
  label?: string;
  /**
   * Quando fornecido, é chamado após o motorista escolher "Usar do documento"
   * na divergência de placa. Deve retornar se a nova placa já está cadastrada e vigente.
   * O resultado é exibido inline (sem bloquear o fluxo).
   */
  checkPlateRegistration?: (plate: string) => Promise<{ alreadyRegistered: boolean; daysUntilExpiry?: number }>;
  /**
   * Slot p/ persistência draft (ex.: "cavalo_crlv", "carreta_crlv_0"). Caller
   * decide o slot porque o widget é reutilizado em contextos diferentes.
   */
  slot?: string;
  cargaId?: string;
  cpf?: string;
  accessToken?: string | null;
  /** Chamado quando o upload draft retorna sucesso (storage_path). */
  onDraftPersisted?: (storagePath: string) => void;
  /** Marca como já persistido na hidratação do draft. */
  draftPersisted?: boolean;
  /**
   * Chamado quando o motorista clica "Trocar arquivo" — caller deve zerar
   * estados derivados do OCR (ex: `bcPrefilledByOcr` no StepBCavalo/StepDCarretas)
   * para que banners "preenchido pelo CRLV" sumam quando o usuario re-faz o upload.
   */
  onResetExtracted?: () => void;
  /**
   * Tipo esperado do veiculo pra esse slot. Quando definido, o widget classifica
   * o `tipo` retornado pelo OCR e bloqueia o avanco se nao bater (ex: motorista
   * subiu CRLV de carreta no slot do cavalo). Apos blocked, exige novo upload.
   */
  expectedVehicleType?: VehicleClassification;
  /**
   * Dados do CRLV ja extraidos em sessao anterior (hidratacao do draft via
   * crlvStoragePath). Quando fornecido junto com `draftPersisted=true`, o
   * widget inicia em estado `success` com "Documento ja enviado" — evita que
   * o motorista pense que perdeu o upload ao recarregar/voltar.
   */
  initialExtracted?: VehicleCrlvExtractedData;
}

function maskDocument(doc: string, tipo: "cpf" | "cnpj" | ""): string {
  const digits = onlyDigits(doc);
  if (tipo === "cpf" && digits.length === 11) {
    return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9)}`;
  }
  if (tipo === "cnpj" && digits.length === 14) {
    return `${digits.slice(0, 2)}.${digits.slice(2, 5)}.${digits.slice(5, 8)}/${digits.slice(8, 12)}-${digits.slice(12)}`;
  }
  return doc;
}

interface InternalState {
  placa: string;
  renavam: string;
  chassi: string;
  marca: string;
  ano: string;
  cor: string;
  ownerNome: string;
  ownerDoc: string;
  ownerDocType: "cpf" | "cnpj" | "";
  // Campos extras do OCR repassados pro sub-card BC (Detalhes).
  modelo: string;
  tipo: string;
  carroceria: string;
  ano_fabricacao: string;
  eixos: string;
  uf_emplacamento: string;
  cidade_emplacamento: string;
  ultimo_licenciamento: string;
  antt: string;
}

interface PlateMismatchPending {
  ocrPlate: string;
  pendingState: InternalState;
  pendingSnap: { placa: string; chassi: string; renavam: string };
}

function buildEmpty(plate: string): InternalState {
  return {
    placa: plate || "",
    renavam: "",
    chassi: "",
    marca: "",
    ano: "",
    cor: "",
    ownerNome: "",
    ownerDoc: "",
    ownerDocType: "",
    modelo: "",
    tipo: "",
    carroceria: "",
    ano_fabricacao: "",
    eixos: "",
    uf_emplacamento: "",
    cidade_emplacamento: "",
    ultimo_licenciamento: "",
    antt: "",
  };
}

function buildFromInitial(
  plate: string,
  extracted: VehicleCrlvExtractedData,
): InternalState {
  const cpf = onlyDigits(extracted.cpf_proprietario ?? "");
  const cnpj = onlyDigits(extracted.cnpj_proprietario ?? "");
  let ownerDoc = "";
  let ownerDocType: "cpf" | "cnpj" | "" = "";
  if (cpf.length === 11) {
    ownerDoc = cpf;
    ownerDocType = "cpf";
  } else if (cnpj.length === 14) {
    ownerDoc = cnpj;
    ownerDocType = "cnpj";
  }
  return {
    placa: extracted.placa || plate || "",
    renavam: extracted.renavam || "",
    chassi: extracted.chassi || "",
    marca: extracted.marca || "",
    ano: extracted.ano || "",
    cor: extracted.cor || "",
    ownerNome: extracted.ownerNome || "",
    ownerDoc,
    ownerDocType,
    modelo: extracted.modelo || "",
    tipo: extracted.tipo || "",
    carroceria: extracted.carroceria || "",
    ano_fabricacao: extracted.ano_fabricacao || "",
    eixos: extracted.eixos || "",
    uf_emplacamento: extracted.uf_emplacamento || "",
    cidade_emplacamento: extracted.cidade_emplacamento || "",
    ultimo_licenciamento: extracted.ultimo_licenciamento || "",
    antt: extracted.antt || "",
  };
}

function hasInitialContent(extracted?: VehicleCrlvExtractedData): boolean {
  if (!extracted) return false;
  return Boolean(
    extracted.placa ||
      extracted.renavam ||
      extracted.chassi ||
      extracted.ownerNome ||
      extracted.cpf_proprietario ||
      extracted.cnpj_proprietario,
  );
}

// Mantida pra referencia historica caso queiramos re-exibir no futuro.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _buildExtractedFields(state: InternalState): OcrResultField[] {
  const fields: OcrResultField[] = [];
  if (state.placa) fields.push({ label: "Placa", value: state.placa });
  if (state.renavam) fields.push({ label: "RENAVAM", value: state.renavam });
  if (state.chassi) fields.push({ label: "Chassi", value: state.chassi });
  if (state.marca) fields.push({ label: "Marca/Modelo", value: state.marca });
  if (state.ano) fields.push({ label: "Ano", value: state.ano });
  if (state.cor) fields.push({ label: "Cor", value: state.cor });
  if (state.ownerDoc) {
    fields.push({
      label: state.ownerDocType === "cnpj" ? "CNPJ proprietário" : "CPF proprietário",
      value: maskDocument(state.ownerDoc, state.ownerDocType || ""),
    });
  }
  return fields;
}

function toExtracted(
  state: InternalState,
  ocrFallbackManual: boolean,
): VehicleCrlvExtractedData {
  const base: VehicleCrlvExtractedData = {
    placa: state.placa,
    renavam: state.renavam,
    chassi: state.chassi,
    marca: state.marca,
    ano: state.ano,
    cor: state.cor,
    ownerNome: state.ownerNome,
    ocr_fallback_manual: ocrFallbackManual,
  };
  if (state.ownerDocType === "cpf" && state.ownerDoc) {
    base.cpf_proprietario = state.ownerDoc;
  } else if (state.ownerDocType === "cnpj" && state.ownerDoc) {
    base.cnpj_proprietario = state.ownerDoc;
  }
  // PLAN-CADASTRO-PARITY — propaga campos do sub-card BC apenas quando o OCR
  // de fato extraiu (strings vazias omitidas para o caller poder usar `||`).
  if (state.modelo) base.modelo = state.modelo;
  if (state.tipo) base.tipo = state.tipo;
  if (state.carroceria) base.carroceria = state.carroceria;
  if (state.ano_fabricacao) base.ano_fabricacao = state.ano_fabricacao;
  if (state.eixos) base.eixos = state.eixos;
  if (state.uf_emplacamento) base.uf_emplacamento = state.uf_emplacamento;
  if (state.cidade_emplacamento) base.cidade_emplacamento = state.cidade_emplacamento;
  if (state.ultimo_licenciamento) base.ultimo_licenciamento = state.ultimo_licenciamento;
  if (state.antt) base.antt = state.antt;
  return base;
}

/**
 * Widget reutilizavel que encapsula o upload + OCR do CRLV. Empregado por:
 *  - Step B (cavalo)
 *  - Step D (carretas, iterado por placa)
 *
 * Fluxo:
 *  - Foto -> ocrCrlv() -> extracted -> onExtracted callback.
 *  - 2 falhas consecutivas -> aciona modo manual (onManualFallback).
 *  - Modo manual: inputs para placa, RENAVAM, chassi, CPF/CNPJ proprietario.
 *  - Tudo controlado por estado interno; o caller so reage via onExtracted.
 *  - Placa divergente: exibe card de confirmacao; motorista escolhe qual usar.
 */
type PlateCheckStatus = "idle" | "checking" | "already_registered" | "not_found";

export function VehicleCrlvUploader({
  plate,
  onExtracted,
  onManualFallback,
  manualMode: forcedManualMode = false,
  label,
  checkPlateRegistration,
  slot,
  cargaId,
  cpf,
  accessToken,
  onDraftPersisted,
  draftPersisted,
  onResetExtracted,
  expectedVehicleType,
  initialExtracted,
}: VehicleCrlvUploaderProps) {
  // Hidratacao do draft: quando initialExtracted veio (recarregou wizard com
  // crlvStoragePath ja persistido), inicia em estado "success" sem forcar
  // reupload. Bug 2026-05-20: motorista pensava que perdeu o documento no F5.
  const hydratedInitial = hasInitialContent(initialExtracted);
  const [state, setState] = useState<InternalState>(() =>
    hydratedInitial && initialExtracted
      ? buildFromInitial(plate, initialExtracted)
      : buildEmpty(plate),
  );
  const [tileState, setTileState] = useState<OcrTileState>(
    hydratedInitial ? "success" : "empty",
  );
  const [previewName, setPreviewName] = useState<string | undefined>(
    hydratedInitial ? "Documento já enviado" : undefined,
  );
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);
  const [manualMode, setManualMode] = useState(forcedManualMode);
  const [ocrFailures, setOcrFailures] = useState(0);
  const [pdfSizeWarning, setPdfSizeWarning] = useState<string | undefined>(undefined);
  // Snapshot extraído pelo OCR para cross-check visual nos campos manuais.
  const [crlvSnapshot, setCrlvSnapshot] = useState<{ placa: string; chassi: string; renavam: string } | null>(null);
  // Placa divergente: aguardando escolha do motorista antes de aplicar estado do OCR.
  const [plateMismatch, setPlateMismatch] = useState<PlateMismatchPending | null>(null);
  // Tipo de veiculo divergente do esperado pelo slot (cavalo vs carreta).
  // Quando definido, bloqueia o avanco — caller (StepBCavalo/StepDCarretas)
  // ja considera placaValid=false porque o state interno nao foi aplicado.
  const [vehicleTypeMismatch, setVehicleTypeMismatch] = useState<
    | { actualType: VehicleClassification; expectedType: VehicleClassification; rawTipo: string }
    | null
  >(null);
  // Resultado da consulta de cadastro para placa escolhida do documento.
  const [plateCheckStatus, setPlateCheckStatus] = useState<PlateCheckStatus>("idle");
  const [plateCheckDays, setPlateCheckDays] = useState<number | undefined>(undefined);
  const abortCheckRef = useRef<AbortController | null>(null);

  const normalize = (s: string) => (s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

  const compareWithSnap = (campo: "placa" | "chassi" | "renavam"): "match" | "diff" | null => {
    if (!crlvSnapshot) return null;
    const ocr = normalize(crlvSnapshot[campo]);
    if (!ocr) return null;
    const atual = normalize(state[campo]);
    if (!atual) return null;
    return atual === ocr ? "match" : "diff";
  };

  const renderCheckBadge = (campo: "placa" | "chassi" | "renavam") => {
    const status = compareWithSnap(campo);
    if (!status) return null;
    if (status === "match") return (
      <p className="mt-1 flex items-center gap-1 text-xs font-medium text-emerald-600">
        <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
        Confere com o CRLV
      </p>
    );
    return (
      <p className="mt-1 flex items-start gap-1 text-xs font-medium text-amber-600 dark:text-amber-500">
        <ShieldAlert className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
        <span>Diverge do CRLV (extraído: <strong>{crlvSnapshot![campo]}</strong>)</span>
      </p>
    );
  };

  // Sincroniza placa do prop quando muda (e.g., iterando carretas no Step D).
  // R-01 P0: só reseta quando a placa muda DE VERDADE (normalize). Se o parent
  // re-renderizar mandando "ABC1234 " vs "ABC1234", whitespace/case não devem
  // descartar OCR/snapshot já feitos.
  useEffect(() => {
    const normalizePlate = (s: string) =>
      (s ?? "").trim().toUpperCase().replace(/-/g, "").replace(/\s/g, "");
    if (normalizePlate(plate) === normalizePlate(state.placa)) {
      return;
    }
    setState(buildEmpty(plate));
    setTileState("empty");
    setPreviewName(undefined);
    setErrorMessage(undefined);
    setOcrFailures(0);
    setManualMode(forcedManualMode);
    setCrlvSnapshot(null);
    setPlateMismatch(null);
    setPlateCheckStatus("idle");
    setPlateCheckDays(undefined);
    setVehicleTypeMismatch(null);
    abortCheckRef.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plate]);

  useEffect(() => {
    if (forcedManualMode) setManualMode(true);
  }, [forcedManualMode]);

  // Emite o callback sempre que o estado interno mudar (caller decide quando
  // habilitar Continuar com base nos campos retornados).
  //
  // Gate de mount: no mount inicial `state = buildEmpty(plate)` (so placa = horsePlate,
  // resto vazio). Emitir esse payload "fantasma" sobrescrevia campos hidratados
  // do draft no parent (ex.: ownerDoc) e causava flicker quando a hidratacao
  // do GET /draft/me chegava async depois. So emite quando state tem algum
  // campo OCR/manual preenchido, OU apos a primeira emissao significativa.
  const hasMeaningfulStateRef = useRef(false);
  useEffect(() => {
    const hasContent =
      Boolean(state.renavam) ||
      Boolean(state.chassi) ||
      Boolean(state.marca) ||
      Boolean(state.ano) ||
      Boolean(state.cor) ||
      Boolean(state.ownerDoc) ||
      Boolean(state.ownerNome) ||
      Boolean(state.modelo) ||
      Boolean(state.tipo) ||
      manualMode;
    if (!hasContent && !hasMeaningfulStateRef.current) {
      return;
    }
    hasMeaningfulStateRef.current = true;
    onExtracted(toExtracted(state, manualMode));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, manualMode]);

  const updateState = (patch: Partial<InternalState>) => {
    setState((current) => ({ ...current, ...patch }));
  };

  const handleFile = async (file: File) => {
    // PDFs digitais do Detran > ~180KB são rejeitados pela Infosimples (CODE=701).
    // Orientamos o usuário a tirar foto antes mesmo do OCR tentar.
    if (file.type === "application/pdf" && file.size > 180 * 1024) {
      setPdfSizeWarning(
        "PDF grande detectado. Se o OCR falhar, tire uma foto do CRLV com a câmera para melhor resultado.",
      );
    } else {
      setPdfSizeWarning(undefined);
    }
    setPreviewName(file.name);
    setTileState("uploading");
    setErrorMessage(undefined);
    try {
      const extracted = await ocrCrlv(file);
      const docDigits = onlyDigits(extracted.proprietario.documento);
      let docTipo: "cpf" | "cnpj" | "" = "";
      if (extracted.proprietario.tipo === "PF" || docDigits.length === 11) docTipo = "cpf";
      else if (extracted.proprietario.tipo === "PJ" || docDigits.length === 14) docTipo = "cnpj";

      const marcaCombo = [extracted.veiculo.marca, extracted.veiculo.modelo]
        .filter(Boolean)
        .join(" / ");

      const nextPlaca = extracted.veiculo.placa || plate || "";
      const nextRenavam = extracted.veiculo.renavam || "";
      const nextChassi = extracted.veiculo.chassi || "";

      const pendingState: InternalState = {
        placa: nextPlaca,
        renavam: nextRenavam,
        chassi: nextChassi,
        marca: marcaCombo,
        ano: extracted.veiculo.ano_modelo || extracted.veiculo.ano_fabricacao || "",
        cor: extracted.veiculo.cor || "",
        ownerDoc: docDigits,
        ownerDocType: docTipo,
        ownerNome: extracted.proprietario.nome || "",
        // PLAN-CADASTRO-PARITY — campos extras pro sub-card BC. `marca` acima já
        // virou "Marca / Modelo" combinado; aqui guardamos `modelo` puro pra
        // popular o input dedicado em BcDetalhesCavalo.
        modelo: extracted.veiculo.modelo || "",
        tipo: extracted.veiculo.tipo || "",
        carroceria: extracted.veiculo.carroceria || "",
        ano_fabricacao: extracted.veiculo.ano_fabricacao || "",
        eixos: extracted.veiculo.eixos || "",
        uf_emplacamento: extracted.veiculo.uf_emplacamento || "",
        cidade_emplacamento: extracted.veiculo.cidade_emplacamento || "",
        ultimo_licenciamento: extracted.veiculo.ultimo_licenciamento || "",
        antt: extracted.veiculo.antt || "",
      };
      const pendingSnap = { placa: nextPlaca, chassi: nextChassi, renavam: nextRenavam };

      // Gate 1: tipo do veiculo bate com o slot esperado?
      // Quando `expectedVehicleType` esta definido e o OCR retornou tipo
      // classificavel, exigimos match. Mismatch -> rejeita upload e nao
      // aplica estado (caller mantem placaValid=false -> "Continuar" disabled).
      if (expectedVehicleType) {
        const actualType = classifyVehicleType(extracted.veiculo.tipo);
        if (actualType && actualType !== expectedVehicleType) {
          setVehicleTypeMismatch({
            actualType,
            expectedType: expectedVehicleType,
            rawTipo: extracted.veiculo.tipo,
          });
          setTileState("failure");
          setOcrFailures(0);
          return;
        }
      }

      // Gate 2: placa divergente entre OCR e candidatura.
      if (plate && nextPlaca && normalize(nextPlaca) !== normalize(plate)) {
        setPlateMismatch({ ocrPlate: nextPlaca, pendingState, pendingSnap });
        setTileState("success");
        setOcrFailures(0);
        return;
      }

      updateState(pendingState);
      setCrlvSnapshot(pendingSnap);
      setVehicleTypeMismatch(null);
      setTileState("success");
      setOcrFailures(0);
    } catch (err) {
      setTileState("failure");
      setErrorMessage(err instanceof Error ? err.message : "Falha ao processar CRLV.");
      setOcrFailures((current) => {
        const next = current + 1;
        if (next >= 2) {
          setManualMode(true);
          if (onManualFallback) onManualFallback();
        }
        return next;
      });
    }
  };

  const handleChooseDocument = () => {
    if (!plateMismatch) return;
    updateState(plateMismatch.pendingState);
    setCrlvSnapshot(plateMismatch.pendingSnap);
    const chosenPlate = plateMismatch.ocrPlate;
    setPlateMismatch(null);

    if (checkPlateRegistration) {
      abortCheckRef.current?.abort();
      const ctrl = new AbortController();
      abortCheckRef.current = ctrl;
      setPlateCheckStatus("checking");
      setPlateCheckDays(undefined);
      checkPlateRegistration(chosenPlate).then((result) => {
        if (ctrl.signal.aborted) return;
        setPlateCheckStatus(result.alreadyRegistered ? "already_registered" : "not_found");
        setPlateCheckDays(result.daysUntilExpiry);
      }).catch(() => {
        if (!ctrl.signal.aborted) setPlateCheckStatus("idle");
      });
    }
  };

  const handleChooseCandidacy = () => {
    if (!plateMismatch) return;
    updateState({ ...plateMismatch.pendingState, placa: plate });
    setCrlvSnapshot({ ...plateMismatch.pendingSnap, placa: plate });
    setPlateMismatch(null);
  };

  const handleManualFallback = () => {
    setManualMode(true);
    setTileState("manual");
    setErrorMessage(undefined);
    if (onManualFallback) onManualFallback();
  };

  const handleRetry = () => {
    setTileState("empty");
    setErrorMessage(undefined);
    setPreviewName(undefined);
    setPlateMismatch(null);
    setPlateCheckStatus("idle");
    setVehicleTypeMismatch(null);
    if (onResetExtracted) onResetExtracted();
    setPlateCheckDays(undefined);
    abortCheckRef.current?.abort();
  };

  const handleManualDocChange = (raw: string) => {
    const digits = onlyDigits(raw);
    let tipo: "cpf" | "cnpj" | "" = "";
    if (digits.length === 11) tipo = "cpf";
    else if (digits.length === 14) tipo = "cnpj";
    updateState({ ownerDoc: digits, ownerDocType: tipo });
  };

  // Divergência de placa no modo manual: detectada ao digitar placa completa.
  const manualPlateMismatch =
    manualMode &&
    plate &&
    state.placa.length >= 7 &&
    normalize(state.placa) !== normalize(plate);

  // 19/05 — buildExtractedFields/extractedFields foram desligados: o CRLV
  // nao mostra mais lista de campos extraidos pro motorista. State interno
  // segue propagando tudo via onExtracted -> StepBData / StepDData -> payload.
  const tileLabel = label ?? "CRLV do veículo";

  return (
    <div className="space-y-4">
      <OcrUploadTile
        accept="image/*,application/pdf"
        maxSizeMb={8}
        label={tileLabel}
        helper="Documento de licenciamento — frente ou frente+verso"
        state={tileState}
        previewName={previewName}
        // 19/05 — dados do CRLV nao sao exibidos pro motorista. O OCR popula
        // o state interno e tudo flui pro backend; UI mantem apenas o tile de
        // confirmacao ("arquivo enviado") sem listar campos extraidos.
        extractedData={undefined}
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
          if (onDraftPersisted) onDraftPersisted(result.storage_path);
        }}
        draftPersisted={draftPersisted}
      />

      {/* 2026-05-20 Bug #3: OCR succeeded mas nao extraiu CPF/CNPJ do proprietario.
          Geralmente CRLV escaneado em baixa qualidade ou layout atipico. Pedimos
          retry — ou o motorista usa "Preencher manualmente" se o OCR falhar 2x. */}
      {tileState === "success" && !manualMode && !vehicleTypeMismatch &&
       !plateMismatch && state.placa && !state.ownerDoc ? (
        <div
          role="alert"
          className="rounded-2xl border border-amber-400 bg-amber-50 p-4 dark:border-amber-600 dark:bg-amber-950/60"
        >
          <div className="flex items-start gap-3">
            <AlertTriangle
              className="mt-0.5 size-6 shrink-0 text-amber-700 dark:text-amber-400"
              aria-hidden="true"
            />
            <div className="flex-1 space-y-2">
              <p className="text-base font-semibold text-foreground">
                Não lemos o CPF/CNPJ do proprietário.
              </p>
              <p className="text-sm text-foreground/80">
                Placa <strong>{state.placa}</strong>
                {state.renavam ? <> e RENAVAM <strong>{state.renavam}</strong></> : null}
                {" "}foram lidos. Falta só o documento do dono.
              </p>
              <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-[44px] w-full sm:w-auto"
                  onClick={handleRetry}
                >
                  Tentar outra foto
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  className="min-h-[44px] w-full sm:w-auto"
                  onClick={() => setManualMode(true)}
                >
                  Preencher manualmente
                </Button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* Alerta de tipo de veiculo divergente do esperado (cavalo vs carreta) */}
      {vehicleTypeMismatch ? (
        <div
          role="alert"
          className="rounded-2xl border border-destructive/40 bg-destructive/5 p-4"
        >
          <div className="flex items-start gap-3">
            <ShieldAlert
              className="mt-0.5 size-6 shrink-0 text-destructive"
              aria-hidden="true"
            />
            <div className="flex-1 space-y-2">
              <p className="text-base font-semibold text-foreground">
                Esse CRLV é de uma {vehicleTypeMismatch.actualType}, não de um {vehicleTypeMismatch.expectedType}.
              </p>
              <p className="text-sm text-foreground/80">
                Envie o CRLV do{" "}
                <strong className="text-foreground">{vehicleTypeMismatch.expectedType}</strong> para continuar.
              </p>
              <div className="mt-3">
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-[44px] w-full sm:w-auto"
                  onClick={handleRetry}
                >
                  Trocar arquivo
                </Button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* Alerta de placa divergente (OCR) — UX acessível pra baixa visão:
          texto maior, ícone destacado, hierarquia clara, botões 48px touch. */}
      {plateMismatch ? (
        <div
          className="rounded-2xl border-2 border-amber-400 bg-amber-50 p-5 dark:border-amber-600 dark:bg-amber-950/60"
          role="alert"
          aria-live="polite"
        >
          <div className="flex items-start gap-4">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-amber-100 ring-2 ring-amber-300 dark:bg-amber-900 dark:ring-amber-700">
              <AlertTriangle
                className="h-6 w-6 text-amber-700 dark:text-amber-300"
                aria-hidden="true"
              />
            </div>
            <div className="flex-1 space-y-3">
              <p className="text-lg font-bold leading-tight text-foreground">
                Qual placa deseja usar?
              </p>
              <p className="text-base leading-snug text-foreground/90">
                As placas do documento e da candidatura são diferentes. Escolha
                qual cadastrar.
              </p>
              <dl className="grid grid-cols-1 gap-2 rounded-xl bg-white/70 p-3 text-base dark:bg-black/30 sm:grid-cols-2">
                <div className="space-y-1">
                  <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Do documento
                  </dt>
                  <dd className="font-mono text-xl font-bold text-foreground">
                    {plateMismatch.ocrPlate}
                  </dd>
                </div>
                <div className="space-y-1">
                  <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Da candidatura
                  </dt>
                  <dd className="font-mono text-xl font-bold text-foreground">
                    {plate}
                  </dd>
                </div>
              </dl>
              <div className="flex flex-col gap-2 pt-1">
                <Button
                  type="button"
                  variant="default"
                  className="min-h-[48px] w-full text-base font-semibold"
                  onClick={handleChooseDocument}
                  disabled={plateCheckStatus === "checking"}
                >
                  Usar do documento ({plateMismatch.ocrPlate})
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-[48px] w-full border-2 text-base font-semibold"
                  onClick={handleChooseCandidacy}
                  disabled={plateCheckStatus === "checking"}
                >
                  Usar da candidatura ({plate})
                </Button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* Resultado da verificação de cadastro para placa do documento */}
      {plateCheckStatus === "checking" ? (
        <p className="text-xs text-muted-foreground">
          Verificando cadastro para a nova placa…
        </p>
      ) : plateCheckStatus === "already_registered" ? (
        <div className="rounded-2xl border border-emerald-300 bg-emerald-50 p-3.5 dark:border-emerald-700 dark:bg-emerald-950">
          <div className="flex items-start gap-2.5">
            <CheckCircle2
              className="mt-0.5 size-4 shrink-0 text-emerald-700"
              aria-hidden="true"
            />
            <p className="text-xs font-medium text-foreground">
              Esta placa já tem cadastro vigente
              {plateCheckDays != null ? ` (${formatExpiryLabel(plateCheckDays).short})` : ""}.
              {" "}Não vai precisar enviar todos os documentos de novo — só confirmar o que mudou.
            </p>
          </div>
        </div>
      ) : plateCheckStatus === "not_found" ? (
        <div className="rounded-2xl border border-sky-200 bg-sky-50 p-3.5 dark:border-sky-800 dark:bg-sky-950">
          <div className="flex items-start gap-2.5">
            <Info className="mt-0.5 size-4 shrink-0 text-sky-600" aria-hidden="true" />
            <p className="text-xs font-medium text-foreground">
              Esta placa ainda não está cadastrada. Prossiga para completar o cadastro.
            </p>
          </div>
        </div>
      ) : null}

      {pdfSizeWarning ? (
        <p className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-500">
          <span aria-hidden="true">⚠️</span>
          {pdfSizeWarning}
        </p>
      ) : null}

      {manualMode ? (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="vehicle-placa">
              Placa <span className="text-destructive">*</span>
            </Label>
            <Input
              id="vehicle-placa"
              value={state.placa}
              onChange={(event) =>
                updateState({
                  placa: event.target.value.toUpperCase().replace(/\s/g, ""),
                })
              }
              maxLength={7}
              required
            />
            {renderCheckBadge("placa")}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="vehicle-owner-doc">
              CPF/CNPJ do proprietário{" "}
              <span className="text-destructive">*</span>
            </Label>
            <Input
              id="vehicle-owner-doc"
              inputMode="numeric"
              value={state.ownerDoc}
              onChange={(event) => handleManualDocChange(event.target.value)}
              placeholder="Apenas dígitos (11 para CPF, 14 para CNPJ)"
              required
            />
          </div>

          <MoreOptionsToggle
            label="Mostrar dados do CRLV (RENAVAM, chassi, ano, cor)"
            collapseLabel="Esconder dados do CRLV"
            defaultOpen={Boolean(
              state.renavam || state.chassi || state.marca || state.ano || state.cor,
            )}
          >
            <div className="space-y-1.5">
              <Label htmlFor="vehicle-renavam">RENAVAM</Label>
              <Input
                id="vehicle-renavam"
                inputMode="numeric"
                value={state.renavam}
                onChange={(event) =>
                  updateState({ renavam: onlyDigits(event.target.value) })
                }
              />
              {renderCheckBadge("renavam")}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="vehicle-chassi">Chassi</Label>
              <Input
                id="vehicle-chassi"
                value={state.chassi}
                onChange={(event) =>
                  updateState({ chassi: event.target.value.toUpperCase() })
                }
              />
              {renderCheckBadge("chassi")}
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="vehicle-marca">Marca / Modelo</Label>
                <Input
                  id="vehicle-marca"
                  value={state.marca}
                  onChange={(event) =>
                    updateState({ marca: event.target.value })
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="vehicle-ano">Ano</Label>
                <Input
                  id="vehicle-ano"
                  inputMode="numeric"
                  maxLength={4}
                  value={state.ano}
                  onChange={(event) =>
                    updateState({
                      ano: onlyDigits(event.target.value).slice(0, 4),
                    })
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="vehicle-cor">Cor</Label>
                <Input
                  id="vehicle-cor"
                  value={state.cor}
                  onChange={(event) => updateState({ cor: event.target.value })}
                />
              </div>
            </div>
          </MoreOptionsToggle>

          {/* Alerta de placa divergente (modo manual) — UX acessível baixa visão */}
          {manualPlateMismatch ? (
            <div
              className="rounded-2xl border-2 border-amber-400 bg-amber-50 p-5 dark:border-amber-600 dark:bg-amber-950/60"
              role="alert"
              aria-live="polite"
            >
              <div className="flex items-start gap-4">
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-amber-100 ring-2 ring-amber-300 dark:bg-amber-900 dark:ring-amber-700">
                  <AlertTriangle
                    className="h-6 w-6 text-amber-700 dark:text-amber-300"
                    aria-hidden="true"
                  />
                </div>
                <div className="flex-1 space-y-3">
                  <p className="text-lg font-bold leading-tight text-foreground">
                    Placa diferente da candidatura
                  </p>
                  <p className="text-base leading-snug text-foreground/90">
                    Você digitou uma placa diferente da que está na candidatura.
                  </p>
                  <dl className="grid grid-cols-1 gap-2 rounded-xl bg-white/70 p-3 text-base dark:bg-black/30 sm:grid-cols-2">
                    <div className="space-y-1">
                      <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        Digitada
                      </dt>
                      <dd className="font-mono text-xl font-bold text-foreground">
                        {state.placa}
                      </dd>
                    </div>
                    <div className="space-y-1">
                      <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        Da candidatura
                      </dt>
                      <dd className="font-mono text-xl font-bold text-foreground">
                        {plate}
                      </dd>
                    </div>
                  </dl>
                  <Button
                    type="button"
                    variant="default"
                    className="min-h-[48px] w-full text-base font-semibold"
                    onClick={() => updateState({ placa: plate })}
                  >
                    Usar da candidatura ({plate})
                  </Button>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
