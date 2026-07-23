import { useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, Clock, XCircle } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ocrCnh } from "@/services/cadastroApi";
import { isValidCpf, onlyDigits } from "@/lib/brazilianValidators";
import { UFS } from "@/lib/ufs";

import { useVerifyDocument } from "../useVerifyDocument";
import { OcrUploadTile, type OcrTileState } from "../widgets/OcrUploadTile";
import { ProgressiveSection } from "../widgets/ProgressiveSection";
import type { OcrResultField } from "../widgets/OcrResultReview";

export interface A1Data {
  nome: string;
  cpf: string;
  dataNascimento?: string;
  categoria: string;
  validade: string;
  documentUrl?: string;
  /** CADASTRO-14: motorista digitou os dados manualmente. */
  ocr_fallback_manual?: boolean;
  /** Path do arquivo persistido no bucket `cadastro-drafts` (slot motorista_cnh). */
  storage_path?: string;
  // 2026-05-18: paridade /cadastro — campos extras que o OCR Infosimples
  // da CNH ja retorna. Preenchidos automaticamente em handleFile; sobem
  // para o wizard via onChange e o StepAMotorista deriva A1cData
  // (sub-card "Dados pessoais e RG") sem motorista digitar novamente.
  nome_pai?: string;
  nome_mae?: string;
  naturalidade?: string;
  rg?: string;
  rg_orgao?: string;
  rg_uf?: string;
  /** Número de registro da CNH (campo `registro` — o "número" da CNH). */
  registro?: string;
  cnh_codigo_seguranca?: string;
  cnh_numero_espelho?: string;
  cnh_uf_emissor?: string;
  cnh_primeira_emissao?: string;
}

export interface A1DriverProfile {
  document_number: string;
  nome?: string;
}

export interface A1CnhProps {
  driverProfile: A1DriverProfile;
  value?: A1Data;
  onChange: (data: A1Data) => void;
  onValid: (valid: boolean) => void;
  /**
   * Callback opcional: adota o CPF/nome extraído da CNH como nova identidade da
   * candidatura. Quando ausente, o botão "Atualizar candidatura para este CPF"
   * não é renderizado (UX antiga preservada).
   */
  onAdoptCnhData?: (data: { cpf: string; nome: string }) => Promise<void>;
  /** Contexto p/ persistência no bucket `cadastro-drafts` (slot motorista_cnh). */
  cargaId?: string;
  cpf?: string;
  accessToken?: string | null;
}

const CATEGORIA_OPTIONS = ["A", "B", "C", "D", "E", "AB", "AC", "AD", "AE"] as const;
const EMPTY_DATA: A1Data = {
  nome: "",
  cpf: "",
  dataNascimento: "",
  categoria: "",
  validade: "",
};

function digitsOnly(value: string | undefined | null): string {
  return String(value ?? "").replace(/\D/g, "");
}

type CnhValidityLevel = "ok" | "soon" | "expired" | "unknown";

function cnhStatusFromValidade(validadeIso: string): {
  level: CnhValidityLevel;
  label: string;
  diasRestantes: number | null;
} {
  if (!validadeIso) return { level: "unknown", label: "Data de validade não informada", diasRestantes: null };
  const expiry = new Date(`${validadeIso}T00:00:00`);
  if (Number.isNaN(expiry.getTime())) return { level: "unknown", label: "Data inválida", diasRestantes: null };
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diasRestantes = Math.floor((expiry.getTime() - today.getTime()) / 86400000);
  if (diasRestantes < 0) {
    return { level: "expired", label: `CNH vencida há ${-diasRestantes} dia${-diasRestantes === 1 ? "" : "s"}`, diasRestantes };
  }
  if (diasRestantes <= 30) {
    return { level: "soon", label: `CNH vence em ${diasRestantes} dia${diasRestantes === 1 ? "" : "s"}`, diasRestantes };
  }
  return { level: "ok", label: "CNH vigente", diasRestantes };
}

