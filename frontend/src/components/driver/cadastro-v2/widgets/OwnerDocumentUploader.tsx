import { useEffect, useRef, useState } from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DriverAlert } from "@/components/driver/ui/DriverAlert";
import { isValidCnpj, isValidCpf } from "@/lib/brazilianValidators";
import { UFS } from "@/lib/ufs";
import { brDateToIso, ocrCartaoCnpj, ocrCnh } from "@/services/cadastroApi";

import { OcrUploadTile, type OcrTileState } from "./OcrUploadTile";
import { ProgressiveSection } from "./ProgressiveSection";
import type { OcrResultField } from "./OcrResultReview";

/**
 * 2026-05-18 — Extras opcionais do proprietario PF (filiacao, RG, detalhes da
 * CNH) propagados via onExtracted. Substituiu o sub-card `CcDadosPessoaisPropPF`
 * que ficava como card separado em StepC/StepE. Agora vivem inline no
 * OwnerDocumentUploader, atras de um ProgressiveSection colapsado por default.
 */
export interface OwnerExtras {
  nome_pai?: string;
  nome_mae?: string;
  naturalidade?: string;
  rg?: string;
  rg_orgao?: string;
  rg_uf?: string;
  tem_cnh?: boolean;
  situacao_cnh?: string;
  cnh?: {
    registro?: string;
    categoria?: string;
    validade?: string;
    codigo_seguranca?: string;
    numero_espelho?: string;
    uf_emissor?: string;
    primeira_emissao?: string;
  };
}

export interface OwnerExtractedData {
  nome?: string;
  documento: string;
  /** Data de nascimento (PF) — quando OCR extrai ou usuario preenche manualmente. */
  dataNascimento?: string;
  /** Numero da CNH (PF) — manual fallback ou OCR. */
  cnhNumero?: string;
  /** Resposta crua do OCR (pode incluir endereco no caso de PJ). */
  raw?: Record<string, unknown>;
  /** CADASTRO-14: motorista preencheu manualmente. */
  ocr_fallback_manual?: boolean;
  /**
   * 2026-05-18 — Extras opcionais do proprietario PF (filiacao, RG, detalhes
   * da CNH). Editaveis dentro do OwnerDocumentUploader atras de um
   * ProgressiveSection colapsado por default. Propagados ao caller (StepC/E)
   * via onExtracted; o caller salva em `StepXData.owner_extras` e o
   * buildSubmitDados emite no payload.
   */
  extras?: OwnerExtras;
}

export interface OwnerDocumentUploaderProps {
  ownerDocType: "cpf" | "cnpj";
  /**
   * Documento esperado (vindo do CRLV/ANTT) — quando definido, o uploader
   * BLOQUEIA o avanço caso o OCR ou o preenchimento manual produza documento
   * diferente. onExtracted nao e emitido enquanto houver mismatch, e o
   * DriverAlert mostra exatamente qual documento o motorista precisa enviar.
   */
  expectedDocument?: string;
  /** Acionado quando o OCR ou o preenchimento manual produzem dados completos. */
  onExtracted: (data: OwnerExtractedData) => void;
  /**
   * Notifica o caller quando o documento extraído diverge do expectedDocument
   * (telemetria / analytics futuro). Sem fallback de bloqueio: o uploader
   * ja para de emitir onExtracted quando ha mismatch.
   */
  onMismatch?: (extracted: string, expected: string) => void;
  /** Forca modo manual desde o inicio. */
  manualMode?: boolean;
  /** Notifica o pai quando o usuario alterna para modo manual via OcrResultReview. */
  onSwitchToManual?: () => void;
  /**
   * 2026-05-18 — Extras restaurados do draft (ProgressiveSection inline).
   * Quando o caller (StepC/E) tem `owner_extras` persistido, repassa aqui
   * para preencher os campos colapsados.
   */
  initialExtras?: OwnerExtras;
  /**
   * Slot p/ persistência draft (ex.: "cavalo_owner_cnh", "carreta_owner_cnh_0").
   * Caller decide; widget é reutilizado em Step C (cavalo) e Step E (carreta).
   */
  slot?: string;
  cargaId?: string;
  cpf?: string;
  accessToken?: string | null;
  onDraftPersisted?: (storagePath: string) => void;
  draftPersisted?: boolean;
}

