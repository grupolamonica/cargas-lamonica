import type { ReactElement } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  OwnerAttributionFormPF,
  buildEmptyOwnerPFData,
  describeOwnerPFFieldIssues,
  isValidOwnerPFData,
  type OwnerAttributionFormPFDriverProfile,
  type OwnerAttributionFormPFProps,
  type OwnerPFData,
} from "./OwnerAttributionFormPF";

/**
 * Após refatoração 2026-06-03, o OwnerAttributionFormPF coleta APENAS o
 * telefone do owner CRLV. CEP, número e comprovante migraram para
 * OwnerEnderecoComprovante (card dedicado abaixo no Step C).
 */

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    message: vi.fn(),
  },
}));

const DRIVER_PROFILE: OwnerAttributionFormPFDriverProfile = {
  document_number: "12345678901",
  phone: "11999998888",
  endereco: { cep: "01310-100", numero: "100" },
};

const CPF_OWNER = "08656693689"; // CPF válido

function renderWidget(
  overrides: Partial<OwnerAttributionFormPFProps> = {},
  initialValue?: OwnerPFData,
) {
  let value: OwnerPFData = initialValue ?? buildEmptyOwnerPFData();
  const utilsRef: { rerender?: (ui: ReactElement) => void } = {};
  const onChange = vi.fn((next: OwnerPFData) => {
    value = next;
    rerenderInner();
  });

  const buildProps = (): OwnerAttributionFormPFProps => ({
    value,
    onChange,
    driverProfile: DRIVER_PROFILE,
    ownerDoc: CPF_OWNER,
    context: "cavalo",
    ...overrides,
  });

  const utils = render(<OwnerAttributionFormPF {...buildProps()} />);
  utilsRef.rerender = utils.rerender;

  function rerenderInner() {
    if (!utilsRef.rerender) return;
    utilsRef.rerender(<OwnerAttributionFormPF {...buildProps()} />);
  }

  return {
    ...utils,
    onChange,
    getValue: () => value,
    rerender: rerenderInner,
  };
}

describe("OwnerAttributionFormPF — apenas telefone (refatoração 2026-06-03)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("nao renderiza nenhum campo financeiro (banco, agencia, conta, tipo)", () => {
    renderWidget();
    expect(screen.queryByLabelText(/Banco/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Agência/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Conta/i)).not.toBeInTheDocument();
  });

  it("nao renderiza nenhum campo social (PIS, cor/raca, estado civil)", () => {
    renderWidget();
    expect(screen.queryByLabelText(/PIS/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Cor.*raça/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Estado civil/i)).not.toBeInTheDocument();
  });

  it("renderiza apenas o campo Telefone (CEP/numero/comprovante migraram para OwnerEnderecoComprovante)", () => {
    renderWidget();
    expect(screen.getByLabelText(/Telefone/i)).toBeInTheDocument();
    // Estes campos não devem mais existir neste componente
    expect(screen.queryByLabelText(/^CEP/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^Número/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Comprovante de residência/i)).not.toBeInTheDocument();
  });

  it("D-13 pre-fill: quando ownerDoc === driverCpf, dispara onChange apenas com telefone", async () => {
    const { onChange } = renderWidget({
      ownerDoc: DRIVER_PROFILE.document_number,
    });

    await act(async () => {
      vi.advanceTimersByTime(10);
    });

    expect(onChange).toHaveBeenCalled();
    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(lastCall.telefone).toMatch(/\(11\)/);
    // CEP e número não são mais gerenciados por este componente
  });

  it("aceita edicao manual de telefone via onChange", () => {
    const { onChange } = renderWidget();
    const tel = screen.getByLabelText(/Telefone/i) as HTMLInputElement;
    fireEvent.change(tel, { target: { value: "11988887777" } });
    expect(onChange).toHaveBeenCalled();
    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(lastCall.telefone).toMatch(/\(11\) 98888-7777/);
  });
});

describe("isValidOwnerPFData / describeOwnerPFFieldIssues", () => {
  it("isValidOwnerPFData false quando telefone está vazio", () => {
    expect(isValidOwnerPFData(buildEmptyOwnerPFData())).toBe(false);
  });

  it("isValidOwnerPFData true com telefone válido", () => {
    expect(
      isValidOwnerPFData({
        telefone: "(11) 99999-8888",
      }),
    ).toBe(true);
  });

  it("isValidOwnerPFData true independente de CEP/numero (migraram para OwnerEnderecoComprovante)", () => {
    // CEP e número não são mais requisitos deste componente
    expect(
      isValidOwnerPFData({
        telefone: "(11) 99999-8888",
        cep: "",
        numero: "",
      }),
    ).toBe(true);
  });

  it("describeOwnerPFFieldIssues lista apenas Telefone como campo obrigatório", () => {
    const { missing } = describeOwnerPFFieldIssues(buildEmptyOwnerPFData());
    expect(missing).toContain("Telefone");
    // CEP, número e comprovante não são mais responsabilidade deste componente
    expect(missing).not.toContain("CEP");
    expect(missing).not.toContain("Número");
    expect(missing).not.toContain("Comprovante de residência");
  });

  it("describeOwnerPFFieldIssues nao referencia campos removidos (PIS, banco, etc)", () => {
    const { missing, invalid } = describeOwnerPFFieldIssues(
      buildEmptyOwnerPFData(),
    );
    const all = [...missing, ...invalid].join(" ");
    expect(all).not.toMatch(/PIS/i);
    expect(all).not.toMatch(/Cor/i);
    expect(all).not.toMatch(/Estado civil/i);
    expect(all).not.toMatch(/Banco/i);
    expect(all).not.toMatch(/Agência/i);
    expect(all).not.toMatch(/Conta/i);
  });
});