function buildExtractedFields(data: A1Data): OcrResultField[] {
  const fields: OcrResultField[] = [];
  if (data.nome) fields.push({ label: "Nome", value: data.nome });
  if (data.cpf) fields.push({ label: "CPF", value: data.cpf });
  if (data.dataNascimento) {
    fields.push({ label: "Data de nascimento", value: data.dataNascimento });
  }
  if (data.categoria) fields.push({ label: "Categoria", value: data.categoria });
  if (data.validade) fields.push({ label: "Validade", value: data.validade });
  return fields;
}

/**
 * Sub-etapa A1 — Upload da CNH com OCR (Infosimples via FastAPI /ocr-api).
 *
 * Fluxo:
 *  - usuario tira/envia foto -> OCR extrai nome/cpf/dataNascimento/categoria/validade
 *  - sistema valida CPF do OCR contra driverProfile.document_number
 *  - se divergir: banner danger + link WhatsApp suporte; bloqueia avanço
 *  - se sucesso: campos editaveis (nome, categoria, validade) pre-populados
 *  - fallback manual: usuario clica "Digitar manualmente" e preenche tudo
 */
export function A1Cnh({
  driverProfile,
  value,
  onChange,
  onValid,
  onAdoptCnhData,
  cargaId,
  cpf,
  accessToken,
}: A1CnhProps) {
  const [data, setData] = useState<A1Data>(value ?? EMPTY_DATA);
  const [tileState, setTileState] = useState<OcrTileState>(value?.cpf ? "success" : "empty");
  const [previewName, setPreviewName] = useState<string | undefined>(undefined);
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);
  const [cpfMismatch, setCpfMismatch] = useState(false);
  const [manualMode, setManualMode] = useState(value?.ocr_fallback_manual ?? false);
  // Estado para o fluxo "Adotar CPF da CNH" (Bug 15/05).
  // adoptLoading: bloqueia o botão "Atualizar candidatura para este CPF" durante o POST.
  const [adoptLoading, setAdoptLoading] = useState(false);

  // 08-21 — Verifica duplicidade quando o CPF extraído/digitado diverge do CPF
  // do motorista autenticado (initialCpf vindo do pre-check). Disparo silencioso
  // — não bloqueia submit, apenas informa.
  const cpfDuplicate = useVerifyDocument({
    type: "cpf",
    value: data.cpf,
    initialValue: driverProfile.document_number,
    isValid: isValidCpf,
    normalize: onlyDigits,
  });

  const revertCpfToInitial = () => {
    const authCpf = digitsOnly(driverProfile.document_number);
    setData((current) => ({ ...current, cpf: authCpf }));
  };

  // Sincroniza com pai (value prop) na primeira renderizacao se houver value
  useEffect(() => {
    if (value) {
      setData(value);
      if (value.cpf) {
        setTileState((current) => (current === "empty" ? "success" : current));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Notifica pai sempre que data muda
  useEffect(() => {
    onChange({ ...data, ocr_fallback_manual: manualMode });
    const expectedCpf = digitsOnly(driverProfile.document_number);
    const extractedCpf = digitsOnly(data.cpf);
    const cpfMatches = expectedCpf.length === 11 && expectedCpf === extractedCpf;
    const baseFilled =
      data.nome.trim().length > 0 &&
      isValidCpf(data.cpf) &&
      data.categoria.trim().length > 0 &&
      data.validade.trim().length > 0;
    const fileProvided = tileState === "success" || manualMode;
    onValid(fileProvided && baseFilled && cpfMatches && !cpfMismatch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, tileState, manualMode, cpfMismatch]);

  const updateData = (patch: Partial<A1Data>) => {
    setData((current) => ({ ...current, ...patch }));
  };

  const handleFile = async (file: File) => {
    setPreviewName(file.name);
    setTileState("uploading");
    setErrorMessage(undefined);
    setCpfMismatch(false);
    setAdoptLoading(false);
    try {
      const extracted = await ocrCnh(file);
      const extractedCpf = digitsOnly(extracted.pessoal.cpf);
      const expectedCpf = digitsOnly(driverProfile.document_number);
      const matches = expectedCpf.length === 11 && expectedCpf === extractedCpf;

      const nextData: A1Data = {
        nome: extracted.pessoal.nome || "",
        cpf: extractedCpf,
        dataNascimento: extracted.pessoal.data_nascimento || "",
        categoria: extracted.cnh.categoria || "",
        validade: extracted.cnh.validade || "",
        // 2026-05-18 — paridade /cadastro: propaga TUDO que o OCR Infosimples
        // extrai da CNH para o wizard. StepAMotorista deriva A1cData (sub-card
        // "Dados pessoais e RG") destes campos sem o motorista precisar
        // digitar de novo.
        nome_pai: extracted.pessoal.nome_pai || undefined,
        nome_mae: extracted.pessoal.nome_mae || undefined,
        naturalidade: extracted.pessoal.naturalidade || undefined,
        rg: extracted.pessoal.rg || undefined,
        rg_orgao: extracted.pessoal.rg_orgao || undefined,
        rg_uf: extracted.pessoal.rg_uf || undefined,
        registro: extracted.cnh.registro || undefined,
        cnh_codigo_seguranca: extracted.cnh.codigo_seguranca || undefined,
        cnh_numero_espelho: extracted.cnh.numero_espelho || undefined,
        cnh_uf_emissor: extracted.cnh.uf_emissor || undefined,
        cnh_primeira_emissao: extracted.cnh.primeira_emissao || undefined,
      };
      // PRESERVA o storage_path: o upload (onDraftPersisted) roda em paralelo ao
      // OCR e normalmente grava o storage_path ANTES do OCR terminar. Um
      // setData(nextData) cru substituía o objeto inteiro e APAGAVA o
      // storage_path já gravado → no envio, dados.motorista.cnh_url ficava vazio
      // e o cadastro era barrado com "Anexe a CNH" mesmo com o arquivo no Storage.
      // Mantemos o storage_path atual (funciona nas duas ordens de corrida).
      setData((current) => ({ ...nextData, storage_path: current.storage_path }));
      setManualMode(false);
      setTileState("success");
      setCpfMismatch(!matches && extractedCpf.length === 11);
    } catch (err) {
      setTileState("failure");
      setErrorMessage(err instanceof Error ? err.message : "Falha ao processar CNH.");
    }
  };

  const handleManualFallback = () => {
    setManualMode(true);
    setTileState("manual");
    setErrorMessage(undefined);
    // Pre-popula CPF do auth (read-only no manual). UI-SPEC: CPF nao manual.
    const authCpf = digitsOnly(driverProfile.document_number);
    if (authCpf.length === 11) {
      setData((current) => ({ ...current, cpf: authCpf }));
    }
  };

  const handleRetry = () => {
    setTileState("empty");
    setErrorMessage(undefined);
    setPreviewName(undefined);
    setAdoptLoading(false);
  };

  const handleAdoptCpf = async () => {
    if (!onAdoptCnhData) return;
    const cnhCpf = digitsOnly(data.cpf);
    const cnhNome = data.nome.trim();
    if (cnhCpf.length !== 11) return;
    setAdoptLoading(true);
    try {
      await onAdoptCnhData({ cpf: cnhCpf, nome: cnhNome });
      setCpfMismatch(false);
        toast.success("Candidatura atualizada com o CPF da CNH");
    } catch (err) {
      console.warn("[A1Cnh] adoção do CPF da CNH falhou", err);
      toast.error("Não deu pra atualizar agora. Tenta de novo daqui a pouco.");
    } finally {
      setAdoptLoading(false);
    }
  };

  const extractedFields = buildExtractedFields(data);

  return (
    <section className="space-y-4" aria-labelledby="step-a1-title">
      <header className="space-y-1">
        <h3 id="step-a1-title" className="text-base font-semibold text-foreground">
          Sua CNH
        </h3>
        <p className="text-sm text-muted-foreground">
          Envie o documento da sua CNH (foto ou arquivo) para preenchermos seus dados automaticamente.
        </p>
      </header>

      <OcrUploadTile
        accept="image/*,application/pdf"
        maxSizeMb={8}
        label="CNH do motorista"
        helper="Frente, com todos os dados visíveis"
        state={tileState}
        previewName={previewName}
        extractedData={tileState === "success" && !manualMode ? extractedFields : undefined}
        errorMessage={errorMessage}
        onFile={(file) => {
          void handleFile(file);
        }}
        onRetry={handleRetry}
        onManualFallback={handleManualFallback}
        slot="motorista_cnh"
        cargaId={cargaId}
        cpf={cpf}
        accessToken={accessToken}
        onDraftPersisted={(result) => {
          setData((current) => ({ ...current, storage_path: result.storage_path }));
        }}
        draftPersisted={Boolean(value?.storage_path)}
      />

      {cpfMismatch ? (
        <div className="space-y-2">
          <div className="admin-tint-danger rounded-2xl border p-3.5 text-sm">
            <div className="flex items-start gap-2.5">
              <AlertCircle
                className="mt-0.5 h-4 w-4 shrink-0 text-destructive"
                aria-hidden="true"
              />
              <div className="space-y-2">
                <p className="font-semibold text-foreground">
                  Os dados da CNH não batem com seu cadastro
                </p>
                <p className="text-xs text-muted-foreground">
                  O CPF da CNH é diferente do que você usou na candidatura. Confira o arquivo, atualize sua candidatura ou fale com a equipe.
                </p>
                <div className="flex flex-wrap gap-2 pt-1">
                  {onAdoptCnhData ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="default"
                      onClick={() => {
                        void handleAdoptCpf();
                      }}
                      disabled={adoptLoading}
                    >
                      Atualizar candidatura para este CPF
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={handleRetry}
                    disabled={adoptLoading}
                  >
                    Trocar arquivo
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* CPF ja cadastrado — alerta INFORMATIVO (nao bloqueia). Mantemos o
          motorista cadastrando para atualizar o cadastro existente; o operador
          analisa quando a vigencia estiver proxima de vencer. Suprime quando o
          mismatch da CNH ja esta sendo mostrado para nao duplicar mensagens. */}
      {cpfDuplicate.shouldWarn && !cpfMismatch ? (
        <div className="admin-card-surface rounded-2xl border border-warning/40 bg-warning/5 p-3.5 text-sm">
          <div className="flex items-start gap-2.5">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
            <div className="space-y-1">
              <p className="font-semibold text-foreground">CPF já cadastrado</p>
              <p className="text-xs text-muted-foreground">
                Continue o cadastro normalmente — vamos atualizar o que você já tem com a gente.
              </p>
            </div>
          </div>
        </div>
      ) : null}

      {tileState === "success" || manualMode ? (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="a1-nome">
              Nome completo <span className="text-destructive">*</span>
            </Label>
            <Input
              id="a1-nome"
              value={data.nome}
              onChange={(event) => updateData({ nome: event.target.value })}
              autoComplete="name"
              required
            />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="a1-categoria">
                Categoria <span className="text-destructive">*</span>
              </Label>
              <select
                id="a1-categoria"
                value={data.categoria}
                onChange={(event) => updateData({ categoria: event.target.value })}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                required
              >
                <option value="">Selecione</option>
                {CATEGORIA_OPTIONS.map((cat) => (
                  <option key={cat} value={cat}>
                    {cat}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="a1-validade">
                Validade <span className="text-destructive">*</span>
              </Label>
              <Input
                id="a1-validade"
                type="date"
                value={data.validade}
                onChange={(event) => updateData({ validade: event.target.value })}
                required
              />
              {data.validade ? (() => {
                const status = cnhStatusFromValidade(data.validade);
                if (status.level === "ok") return (
                  <p className="flex items-center gap-1 text-xs font-medium text-emerald-600">
                    <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                    {status.label}
                  </p>
                );
                if (status.level === "soon") return (
                  <p className="flex items-center gap-1 text-xs font-medium text-amber-600">
                    <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                    {status.label}
                  </p>
                );
                if (status.level === "expired") return (
                  <p className="flex items-center gap-1 text-xs font-medium text-destructive">
                    <XCircle className="h-3.5 w-3.5" aria-hidden="true" />
                    {status.label}
                  </p>
                );
                return null;
              })() : null}
            </div>
          </div>

          {/* 2026-05-18 — Inline collapsible com extras do OCR (filiação, RG, detalhes
              da CNH). Substituiu o sub-card A1c. Default colapsado: motorista só
              expande se quiser conferir/editar. Todos os campos opcionais. */}
          <ProgressiveSection
            title="Outros dados extraídos da CNH (opcional)"
            description="Filiação, RG e detalhes da CNH. Toque para conferir ou editar."
            defaultExpanded={false}
          >
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="a1-nome-pai">Nome do pai</Label>
                <Input
                  id="a1-nome-pai"
                  value={data.nome_pai ?? ""}
                  onChange={(event) => updateData({ nome_pai: event.target.value })}
                  autoComplete="off"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="a1-nome-mae">Nome da mãe</Label>
                <Input
                  id="a1-nome-mae"
                  value={data.nome_mae ?? ""}
                  onChange={(event) => updateData({ nome_mae: event.target.value })}
                  autoComplete="off"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="a1-naturalidade">Naturalidade</Label>
                <Input
                  id="a1-naturalidade"
                  value={data.naturalidade ?? ""}
                  onChange={(event) => updateData({ naturalidade: event.target.value })}
                  placeholder="Cidade/UF de nascimento"
                  autoComplete="off"
                />
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_140px_100px]">
                <div className="space-y-1.5">
                  <Label htmlFor="a1-rg">RG</Label>
                  <Input
                    id="a1-rg"
                    value={data.rg ?? ""}
                    onChange={(event) => updateData({ rg: event.target.value })}
                    autoComplete="off"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="a1-rg-orgao">Órgão emissor</Label>
                  <Input
                    id="a1-rg-orgao"
                    value={data.rg_orgao ?? ""}
                    onChange={(event) => updateData({ rg_orgao: event.target.value })}
                    placeholder="SSP"
                    autoComplete="off"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="a1-rg-uf">UF</Label>
                  <select
                    id="a1-rg-uf"
                    value={data.rg_uf ?? ""}
                    onChange={(event) => updateData({ rg_uf: event.target.value })}
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
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="a1-cnh-codseg">Código de segurança CNH</Label>
                  <Input
                    id="a1-cnh-codseg"
                    value={data.cnh_codigo_seguranca ?? ""}
                    onChange={(event) =>
                      updateData({ cnh_codigo_seguranca: event.target.value })
                    }
                    autoComplete="off"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="a1-cnh-espelho">Número do espelho</Label>
                  <Input
                    id="a1-cnh-espelho"
                    value={data.cnh_numero_espelho ?? ""}
                    onChange={(event) =>
                      updateData({ cnh_numero_espelho: event.target.value })
                    }
                    autoComplete="off"
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-[100px_1fr]">
                <div className="space-y-1.5">
                  <Label htmlFor="a1-cnh-uf-emissor">UF emissor</Label>
                  <select
                    id="a1-cnh-uf-emissor"
                    value={data.cnh_uf_emissor ?? ""}
                    onChange={(event) =>
                      updateData({ cnh_uf_emissor: event.target.value })
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
                <div className="space-y-1.5">
                  <Label htmlFor="a1-cnh-primeira">Primeira emissão</Label>
                  <Input
                    id="a1-cnh-primeira"
                    type="date"
                    value={data.cnh_primeira_emissao ?? ""}
                    onChange={(event) =>
                      updateData({ cnh_primeira_emissao: event.target.value })
                    }
                  />
                </div>
              </div>
            </div>
          </ProgressiveSection>
        </div>
      ) : null}
    </section>
  );
}
