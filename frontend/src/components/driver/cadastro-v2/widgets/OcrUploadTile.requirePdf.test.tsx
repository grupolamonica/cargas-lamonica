import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { OcrUploadTile } from "./OcrUploadTile";

// jsdom não implementa Blob.arrayBuffer (usado por readFirstBytes p/ ler o magic
// number). Polyfill via FileReader (que jsdom tem) — o navegador real já tem
// arrayBuffer nativo, então isto é só p/ o ambiente de teste.
if (typeof Blob !== "undefined" && !Blob.prototype.arrayBuffer) {
  Blob.prototype.arrayBuffer = function arrayBufferPolyfill(this: Blob): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result as ArrayBuffer);
      fr.onerror = () => reject(fr.error);
      fr.readAsArrayBuffer(this);
    });
  };
}

// Regra Rodopar/PRD: CNH/CRLV/cartão CNPJ DEVEM ser PDF. O tile em requirePdf
// rejeita foto/print validando o magic number %PDF (à prova de accept driblado),
// não só o MIME.

const PNG_LEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PDF_LEAD = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

function makeFile(name: string, type: string, sizeBytes: number, lead: number[]): File {
  const arr = new Uint8Array(sizeBytes);
  lead.forEach((b, i) => (arr[i] = b));
  return new File([arr], name, { type });
}

function renderTile(onFile = vi.fn()) {
  render(
    <OcrUploadTile
      requirePdf
      state="empty"
      label="CNH"
      onFile={onFile}
      onRetry={() => {}}
      onManualFallback={() => {}}
    />,
  );
  return { onFile, input: screen.getByLabelText("CNH (enviar arquivo)") as HTMLInputElement };
}

describe("OcrUploadTile requirePdf", () => {
  it("rejeita imagem (foto/print) com mensagem de PDF e não chama onFile", async () => {
    const { onFile, input } = renderTile();
    fireEvent.change(input, {
      target: { files: [makeFile("cnh.png", "image/png", 5000, PNG_LEAD)] },
    });
    expect(await screen.findByText(/precisa ser enviado em PDF/i)).toBeInTheDocument();
    expect(onFile).not.toHaveBeenCalled();
  });

  it("rejeita um arquivo .pdf FALSO (extensão pdf mas bytes de imagem)", async () => {
    const { onFile, input } = renderTile();
    // MIME diz pdf, mas os bytes são PNG → magic %PDF falha → rejeitado.
    fireEvent.change(input, {
      target: { files: [makeFile("fake.pdf", "application/pdf", 5000, PNG_LEAD)] },
    });
    expect(await screen.findByText(/precisa ser enviado em PDF/i)).toBeInTheDocument();
    expect(onFile).not.toHaveBeenCalled();
  });

  it("aceita um PDF real (magic %PDF, tamanho ok)", async () => {
    const { onFile, input } = renderTile();
    fireEvent.change(input, {
      target: { files: [makeFile("cnh.pdf", "application/pdf", 30 * 1024, PDF_LEAD)] },
    });
    await waitFor(() => expect(onFile).toHaveBeenCalledTimes(1));
  });

  it("SEM requirePdf: imagem válida continua passando (não regride comprovante/selfie)", async () => {
    const onFile = vi.fn();
    render(
      <OcrUploadTile
        state="empty"
        label="Comprovante"
        onFile={onFile}
        onRetry={() => {}}
        onManualFallback={() => {}}
      />,
    );
    const input = screen.getByLabelText("Comprovante (enviar arquivo)");
    fireEvent.change(input, {
      target: { files: [makeFile("comprovante.png", "image/png", 30 * 1024, PNG_LEAD)] },
    });
    await waitFor(() => expect(onFile).toHaveBeenCalledTimes(1));
  });
});
