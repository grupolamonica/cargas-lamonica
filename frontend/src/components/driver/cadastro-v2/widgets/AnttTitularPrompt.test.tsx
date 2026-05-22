import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  AnttTitularPrompt,
  isTitularDiff,
  type AnttTitularCascadeResult,
  type AnttTitularData,
} from "./AnttTitularPrompt";

describe("AnttTitularPrompt", () => {
  // ─── Cenario A ─── cascade SUCEDEU + titular_doc === ownerDoc ───────────────
  describe("Cenário A — titular === owner CRLV", () => {
    it("renderiza toggle radio com default 'mesmo proprietário' e NÃO mostra mini-form", () => {
      const cascade: AnttTitularCascadeResult = {
        rntrc: "12345678",
        titular_doc: "08656693689",
        titular_nome: "JOAO MOTORISTA",
      };
      render(
        <AnttTitularPrompt
          cascadeResult={cascade}
          ownerDoc="08656693689"
          ownerNome="JOAO MOTORISTA"
          value={null}
          onChange={vi.fn()}
          context="cavalo"
          kind="cavalo"
        />,
      );
      expect(screen.getByText(/Quem é o titular do RNTRC/i)).toBeInTheDocument();
      expect(
        screen.getByLabelText(/É o mesmo proprietário do CRLV/i),
      ).toBeChecked();
      // Mini-form não deve aparecer quando "mesmo proprietário" está marcado.
      expect(screen.queryByText(/Dados do titular do RNTRC/i)).not.toBeInTheDocument();
    });

    it("emite onChange com cópia do owner ao montar em cenário A", () => {
      const onChange = vi.fn();
      const cascade: AnttTitularCascadeResult = {
        rntrc: "12345678",
        titular_doc: "086.566.936-89",
        titular_nome: "JOAO MOTORISTA",
      };
      render(
        <AnttTitularPrompt
          cascadeResult={cascade}
          ownerDoc="08656693689"
          ownerNome="JOAO MOTORISTA"
          value={null}
          onChange={onChange}
          context="cavalo"
          kind="cavalo"
        />,
      );
      expect(onChange).toHaveBeenCalled();
      const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1][0] as
        | AnttTitularData
        | null;
      expect(lastCall).not.toBeNull();
      expect(lastCall!.doc).toBe("08656693689");
      expect(lastCall!.nome).toBe("JOAO MOTORISTA");
      expect(lastCall!.tipo).toBe("pf");
    });

    it("expande mini-form em branco quando motorista marca 'Outra pessoa'", () => {
      const onChange = vi.fn();
      const cascade: AnttTitularCascadeResult = {
        rntrc: "12345678",
        titular_doc: "08656693689",
        titular_nome: "JOAO MOTORISTA",
      };
      render(
        <AnttTitularPrompt
          cascadeResult={cascade}
          ownerDoc="08656693689"
          ownerNome="JOAO MOTORISTA"
          value={null}
          onChange={onChange}
          context="cavalo"
          kind="cavalo"
        />,
      );
      const outraRadio = screen.getByLabelText(/Outra pessoa é o titular/i);
      fireEvent.click(outraRadio);
      expect(outraRadio).toBeChecked();
      expect(screen.getByText(/Dados do titular do RNTRC/i)).toBeInTheDocument();
      // onChange(null) ao trocar para "outra pessoa" — limpa o form.
      const calls = onChange.mock.calls.map((c) => c[0]);
      expect(calls).toContainEqual(null);
    });
  });

  // ─── Cenario B ─── cascade SUCEDEU + titular_doc !== ownerDoc ───────────────
  describe("Cenário B — titular !== owner CRLV", () => {
    it("renderiza alerta info + mini-form pré-preenchido com cascade", () => {
      const cascade: AnttTitularCascadeResult = {
        rntrc: "98765432",
        titular_doc: "11144477735",
        titular_nome: "EMPRESA TRANSPORTES LTDA",
      };
      render(
        <AnttTitularPrompt
          cascadeResult={cascade}
          ownerDoc="08656693689"
          ownerNome="JOAO MOTORISTA"
          value={null}
          onChange={vi.fn()}
          context="cavalo"
          kind="cavalo"
        />,
      );
      expect(screen.getByText(/em nome de outra pessoa/i)).toBeInTheDocument();
      expect(screen.getByText(/EMPRESA TRANSPORTES LTDA/i)).toBeInTheDocument();
      expect(screen.getByText(/Dados do titular do RNTRC/i)).toBeInTheDocument();
    });

    it("permite editar nome no mini-form e emite onChange válido", () => {
      const onChange = vi.fn();
      const cascade: AnttTitularCascadeResult = {
        rntrc: "98765432",
        titular_doc: "11144477735",
        titular_nome: "EMPRESA INICIAL",
      };
      render(
        <AnttTitularPrompt
          cascadeResult={cascade}
          ownerDoc="08656693689"
          ownerNome="JOAO MOTORISTA"
          value={null}
          onChange={onChange}
          context="cavalo"
          kind="cavalo"
        />,
      );
      const nomeInput = screen.getByLabelText(/Razão social|Nome completo/i) as HTMLInputElement;
      expect(nomeInput.value).toBe("EMPRESA INICIAL");
      fireEvent.change(nomeInput, { target: { value: "EMPRESA EDITADA LTDA" } });
      const lastValid = onChange.mock.calls
        .map((c) => c[0])
        .filter((v): v is AnttTitularData => v !== null)
        .pop();
      expect(lastValid?.nome).toBe("EMPRESA EDITADA LTDA");
    });
  });

  // ─── Cenario C ─── cascade ausente OU sem titular_doc ───────────────────────
  describe("Cenário C — cascade não confirmou titular", () => {
    it("renderiza aviso warning + mini-form em branco quando cascadeResult é null", () => {
      render(
        <AnttTitularPrompt
          cascadeResult={null}
          ownerDoc="08656693689"
          ownerNome="JOAO MOTORISTA"
          value={null}
          onChange={vi.fn()}
          context="cavalo"
          kind="cavalo"
        />,
      );
      expect(
        screen.getByText(/Não conseguimos confirmar o titular do RNTRC/i),
      ).toBeInTheDocument();
      expect(screen.getByText(/Dados do titular do RNTRC/i)).toBeInTheDocument();
      // Form em branco — não há valor pré-preenchido.
      const docInput = screen.getByLabelText(/^CPF$|^CNPJ$/i) as HTMLInputElement;
      expect(docInput.value).toBe("");
    });

    it("renderiza cenário C quando cascade retorna sem titular_doc", () => {
      const cascade: AnttTitularCascadeResult = {
        rntrc: "12345678",
        titular_doc: null,
        titular_nome: null,
      };
      render(
        <AnttTitularPrompt
          cascadeResult={cascade}
          ownerDoc="08656693689"
          ownerNome="JOAO MOTORISTA"
          value={null}
          onChange={vi.fn()}
          context="cavalo"
          kind="cavalo"
        />,
      );
      expect(
        screen.getByText(/Não conseguimos confirmar o titular do RNTRC/i),
      ).toBeInTheDocument();
    });

    it("não bloqueia — motorista pode prosseguir mesmo sem preencher", () => {
      const onChange = vi.fn();
      render(
        <AnttTitularPrompt
          cascadeResult={null}
          ownerDoc="08656693689"
          value={null}
          onChange={onChange}
          context="cavalo"
          kind="cavalo"
        />,
      );
      // Cenário C não dispara onChange automático com payload válido — fica null.
      // Inválido até o motorista preencher doc+nome.
      const calls = onChange.mock.calls.map((c) => c[0]);
      // Nenhum payload válido foi emitido (todos null ou inexistentes).
      const validCalls = calls.filter((v) => v !== null);
      expect(validCalls.length).toBe(0);
    });
  });

  // ─── kind=carreta ─── não renderiza banco nem campos sociais ────────────────
  describe("kind=carreta", () => {
    it("não renderiza bloco de banco em cenário B", () => {
      const cascade: AnttTitularCascadeResult = {
        rntrc: "98765432",
        titular_doc: "11144477735",
        titular_nome: "TRANSPORTES X",
      };
      render(
        <AnttTitularPrompt
          cascadeResult={cascade}
          ownerDoc="08656693689"
          value={null}
          onChange={vi.fn()}
          context="carreta_0"
          kind="carreta"
        />,
      );
      // Bloco de banco não aparece (somente cavalo).
      expect(screen.queryByText(/Banco para pagamento/i)).not.toBeInTheDocument();
    });
  });

  // ─── isTitularDiff helper export ────────────────────────────────────────────
  describe("isTitularDiff helper", () => {
    it("retorna false quando cascade ausente", () => {
      expect(isTitularDiff(null, "08656693689")).toBe(false);
    });
    it("retorna false quando titular_doc === ownerDoc (com pontuação diferente)", () => {
      expect(
        isTitularDiff(
          { titular_doc: "086.566.936-89", titular_nome: "X" },
          "08656693689",
        ),
      ).toBe(false);
    });
    it("retorna true quando docs distintos", () => {
      expect(
        isTitularDiff(
          { titular_doc: "11144477735", titular_nome: "X" },
          "08656693689",
        ),
      ).toBe(true);
    });
  });
});
