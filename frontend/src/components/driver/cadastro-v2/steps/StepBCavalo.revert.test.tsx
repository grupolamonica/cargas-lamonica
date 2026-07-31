import { useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// jsdom não tem Blob.arrayBuffer (validação de magic number do upload).
if (typeof Blob !== "undefined" && !Blob.prototype.arrayBuffer) {
  Blob.prototype.arrayBuffer = function (this: Blob): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result as ArrayBuffer);
      fr.onerror = () => reject(fr.error);
      fr.readAsArrayBuffer(this);
    });
  };
}

// Regressão do bug reportado: motorista digita placa X, anexa CRLV de placa Y,
// escolhe "Usar do documento (Y)"; como Y já está cadastrada aparece o alerta
// "Placa já cadastrada" com "Usar a original". ANTES, "Usar a original" trocava
// SÓ a placa de volta pra X e mantinha RENAVAM/chassi/dono/CRLV do veículo Y →
// cadastro "Frankenstein". O fix limpa TODOS os campos do CRLV divergente.

const TYPED_X = "ABC1D23";
const DOC_Y = "XYZ9K88";

const ocrCrlvMock = vi.fn();
vi.mock("@/services/cadastroApi", () => ({
  ocrCrlv: (...a: unknown[]) => ocrCrlvMock(...a),
  uploadDraftFile: vi.fn().mockResolvedValue({
    slot: "cavalo_crlv",
    storage_path: "drafts/cpf/cavalo_crlv.pdf",
    signed_url: "https://x/y.pdf",
    filename: "crlv.pdf",
  }),
  humanizeOcrMessage: (m?: string) => m ?? "",
}));

// placa Y JÁ cadastrada → dispara o alerta "Placa já cadastrada" no StepBCavalo.
vi.mock("@/api/candidaturaApi", () => ({
  verifyDocument: vi.fn().mockResolvedValue({ exists: true, daysUntilExpiry: 120 }),
}));

import { StepBCavalo, type StepBData } from "./StepBCavalo";

function makePdf(sizeBytes = 30 * 1024): File {
  const arr = new Uint8Array(sizeBytes);
  [0x25, 0x50, 0x44, 0x46, 0x2d].forEach((b, i) => (arr[i] = b)); // "%PDF-"
  return new File([arr], "crlv.pdf", { type: "application/pdf" });
}

function Mirror({ onVal }: { onVal: (v?: StepBData) => void }) {
  const [stepB, setStepB] = useState<StepBData | undefined>(undefined);
  onVal(stepB);
  return (
    <StepBCavalo
      horsePlate={TYPED_X}
      driverProfile={{ document_number: "55566677788" }}
      totalSteps={2}
      currentStep={2}
      value={stepB}
      onChange={(d) => setStepB((prev) => ({ ...(prev ?? {}), ...d }) as StepBData)}
      onComplete={() => {}}
      onBack={() => {}}
      checkPlateRegistration={async () => ({ alreadyRegistered: true, daysUntilExpiry: 120 })}
      cargaId="11111111-1111-1111-1111-111111111111"
      cpf="55566677788"
      accessToken="tok"
    />
  );
}

describe("StepBCavalo — 'Usar a original' não deixa registro Frankenstein", () => {
  afterEach(() => ocrCrlvMock.mockReset());

  it("ao reverter pra placa digitada (X), limpa RENAVAM/chassi/dono/CRLV do veículo Y", async () => {
    ocrCrlvMock.mockResolvedValue({
      veiculo: {
        placa: DOC_Y,
        renavam: "99988877766",
        chassi: "9BWCHASSISY0001",
        marca: "SCANIA",
        modelo: "R450",
        ano_modelo: "2019",
        cor: "AZUL",
        tipo: "CAVALO MECANICO",
      },
      proprietario: { documento: "11222333000181", tipo: "PJ", nome: "TRANSPORTES Y LTDA" },
    });

    let lastVal: StepBData | undefined;
    render(<Mirror onVal={(v) => (lastVal = v)} />);

    // anexa o CRLV de placa Y (divergente da digitada X)
    const input = screen.getByLabelText("CRLV do cavalo (enviar arquivo)") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [makePdf()] } });

    // aparece a escolha de placa e o motorista usa a do documento (Y)
    fireEvent.click(await screen.findByRole("button", { name: /Usar do documento/i }));

    // Y já cadastrada → alerta "Placa já cadastrada" (verifyDocument debounce 300ms)
    const usarOriginal = await screen.findByRole(
      "button",
      { name: /Usar a original/i },
      { timeout: 3000 },
    );
    fireEvent.click(usarOriginal);

    await waitFor(() => expect(lastVal?.placa).toBe(TYPED_X));

    // NÃO pode restar nada do veículo Y colado na placa X:
    expect(lastVal?.renavam ?? "").toBe("");
    expect(lastVal?.chassi ?? "").toBe("");
    expect(lastVal?.ownerDoc ?? "").toBe("");
    expect(lastVal?.ownerNome ?? "").toBe("");
    expect(lastVal?.crlvStoragePath ?? undefined).toBeUndefined();

    // Assenta o trabalho assíncrono ainda em voo (debounce de 300ms do
    // useVerifyDocument, FileReader do upload, checkPlateRegistration) ANTES
    // do teardown — sem isso, um setState tardio atravessa o fim do teste e
    // estoura "Should not already be working" de forma intermitente no CI.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 450));
    });
  });
});
