import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { DriverAlert } from "./DriverAlert";

describe("DriverAlert", () => {
  it("renderiza title + description com variant info por default", () => {
    render(
      <DriverAlert
        title="Tudo certo"
        description="Seu cadastro está completo."
      />,
    );
    expect(screen.getByText("Tudo certo")).toBeInTheDocument();
    expect(screen.getByText("Seu cadastro está completo.")).toBeInTheDocument();
    const alert = screen.getByRole("alert");
    expect(alert.className).toContain("bg-sky-50");
  });

  it("aplica classes corretas para cada variant", () => {
    const { rerender } = render(<DriverAlert variant="warning" title="W" />);
    expect(screen.getByRole("alert").className).toContain("bg-amber-50");

    rerender(<DriverAlert variant="danger" title="D" />);
    expect(screen.getByRole("alert").className).toContain("bg-red-50");

    rerender(<DriverAlert variant="success" title="S" />);
    expect(screen.getByRole("alert").className).toContain("bg-emerald-50");
  });

  it("aria-live=assertive para variant danger, polite para outros", () => {
    const { rerender } = render(<DriverAlert variant="danger" title="D" />);
    expect(screen.getByRole("alert")).toHaveAttribute("aria-live", "assertive");

    rerender(<DriverAlert variant="info" title="I" />);
    expect(screen.getByRole("alert")).toHaveAttribute("aria-live", "polite");
  });

  it("dispara onClick dos CTAs", () => {
    const onPrimary = vi.fn();
    const onSecondary = vi.fn();
    render(
      <DriverAlert
        title="Atualize seu cadastro"
        primaryAction={{ label: "Atualizar agora", onClick: onPrimary }}
        secondaryAction={{ label: "Agora não", onClick: onSecondary }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /atualizar agora/i }));
    expect(onPrimary).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: /agora não/i }));
    expect(onSecondary).toHaveBeenCalledTimes(1);
  });

  it("desabilita CTA quando disabled ou loading", () => {
    render(
      <DriverAlert
        title="..."
        primaryAction={{
          label: "Salvar",
          onClick: () => undefined,
          loading: true,
        }}
      />,
    );
    const btn = screen.getByRole("button", { name: /aguarde/i });
    expect(btn).toBeDisabled();
  });

  it("renderiza children abaixo da descrição", () => {
    render(
      <DriverAlert title="Faltam coisas" description="3 pendências">
        <ul>
          <li>CRLV cavalo</li>
          <li>CRLV carreta</li>
        </ul>
      </DriverAlert>,
    );
    expect(screen.getByText("CRLV cavalo")).toBeInTheDocument();
    expect(screen.getByText("CRLV carreta")).toBeInTheDocument();
  });

  it("esconde ícone quando hideIcon=true", () => {
    const { container } = render(
      <DriverAlert title="Sem ícone" hideIcon />,
    );
    // O wrapper de ícone tem aria-hidden — se hideIcon, não deve existir
    const iconWrapper = container.querySelector("[aria-hidden='true']");
    expect(iconWrapper).toBeNull();
  });

  it("mostra ícone customizado quando icon prop é passado", () => {
    const CustomIcon = () => <svg data-testid="custom-icon" />;
    render(<DriverAlert title="X" icon={CustomIcon as unknown as never} />);
    expect(screen.getByTestId("custom-icon")).toBeInTheDocument();
  });
});
