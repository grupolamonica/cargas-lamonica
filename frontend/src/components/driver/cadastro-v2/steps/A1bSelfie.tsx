import { useEffect, useState } from "react";

import { OcrUploadTile, type OcrTileState } from "../widgets/OcrUploadTile";

export interface A1bSelfieData {
  /** Nome do arquivo escolhido pelo motorista (apenas display/feedback). */
  fileName?: string;
  /**
   * URL persistida no Supabase Storage após upload bem-sucedido. Quando
   * presente, a sub-etapa é considerada válida e o ConfirmationScreen pode
   * exibir o link de revisão. Hidratado do draft via prop `value`.
   */
  storageUrl?: string;
}

export interface A1bSelfieProps {
  value?: A1bSelfieData;
  onChange: (data: A1bSelfieData) => void;
  onValid: (valid: boolean) => void;
  /** Contexto p/ persistência no bucket `cadastro-drafts` (slot motorista_selfie_cnh). */
  cargaId?: string;
  cpf?: string;
  accessToken?: string | null;
}

/**
 * Sub-etapa A1b — Selfie do motorista segurando a CNH.
 *
 * - Obrigatória (validate-on-upload). Aceita foto OU arquivo (jpg/png/heic).
 * - SEM OCR: o arquivo serve apenas como prova de identidade visual para
 *   conferência manual da equipe Lamônica. Por isso `accept` exclui PDF e
 *   o callback `onFile` não chama nenhum endpoint de extração.
 * - Upload ao Supabase Storage acontece downstream (via gancho integrado
 *   ao `OcrUploadTile` quando a feature de persistência de arquivos roda;
 *   por ora a sub-etapa registra apenas o nome local do arquivo no state
 *   para feedback visual + draft local).
 */
export function A1bSelfie({
  value,
  onChange,
  onValid,
  cargaId,
  cpf,
  accessToken,
}: A1bSelfieProps) {
  const [tileState, setTileState] = useState<OcrTileState>(
    value?.fileName ? "success" : "empty",
  );
  const [fileName, setFileName] = useState<string | undefined>(value?.fileName);
  const [storageUrl, setStorageUrl] = useState<string | undefined>(value?.storageUrl);

  // Hidrata storageUrl quando o draft restaurado traz um valor diferente
  // (re-mount após reload — value.storageUrl vem do JSONB do draft).
  useEffect(() => {
    if (value?.storageUrl && value.storageUrl !== storageUrl) {
      setStorageUrl(value.storageUrl);
    }
    if (value?.fileName && !fileName) {
      setFileName(value.fileName);
      setTileState("success");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value?.storageUrl, value?.fileName]);

  useEffect(() => {
    // Valido quando há arquivo escolhido (mesmo antes do upload concluir).
    // O wizard exige fileName preenchido — caminho de sucesso visual.
    onValid(Boolean(fileName));
    onChange({ fileName, storageUrl });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileName, storageUrl]);

  const handleFile = (file: File) => {
    setFileName(file.name);
    setTileState("success");
    // Upload draft é orquestrado dentro do OcrUploadTile (slot=motorista_selfie_cnh).
    // O `onDraftPersisted` abaixo armazena a storage_path no state local.
  };

  const handleRetry = () => {
    setFileName(undefined);
    setStorageUrl(undefined);
    setTileState("empty");
  };

  return (
    <section className="space-y-3" aria-labelledby="step-a1b-title">
      <header className="space-y-1">
        <h3 id="step-a1b-title" className="text-base font-semibold text-foreground">
          Selfie segurando a CNH
        </h3>
        <p className="text-sm text-muted-foreground">
          Tire uma foto sua segurando a CNH aberta perto do rosto, ou envie um arquivo.
        </p>
      </header>

      <OcrUploadTile
        accept="image/jpeg,image/png,image/heic"
        capture="user"
        maxSizeMb={8}
        label="Selfie com a CNH"
        helper="Rosto + CNH aberta visíveis (sem PDF)"
        state={tileState}
        previewName={fileName}
        onFile={handleFile}
        onRetry={handleRetry}
        onManualFallback={handleRetry}
        slot="motorista_selfie_cnh"
        cargaId={cargaId}
        cpf={cpf}
        accessToken={accessToken}
        onDraftPersisted={(result) => {
          setStorageUrl(result.storage_path);
        }}
        draftPersisted={Boolean(storageUrl)}
      />
    </section>
  );
}
