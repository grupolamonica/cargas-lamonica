import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  VehicleCrlvUploader,
  type VehicleCrlvExtractedData,
} from "./VehicleCrlvUploader";

// Regressão do bug "CRLV some ao reabrir": quando o motorista digitou a placa X
// mas escolheu a placa Y do CRLV, o draft persiste placa=Y. Ao remontar/hidratar,
// o efeito de reset [plate] disparava porque state.placa(Y) ≠ prop plate(X) e
// APAGAVA todo o OCR hidratado (tile voltava a "vazio"), além de reverter a placa
// Y→X no payload em drafts mínimos. O fix (prevPlateRef) só reseta quando o PROP
// plate muda de verdade — no mount não reseta.

vi.mock("@/services/cadastroApi", () => ({
  ocrCrlv: vi.fn(),
  uploadDraftFile: vi.fn().mockResolvedValue({
    slot: "cavalo_crlv",
    storage_path: "x",
    signed_url: "y",
    filename: "crlv.pdf",
  }),
  humanizeOcrMessage: (m?: string) => m ?? "",
}));

const TYPED_X = "ABC1D23"; // placa digitada na candidatura
const DOC_Y = "XYZ9K88"; // placa escolhida do documento (persistida no draft)

const hydratedY: VehicleCrlvExtractedData = {
  placa: DOC_Y,
  renavam: "12345678901",
  chassi: "9BWZZZ377VT004251",
  marca: "SCANIA / R450",
  ano: "2020",
  cor: "BRANCA",
  ownerNome: "JOSE MOTORISTA",
  cpf_proprietario: "11144477735",
};

describe("VehicleCrlvUploader — hidratação de draft com placa divergente não apaga o OCR", () => {
  it("mantém o CRLV hidratado (Y) e NÃO reseta pra placa digitada (X) no mount", async () => {
    const onExtracted = vi.fn();
    render(
      <VehicleCrlvUploader
        plate={TYPED_X}
        label="CRLV do cavalo"
        onExtracted={onExtracted}
        onManualFallback={() => {}}
        draftPersisted
        initialExtracted={hydratedY}
        slot="cavalo_crlv"
        cargaId="11111111-1111-1111-1111-111111111111"
      />,
    );

    await waitFor(() => expect(onExtracted).toHaveBeenCalled());

    // Nenhuma emissão pode ser um "wipe": placa revertida pra X e campos zerados.
    const wiped = onExtracted.mock.calls.some(
      ([e]: [VehicleCrlvExtractedData]) =>
        e.placa === TYPED_X || (e.placa !== DOC_Y && !e.renavam),
    );
    expect(wiped).toBe(false);

    // A última emissão preserva os dados do documento Y.
    const last = onExtracted.mock.calls.at(-1)?.[0] as VehicleCrlvExtractedData;
    expect(last.placa).toBe(DOC_Y);
    expect(last.renavam).toBe("12345678901");

    // E o tile continua em estado "enviado" (não voltou pro dropzone vazio).
    expect(screen.getByText(/Documento já enviado/i)).toBeInTheDocument();
  });
});
