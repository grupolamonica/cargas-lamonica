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
 * Apos refatoracao 2026-05-18, o OwnerAttributionFormPF coleta apenas
 * identidade basica do owner CRLV: telefone, CEP, numero, comprovante. Banco,
 * PIS, cor/raca, estado civil migraram para AnttTitularPrompt (kind=cavalo,
 * tipo=pf). Os testes abaixo cobrem somente o escopo atual.
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

const CPF_OWNER = "08656693689"; // CPF valido

function renderWidget(
  overrides: Partial<OwnerAttributionFormPFProps> = {},
  initialValue?: OwnerPFData,
) {
  let value: OwnerPFData = initialValue ?? buildEmptyOwnerPFData();
  // `utilsRef` permite que o callback `onChange` (chamado dentro de useEffect
  // do mount) acesse `utils.rerender` sem TDZ — o render inicial pode disparar
  // o pre-fill que chama onChange antes da const `utils` ser atribuida.
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
    expandOptional: true,
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

describe("OwnerAttributionFormPF — identidade basica (pos refatoracao 2026-05-18)", () => {
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

  it("renderiza telefone, CEP, numero e comprovante", () => {
    renderWidget();
    expect(screen.getByLabelText(/Telefone/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^CEP/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Número/i)).toBeInTheDocument();
    expect(
      screen.getByLabelText(/Comprovante de residência/i),
    ).toBeInTheDocument();
  });

  it("D-13 pre-fill: quando ownerDoc === driverCpf, dispara onChange com telefone/CEP/numero", async () => {
    const { onChange } = renderWidget({
      ownerDoc: DRIVER_PROFILE.document_number,
    });

    // useEffect roda apos commit; advance timers + flush microtasks.
    await act(async () => {
      vi.advanceTimersByTime(10);
    });

    // O componente chama onChange uma vez com o patch consolidado (telefone +
    // CEP + numero) — verifica os 3 campos no payload.
    expect(onChange).toHaveBeenCalled();
    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(lastCall.telefone).toMatch(/\(11\)/);
    expect(lastCall.cep).toMatch(/01310-100/);
    expect(lastCall.numero).toBe("100");
  });

  it("aceita edicao manual de telefone, CEP, numero via onChange", () => {
    const { onChange } = renderWidget();
    const tel = screen.getByLabelText(/Telefone/i) as HTMLInputElement;
    fireEvent.change(tel, { target: { value: "11988887777" } });
    expect(onChange).toHaveBeenCalled();
    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(lastCall.telefone).toMatch(/\(11\) 98888-7777/);
  });
});

describe("isValidOwnerPFData / describeOwnerPFFieldIssues", () => {
  it("isValidOwnerPFData false quando faltam campos basicos", () => {
    expect(isValidOwnerPFData(buildEmptyOwnerPFData())).toBe(false);
  });

  it("isValidOwnerPFData true com telefone + CEP + numero validos", () => {
    expect(
      isValidOwnerPFData({
        telefone: "(11) 99999-8888",
        cep: "01310-100",
        numero: "100",
      }),
    ).toBe(true);
  });

  it("describeOwnerPFFieldIssues lista campos faltantes", () => {
    const { missing } = describeOwnerPFFieldIssues(buildEmptyOwnerPFData());
    expect(missing).toContain("Telefone");
    expect(missing).toContain("CEP");
    expect(missing).toContain("Número");
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
