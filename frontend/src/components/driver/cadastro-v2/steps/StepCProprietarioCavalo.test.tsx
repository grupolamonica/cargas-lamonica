import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

// Regressão C1 — https://cargas.grupolamonica.com/motoristas
// Antes deste fix, `continueEnabled` (corpo do componente) referenciava
// `ownerEnderecoCompleted`, que só era declarado DENTRO do IIFE do JSX (depois
// do return). Em runtime isso disparava
//   ReferenceError: ownerEnderecoCompleted is not defined
// assim que as condições anteriores ficavam verdadeiras — cenário reproduzido
// aqui: motorista é o proprietário do cavalo (driverIsOwner) e informa o titular
// do RNTRC ("É o mesmo proprietário do CRLV" -> anttTitular != null). O
// WizardErrorBoundary capturava o erro e mostrava "Algo deu errado por aqui".

// useDriverAuth vem de um contexto (DriverAuthProvider) — mock leve com sessão.
vi.mock("@/hooks/useDriverAuth", () => ({
  useDriverAuth: () => ({ session: { access_token: "test-token" } }),
}));

// Mutation da cascata ANTT — no-op para não bater na rede durante o mount.
vi.mock("@/api/candidaturaApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/candidaturaApi")>();
  return {
    ...actual,
    useCandidaturaAnttPrecheck: () => ({
      mutate: vi.fn(),
      mutateAsync: vi.fn(),
      reset: vi.fn(),
      isPending: false,
      isError: false,
      error: null,
      data: undefined,
    }),
    verifyDocument: vi.fn().mockResolvedValue({ exists: false }),
  };
});

// O bug vive no corpo do StepC (cálculo de continueEnabled), não nos filhos.
// Stubar os widgets pesados isola o teste e o mantém estável — preservando os
// validadores reais (isValidOwnerPFData etc.) que o StepC importa junto.
vi.mock("../widgets/OwnerDocumentUploader", () => ({
  OwnerDocumentUploader: () => <div data-testid="owner-doc-uploader" />,
}));
vi.mock("../widgets/OwnerEnderecoComprovante", () => ({
  OwnerEnderecoComprovante: () => <div data-testid="owner-endereco" />,
}));
vi.mock("../widgets/AnttTitularPrompt", () => ({
  AnttTitularPrompt: () => <div data-testid="antt-titular" />,
}));
vi.mock("../widgets/OwnerAttributionFormPF", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../widgets/OwnerAttributionFormPF")>();
  return { ...actual, OwnerAttributionFormPF: () => <div data-testid="owner-pf" /> };
});

import {
  StepCProprietarioCavalo,
  type StepCData,
  type StepCDriverProfile,
} from "./StepCProprietarioCavalo";

function renderStepC() {
  const value: StepCData = {
    owner: { nome: "JOÃO MOTORISTA", documento: "08656693689" },
    // isValidOwnerPFData exige apenas um telefone brasileiro válido.
    pf: { telefone: "(11) 99999-8888", cep: "01001-000", numero: "100" },
    // Titular do RNTRC preenchido == "mesmo proprietário do CRLV" -> anttFulfilled = true.
    anttTitular: { doc: "08656693689", nome: "JOÃO MOTORISTA", tipo: "pf" },
    ownerEndereco: {
      cep: "01001-000",
      numero: "100",
      logradouro: "Praça da Sé",
      bairro: "Sé",
      cidade: "São Paulo",
      uf: "SP",
      comprovanteUrl: "https://example.test/comprovante.jpg",
    },
  };

  return render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
      <StepCProprietarioCavalo
        ownerDocFromCrlv="08656693689"
        horsePlate="ABC1D23"
        driverProfile={
          { nome: "JOÃO MOTORISTA", document_number: "08656693689" } as StepCDriverProfile
        }
        totalSteps={4}
        currentStep={4}
        driverIsOwner
        value={value}
        onComplete={vi.fn()}
        onBack={vi.fn()}
      />
    </QueryClientProvider>,
  );
}

describe("StepCProprietarioCavalo — regressão C1 (ownerEnderecoCompleted)", () => {
  it("monta sem ReferenceError quando o motorista é o proprietário e o titular do RNTRC está preenchido", () => {
    expect(() => renderStepC()).not.toThrow();
    // Chegou a renderizar o cabeçalho do passo (passou do cálculo de continueEnabled).
    expect(
      screen.getByText(/Você como proprietário do cavalo/i),
    ).toBeInTheDocument();
  });
});
