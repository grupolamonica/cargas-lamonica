import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { TelaZeroPendencies } from "./TelaZeroPendencies";
import type { CandidaturaPendency } from "@/api/candidaturaApi";

/**
 * Iter #10 — rendering das pendencias diferenciadas Step A (motorista) vs
 * Step B/D (veiculo). A UI precisa exibir:
 *  - icone diferente por step (UserCircle p/ A, Truck p/ B/D)
 *  - description em texto secundario quando presente
 *  - label como titulo principal
 */
describe("TelaZeroPendencies — iter #10 messages diferenciadas", () => {
  const noop = vi.fn();

  it("renderiza pendency Step A (DRIVER_NOT_FOUND) com label + description", () => {
    const pendencias: CandidaturaPendency[] = [
      {
        step: "A",
        reason: "DRIVER_NOT_FOUND",
        label: "Cadastre seu CPF para candidatar-se",
        description:
          "Nao encontramos seu CPF nas bases ASPX e Angellira. Preencha a etapa 'Dados do motorista' do cadastro.",
      },
    ];

    render(
      <TelaZeroPendencies
        pendencias={pendencias}
        completos={[]}
        onConfirm={noop}
        onDismiss={noop}
      />,
    );

    expect(screen.getByText("Cadastre seu CPF para candidatar-se")).toBeInTheDocument();
    expect(
      screen.getByText(/Nao encontramos seu CPF nas bases ASPX e Angellira/),
    ).toBeInTheDocument();
    // data-testid valida o step canonico do item
    expect(screen.getByTestId("pendency-step-A")).toBeInTheDocument();
  });

  it("renderiza pendency Step B (NOT_FOUND cavalo) com description orientando etapa 'Cavalo'", () => {
    const pendencias: CandidaturaPendency[] = [
      {
        step: "B",
        plate: "ZZZ9Z99",
        reason: "NOT_FOUND",
        label: "Cadastre o veiculo (placa ZZZ9Z99)",
        description:
          "A placa ZZZ9Z99 (cavalo) ainda nao esta no nosso sistema. Va para a etapa 'Cavalo' do cadastro.",
      },
    ];

    render(
      <TelaZeroPendencies
        pendencias={pendencias}
        completos={[]}
        onConfirm={noop}
        onDismiss={noop}
      />,
    );

    expect(screen.getByText("Cadastre o veiculo (placa ZZZ9Z99)")).toBeInTheDocument();
    expect(screen.getByText(/Va para a etapa 'Cavalo'/)).toBeInTheDocument();
    expect(screen.getByTestId("pendency-step-B")).toBeInTheDocument();
  });

  it("renderiza pendency Step D (NOT_FOUND carreta) com description orientando etapa 'Carreta'", () => {
    const pendencias: CandidaturaPendency[] = [
      {
        step: "D",
        plate: "DEF4G56",
        reason: "NOT_FOUND",
        label: "Cadastre o veiculo (placa DEF4G56)",
        description:
          "A placa DEF4G56 (carreta) ainda nao esta no nosso sistema. Va para a etapa 'Carreta' do cadastro.",
      },
    ];

    render(
      <TelaZeroPendencies
        pendencias={pendencias}
        completos={[]}
        onConfirm={noop}
        onDismiss={noop}
      />,
    );

    expect(screen.getByText("Cadastre o veiculo (placa DEF4G56)")).toBeInTheDocument();
    expect(screen.getByText(/Va para a etapa 'Carreta'/)).toBeInTheDocument();
    expect(screen.getByTestId("pendency-step-D")).toBeInTheDocument();
  });

  it("nao renderiza paragrafo de description quando o backend nao envia o campo (backward-compat)", () => {
    // Pendency legada (EXPIRING) sem description definida — UI deve continuar
    // funcionando sem renderizar bloco secundario.
    const pendencias: CandidaturaPendency[] = [
      {
        step: "B",
        plate: "ABC1D23",
        reason: "EXPIRING",
        label: "Documento do veiculo ABC1D23 vence em 12 dia(s). Renove em breve.",
        daysUntilExpiry: 12,
      },
    ];

    render(
      <TelaZeroPendencies
        pendencias={pendencias}
        completos={[]}
        onConfirm={noop}
        onDismiss={noop}
      />,
    );

    expect(
      screen.getByText(/Documento do veiculo ABC1D23 vence em 12 dia\(s\)/),
    ).toBeInTheDocument();
    // Nao deve haver paragrafo secundario com classe text-muted-foreground
    // contendo descricao adicional — o label e auto-suficiente.
    const container = screen.getByTestId("pendency-step-B");
    expect(container.querySelectorAll("p")).toHaveLength(1);
  });
});