function formatCpfMask(value: string): string {
  const digits = value.replace(/\D/g, "").slice(0, 11);
  if (digits.length <= 3) return digits;
  if (digits.length <= 6) return `${digits.slice(0, 3)}.${digits.slice(3)}`;
  if (digits.length <= 9) {
    return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6)}`;
  }
  return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9)}`;
}

function formatCnpjMask(value: string): string {
  const digits = value.replace(/\D/g, "").slice(0, 14);
  if (digits.length <= 2) return digits;
  if (digits.length <= 5) return `${digits.slice(0, 2)}.${digits.slice(2)}`;
  if (digits.length <= 8) {
    return `${digits.slice(0, 2)}.${digits.slice(2, 5)}.${digits.slice(5)}`;
  }
  if (digits.length <= 12) {
    return `${digits.slice(0, 2)}.${digits.slice(2, 5)}.${digits.slice(5, 8)}/${digits.slice(8)}`;
  }
  return `${digits.slice(0, 2)}.${digits.slice(2, 5)}.${digits.slice(5, 8)}/${digits.slice(8, 12)}-${digits.slice(12)}`;
}

function buildFields(
  ownerDocType: "cpf" | "cnpj",
  nome: string,
  documento: string,
): OcrResultField[] {
  const fields: OcrResultField[] = [];
  if (nome) {
    fields.push({
      label: ownerDocType === "cpf" ? "Nome" : "Razão social",
      value: nome,
    });
  }
  if (documento) {
    fields.push({
      label: ownerDocType === "cpf" ? "CPF" : "CNPJ",
      value:
        ownerDocType === "cpf" ? formatCpfMask(documento) : formatCnpjMask(documento),
    });
  }
  return fields;
}

/**
 * Wrapper reutilizavel sobre OcrUploadTile que bifurca o fluxo OCR conforme o tipo
 * do documento do proprietario:
 *  - cpf -> OCR de CNH (`/ocr-api/api/ocr/cnh`)
 *  - cnpj -> OCR de Cartao CNPJ (`/ocr-api/api/ocr/cartao-cnpj`, provider EasyOCR)
 *
 * Caso o OCR falhe ou o usuario opte por "Corrigir manualmente", entra em modo
 * manual com Inputs validados via isValidCpf/isValidCnpj.
 */
