import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import DashboardLayout from "./DashboardLayout";

vi.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => false,
}));

vi.mock("./DashboardSidebar", () => ({
  default: ({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) => (
    <button aria-label="Alternar menu lateral" data-collapsed={collapsed ? "true" : "false"} onClick={onToggle} type="button">
      Alternar
    </button>
  ),
}));

describe("DashboardLayout", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("mantem o outlet atual estavel ao recolher ou expandir o menu lateral", () => {
    const renderSpy = vi.fn();

    const TrackedPage = () => {
      renderSpy();
      return <div>Painel atual</div>;
    };

    render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route element={<DashboardLayout />}>
            <Route path="/" element={<TrackedPage />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    expect(renderSpy).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Alternar menu lateral" }));

    expect(renderSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Painel atual")).toBeInTheDocument();
  });

  it("reserva largura real para a sidebar expandida sem empurrar o conteudo para fora da tela", async () => {
    window.localStorage.setItem("lamonica-admin-sidebar-collapsed", "true");

    render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route element={<DashboardLayout />}>
            <Route path="/" element={<div>Painel atual</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    const spacer = screen.getByTestId("dashboard-sidebar-spacer");

    expect(spacer).toHaveStyle({ width: "104px" });

    fireEvent.click(screen.getByRole("button", { name: "Alternar menu lateral" }));

    await waitFor(() => {
      expect(spacer).toHaveStyle({ width: "340px" });
    });
  });
});