export function OwnerDocumentUploader({
  ownerDocType,
  expectedDocument,
  onExtracted,
  onMismatch,
  manualMode: initialManualMode = false,
  onSwitchToManual,
  initialExtras,
  slot,
  cargaId,
  cpf,
  accessToken,
  onDraftPersisted,
  draftPersisted,
}: OwnerDocumentUploaderProps) {
  const [tileState, setTileState] = useState<OcrTileState>("empty");
  const [previewName, setPreviewName] = useState<string | undefined>(undefined);
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);
  const [manualMode, setManualMode] = useState(initialManualMode);
  const [nome, setNome] = useState("");
  const [documento, setDocumento] = useState("");
  const [dataNascimento, setDataNascimento] = useState("");
  const [cnhNumero, setCnhNumero] = useState("");
  // 2026-05-18 — Extras editáveis dentro do ProgressiveSection inline.
  // OCR popula no handleFile; usuario pode editar; valor flui de volta para
  // o caller (StepC/E) via onExtracted no useEffect abaixo.
  const [extras, setExtras] = useState<OwnerExtras | undefined>(initialExtras);
  // R-02 P0: evita re-emitir onExtracted em loop a cada keystroke. Guardamos
  // o hash JSON do último payload emitido e só chamamos novamente se mudou.
  // Isolamento no child — independe de o parent memoizar a callback.
  const lastEmittedRef = useRef<string>("");

  useEffect(() => {
    if (initialManualMode) setManualMode(true);
  }, [initialManualMode]);

  // Sincroniza onExtracted quando algum campo muda (inclui edits no
  // ProgressiveSection de extras: filiacao/RG/CNH).
  // 2026-05-20: NAO emite quando ha mismatch contra expectedDocument — caller
  // mantem continueEnabled=false ate o motorista trocar pelo doc correto.
  useEffect(() => {
    const digits = documento.replace(/\D/g, "");
    const expectedDigitsLocal = expectedDocument
      ? expectedDocument.replace(/\D/g, "")
      : "";
    const docValid =
      ownerDocType === "cpf" ? isValidCpf(digits) : isValidCnpj(digits);
    const mismatchLocal =
      expectedDigitsLocal.length > 0 &&
      digits.length > 0 &&
      digits !== expectedDigitsLocal;
    if (docValid && nome.trim().length > 0 && !mismatchLocal) {
      const payload: OwnerExtractedData = {
        documento: digits,
        nome: nome.trim(),
        dataNascimento: dataNascimento || undefined,
        cnhNumero: cnhNumero || undefined,
        ocr_fallback_manual: manualMode,
        ...(extras ? { extras } : {}),
      };
      const serialized = JSON.stringify(payload);
      if (serialized !== lastEmittedRef.current) {
        lastEmittedRef.current = serialized;
        onExtracted(payload);
      }
    } else if (mismatchLocal) {
      // Reseta o cache para que, quando o motorista trocar pelo doc certo,
      // o proximo emit nao seja suprimido por igualdade serializada.
      lastEmittedRef.current = "";
      if (onMismatch) onMismatch(digits, expectedDigitsLocal);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documento, nome, ownerDocType, dataNascimento, cnhNumero, manualMode, extras, expectedDocument]);

  const handleFile = async (file: File) => {
    setPreviewName(file.name);
    setTileState("uploading");
    setErrorMessage(undefined);
    try {
      if (ownerDocType === "cpf") {
        const extracted = await ocrCnh(file);
        const cpfDigits = extracted.pessoal.cpf.replace(/\D/g, "");
        const extractedNome = extracted.pessoal.nome || "";
        const extractedDataNasc = brDateToIso(extracted.pessoal.data_nascimento || "");
        const extractedCnhNum = extracted.cnh.registro || "";
        setNome(extractedNome);
        setDocumento(cpfDigits);
        setDataNascimento(extractedDataNasc);
        setCnhNumero(extractedCnhNum);
        setTileState("success");
        // 2026-05-18 — popula extras (filiacao/RG/CNH details) que ficam
        // visiveis dentro do ProgressiveSection inline. Substituiu o sub-card
        // CcDadosPessoaisPropPF que antes era card separado em StepC/StepE.
        const nextExtras: OwnerExtras = {
          nome_pai: extracted.pessoal.nome_pai || undefined,
          nome_mae: extracted.pessoal.nome_mae || undefined,
          naturalidade: extracted.pessoal.naturalidade || undefined,
          rg: extracted.pessoal.rg || undefined,
          rg_orgao: extracted.pessoal.rg_orgao || undefined,
          rg_uf: extracted.pessoal.rg_uf || undefined,
          tem_cnh: true,
          cnh: {
            registro: extractedCnhNum || undefined,
            categoria: extracted.cnh.categoria || undefined,
            validade: extracted.cnh.validade || undefined,
            codigo_seguranca: extracted.cnh.codigo_seguranca || undefined,
            numero_espelho: extracted.cnh.numero_espelho || undefined,
            uf_emissor: extracted.cnh.uf_emissor || undefined,
            primeira_emissao: extracted.cnh.primeira_emissao || undefined,
          },
        };
        setExtras(nextExtras);
        // 2026-05-20: nao emite se OCR extraiu CPF diferente do expectedDocument
        // (CRLV/ANTT). DriverAlert na UI explica de quem o motorista deve enviar.
        const expectedDigitsLocal = expectedDocument
          ? expectedDocument.replace(/\D/g, "")
          : "";
        const mismatchLocal =
          expectedDigitsLocal.length > 0 &&
          cpfDigits.length > 0 &&
          cpfDigits !== expectedDigitsLocal;
        if (mismatchLocal && onMismatch) onMismatch(cpfDigits, expectedDigitsLocal);
        if (cpfDigits.length === 11 && extractedNome && !mismatchLocal) {
          onExtracted({
            documento: cpfDigits,
            nome: extractedNome,
            dataNascimento: extractedDataNasc || undefined,
            cnhNumero: extractedCnhNum || undefined,
            raw: extracted as unknown as Record<string, unknown>,
            extras: nextExtras,
          });
        }
      } else {
        const extracted = await ocrCartaoCnpj(file);
        const cnpjDigits = (extracted.cnpj || "").replace(/\D/g, "");
        const extractedNome = extracted.razao_social || extracted.nome_fantasia || "";
        // BUG-FIX 2026-05-26: antes setTileState("success") era chamado sempre
        // após OCR sem erro HTTP, mesmo quando cnpjDigits/razao_social vinham
        // vazios (ex.: motorista anexou um CRLV no slot de Cartão CNPJ). O
        // tile virava verde "Dados extraídos com sucesso" enganando o
        // usuário. Agora só marca sucesso quando há CNPJ válido (14 dígitos)
        // E razão social. Caso contrário, falha com mensagem específica
        // pedindo o documento certo.
        if (cnpjDigits.length !== 14 || !extractedNome.trim()) {
          setTileState("failure");
          setErrorMessage(
            "Não conseguimos ler CNPJ e razão social desse arquivo. " +
              "Confira se você enviou o Cartão CNPJ (foto ou PDF), não outro documento.",
          );
          return;
        }
        setNome(extractedNome);
        setDocumento(cnpjDigits);
        setTileState("success");
        const expectedDigitsLocal = expectedDocument
          ? expectedDocument.replace(/\D/g, "")
          : "";
        const mismatchLocal =
          expectedDigitsLocal.length > 0 &&
          cnpjDigits.length > 0 &&
          cnpjDigits !== expectedDigitsLocal;
        if (mismatchLocal && onMismatch) onMismatch(cnpjDigits, expectedDigitsLocal);
        if (!mismatchLocal) {
          onExtracted({
            documento: cnpjDigits,
            nome: extractedNome,
            raw: extracted as unknown as Record<string, unknown>,
          });
        }
      }
    } catch (err) {
      setTileState("failure");
      setErrorMessage(
        err instanceof Error ? err.message : "Falha ao processar documento.",
      );
    }
  };

  const handleManualFallback = () => {
    setManualMode(true);
    setTileState("manual");
    setErrorMessage(undefined);
    if (onSwitchToManual) onSwitchToManual();
  };

  const handleRetry = () => {
    setTileState("empty");
    setErrorMessage(undefined);
    setPreviewName(undefined);
  };

  const updateExtras = (patch: Partial<OwnerExtras>) => {
    setExtras((current) => ({ ...(current ?? {}), ...patch }));
  };

  const updateExtrasCnh = (patch: Partial<NonNullable<OwnerExtras["cnh"]>>) => {
    setExtras((current) => ({
      ...(current ?? {}),
      cnh: { ...(current?.cnh ?? {}), ...patch },
    }));
  };

  const handleDocumentoChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    // Bug 5 P2: armazenar somente dígitos para evitar perda de valor quando o
    // schema/validação Zod espera CPF/CNPJ não-formatado. Pontuação digitada é
    // removida; o placeholder e o inputMode orientam o usuário.
    const maxLen = ownerDocType === "cpf" ? 11 : 14;
    const digits = event.target.value.replace(/\D/g, "").slice(0, maxLen);
    setDocumento(digits);
  };

  const fields = buildFields(ownerDocType, nome, documento);
  const docDigits = documento.replace(/\D/g, "");
  const docValid =
    ownerDocType === "cpf" ? isValidCpf(docDigits) : isValidCnpj(docDigits);
  const expectedDigits = expectedDocument ? expectedDocument.replace(/\D/g, "") : "";
  const mismatch =
    expectedDigits.length > 0 &&
    docDigits.length > 0 &&
    docDigits !== expectedDigits;

  const ocrLabel =
    ownerDocType === "cpf" ? "CNH do proprietário" : "Cartão CNPJ";
  const ocrHelper =
    ownerDocType === "cpf"
      ? "Frente, com todos os dados visíveis (foto ou PDF)"
      : "Frente, com razão social e CNPJ visíveis (foto ou PDF)";

  return (
    <div className="space-y-4">
      <OcrUploadTile
        accept="image/*,application/pdf"
        maxSizeMb={8}
        label={ocrLabel}
        helper={ocrHelper}
        state={tileState}
        previewName={previewName}
        extractedData={tileState === "success" && !manualMode ? fields : undefined}
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

      {/* Alert bloqueante: documento extraido nao bate com o proprietario
          identificado no CRLV/ANTT. Caller mantem continueEnabled=false porque
          onExtracted nao foi emitido enquanto houver mismatch. */}
      {mismatch ? (
        <DriverAlert
          variant="warning"
          title="Documento de outra pessoa"
          description={
            ownerDocType === "cpf" ? (
              <>
                Proprietário no CRLV: <strong>CPF {formatCpfMask(expectedDigits)}</strong>.
                <br />
                Envie a <strong>CNH dessa pessoa</strong>.
              </>
            ) : (
              <>
                Proprietário no CRLV: <strong>CNPJ {formatCnpjMask(expectedDigits)}</strong>.
                <br />
                Envie o <strong>cartão CNPJ dessa empresa</strong>.
              </>
            )
          }
          primaryAction={{
            label: "Trocar arquivo",
            onClick: handleRetry,
          }}
        />
      ) : null}

      {manualMode || tileState === "success" ? (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="owner-nome">
              {ownerDocType === "cpf" ? "Nome completo" : "Razão social"}{" "}
              <span className="text-destructive">*</span>
            </Label>
            <Input
              id="owner-nome"
              value={nome}
              onChange={(event) => setNome(event.target.value)}
              autoComplete={ownerDocType === "cpf" ? "name" : "organization"}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="owner-documento">
              {ownerDocType === "cpf" ? "CPF" : "CNPJ"}{" "}
              <span className="text-destructive">*</span>
            </Label>
            <Input
              id="owner-documento"
              inputMode="numeric"
              value={documento}
              onChange={handleDocumentoChange}
              placeholder={
                ownerDocType === "cpf"
                  ? "Apenas dígitos (11 para CPF)"
                  : "Apenas dígitos (14 para CNPJ)"
              }
              maxLength={ownerDocType === "cpf" ? 11 : 14}
              aria-invalid={docDigits.length > 0 && !docValid}
              required
            />
            {docDigits.length > 0 && !docValid ? (
              <p className="text-xs text-destructive">
                {ownerDocType === "cpf"
                  ? "CPF inválido. Confira os 11 dígitos."
                  : "CNPJ inválido. Confira os 14 dígitos."}
              </p>
            ) : null}
          </div>
          {ownerDocType === "cpf" && manualMode ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="owner-data-nasc">Data de nascimento</Label>
                <Input
                  id="owner-data-nasc"
                  type="date"
                  value={dataNascimento}
                  onChange={(event) => setDataNascimento(event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="owner-cnh-num">Número da CNH</Label>
                <Input
                  id="owner-cnh-num"
                  inputMode="numeric"
                  value={cnhNumero}
                  onChange={(event) =>
                    setCnhNumero(event.target.value.replace(/\D/g, "").slice(0, 11))
                  }
                />
              </div>
            </div>
          ) : null}

          {/* 2026-05-18 — Extras opcionais do proprietario PF (filiacao, RG,
              detalhes da CNH). Substituiu o sub-card CcDadosPessoaisPropPF.
              Default colapsado: motorista so expande se quiser conferir/editar.
              Quando o OCR Infosimples extrai esses campos, eles ja vem
              pre-preenchidos. */}
          {ownerDocType === "cpf" ? (
            <ProgressiveSection
              title="Outros dados extraídos da CNH (opcional)"
              description="Filiação, RG e detalhes da CNH do proprietário. Toque para conferir ou editar."
              defaultExpanded={false}
            >
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="owner-nome-pai">Nome do pai</Label>
                  <Input
                    id="owner-nome-pai"
                    value={extras?.nome_pai ?? ""}
                    onChange={(event) => updateExtras({ nome_pai: event.target.value })}
                    autoComplete="off"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="owner-nome-mae">Nome da mãe</Label>
                  <Input
                    id="owner-nome-mae"
                    value={extras?.nome_mae ?? ""}
                    onChange={(event) => updateExtras({ nome_mae: event.target.value })}
                    autoComplete="off"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="owner-naturalidade">Naturalidade</Label>
                  <Input
                    id="owner-naturalidade"
                    value={extras?.naturalidade ?? ""}
                    onChange={(event) =>
                      updateExtras({ naturalidade: event.target.value })
                    }
                    placeholder="Cidade/UF de nascimento"
                    autoComplete="off"
                  />
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_140px_100px]">
                  <div className="space-y-1.5">
                    <Label htmlFor="owner-rg">RG</Label>
                    <Input
                      id="owner-rg"
                      value={extras?.rg ?? ""}
                      onChange={(event) => updateExtras({ rg: event.target.value })}
                      autoComplete="off"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="owner-rg-orgao">Órgão emissor</Label>
                    <Input
                      id="owner-rg-orgao"
                      value={extras?.rg_orgao ?? ""}
                      onChange={(event) =>
                        updateExtras({ rg_orgao: event.target.value })
                      }
                      placeholder="SSP"
                      autoComplete="off"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="owner-rg-uf">UF</Label>
                    <select
                      id="owner-rg-uf"
                      value={extras?.rg_uf ?? ""}
                      onChange={(event) =>
                        updateExtras({ rg_uf: event.target.value })
                      }
                      className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    >
                      <option value="">--</option>
                      {UFS.map((uf) => (
                        <option key={uf.value} value={uf.value}>
                          {uf.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={extras?.tem_cnh ?? true}
                    onChange={(event) =>
                      updateExtras({ tem_cnh: event.target.checked })
                    }
                  />
                  <span>Possui CNH</span>
                </label>

                {extras?.tem_cnh === false ? (
                  <div className="space-y-1.5">
                    <Label htmlFor="owner-situacao-cnh">Situação da CNH</Label>
                    <Input
                      id="owner-situacao-cnh"
                      value={extras?.situacao_cnh ?? ""}
                      onChange={(event) =>
                        updateExtras({ situacao_cnh: event.target.value })
                      }
                      placeholder="Ex.: Suspensa, cassada, em renovação"
                    />
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <div className="space-y-1.5">
                        <Label htmlFor="owner-cnh-registro">Número de registro</Label>
                        <Input
                          id="owner-cnh-registro"
                          value={extras?.cnh?.registro ?? ""}
                          onChange={(event) =>
                            updateExtrasCnh({ registro: event.target.value })
                          }
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="owner-cnh-categoria">Categoria</Label>
                        <Input
                          id="owner-cnh-categoria"
                          value={extras?.cnh?.categoria ?? ""}
                          onChange={(event) =>
                            updateExtrasCnh({ categoria: event.target.value })
                          }
                          placeholder="AB, AE, D, E…"
                        />
                      </div>
                    </div>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <div className="space-y-1.5">
                        <Label htmlFor="owner-cnh-validade">Validade</Label>
                        <Input
                          id="owner-cnh-validade"
                          type="date"
                          value={extras?.cnh?.validade ?? ""}
                          onChange={(event) =>
                            updateExtrasCnh({ validade: event.target.value })
                          }
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="owner-cnh-primeira">Primeira emissão</Label>
                        <Input
                          id="owner-cnh-primeira"
                          type="date"
                          value={extras?.cnh?.primeira_emissao ?? ""}
                          onChange={(event) =>
                            updateExtrasCnh({ primeira_emissao: event.target.value })
                          }
                        />
                      </div>
                    </div>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_100px]">
                      <div className="space-y-1.5">
                        <Label htmlFor="owner-cnh-codseg">Código de segurança</Label>
                        <Input
                          id="owner-cnh-codseg"
                          value={extras?.cnh?.codigo_seguranca ?? ""}
                          onChange={(event) =>
                            updateExtrasCnh({ codigo_seguranca: event.target.value })
                          }
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="owner-cnh-espelho">Número do espelho</Label>
                        <Input
                          id="owner-cnh-espelho"
                          value={extras?.cnh?.numero_espelho ?? ""}
                          onChange={(event) =>
                            updateExtrasCnh({ numero_espelho: event.target.value })
                          }
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="owner-cnh-uf-emissor">UF emissor</Label>
                        <select
                          id="owner-cnh-uf-emissor"
                          value={extras?.cnh?.uf_emissor ?? ""}
                          onChange={(event) =>
                            updateExtrasCnh({ uf_emissor: event.target.value })
                          }
                          className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                        >
                          <option value="">--</option>
                          {UFS.map((uf) => (
                            <option key={uf.value} value={uf.value}>
                              {uf.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </ProgressiveSection>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
