import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// RouteSelector importa assignableRoutes → apiClient → supabase client.
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { auth: { getSession: vi.fn(), signInWithPassword: vi.fn(), signOut: vi.fn() } },
}));

import { RouteSelector } from "@/components/RouteSelector";
import type { AssignableRouteOption } from "@/lib/assignableRoutes";

function makeRoute(overrides: Partial<AssignableRouteOption> & { id: string; route_key: string; base_route_label: string }): AssignableRouteOption {
  return {
    origin_key: "o",
    destination_key: "d",
    origem: "ORIGEM",
    destino: "DESTINO",
    distancia_km: 100,
    duracao_horas: 2,
    tempo_estimado_horas: 2,
    perfil_padrao: null,
    valor_padrao: 1000,
    bonus_padrao: 0,
    ativa: true,
    source: "base+db",
    ...overrides,
  } as AssignableRouteOption;
}

// Rotas propositalmente fora de ordem alfabética.
const ROUTES: AssignableRouteOption[] = [
  makeRoute({ id: "z", route_key: "z", base_route_label: "ZEBRA X QUALQUER" }),
  makeRoute({ id: "a", route_key: "a", base_route_label: "ALPHA X BETA" }),
  makeRoute({ id: "m", route_key: "m", base_route_label: "MANAUS X BELEM" }),
];

describe("RouteSelector (DC-302)", () => {
  it("lista as rotas em ordem alfabética ao abrir", () => {
    render(<RouteSelector routes={ROUTES} value="" onChange={vi.fn()} />);

    fireEvent.click(screen.getByText("Selecionar rota do catálogo"));

    // options[0] é o item "Sem rota"; as rotas vêm ordenadas: ALPHA, MANAUS, ZEBRA.
    const options = screen.getAllByRole("option");
    const routeLabels = options.slice(1).map((el) => el.textContent);
    expect(routeLabels).toEqual([
      expect.stringContaining("ALPHA X BETA"),
      expect.stringContaining("MANAUS X BELEM"),
      expect.stringContaining("ZEBRA X QUALQUER"),
    ]);
  });

  it("permite pesquisar a rota pelo filtro", () => {
    render(<RouteSelector routes={ROUTES} value="" onChange={vi.fn()} />);

    fireEvent.click(screen.getByText("Selecionar rota do catálogo"));
    fireEvent.change(screen.getByPlaceholderText("Buscar rota..."), { target: { value: "manaus" } });

    expect(screen.getByRole("option", { name: /MANAUS X BELEM/i })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /ALPHA X BETA/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /ZEBRA X QUALQUER/i })).not.toBeInTheDocument();
  });

  it("emite o route_key ao selecionar e permite limpar", () => {
    const onChange = vi.fn();
    render(<RouteSelector routes={ROUTES} value="" onChange={onChange} />);

    fireEvent.click(screen.getByText("Selecionar rota do catálogo"));
    fireEvent.click(screen.getByRole("option", { name: /MANAUS X BELEM/i }));
    expect(onChange).toHaveBeenCalledWith("m");
  });

  it("na busca sem resultado não oferece 'Sem rota' (não limpa a rota por engano)", () => {
    render(<RouteSelector routes={ROUTES} value="a" onChange={vi.fn()} />);

    fireEvent.click(screen.getByText("ALPHA X BETA"));
    fireEvent.change(screen.getByPlaceholderText("Buscar rota..."), { target: { value: "xyz-inexistente" } });

    expect(screen.getByText("Nenhuma rota encontrada.")).toBeInTheDocument();
    // O item "Sem rota" (que limparia a seleção) não fica como única opção clicável.
    expect(screen.queryByText("Sem rota — informar origem/destino")).not.toBeInTheDocument();
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
  });

  it("limpa a busca ao fechar e reabrir (não reabre filtrada)", () => {
    render(<RouteSelector routes={ROUTES} value="" onChange={vi.fn()} />);

    fireEvent.click(screen.getByText("Selecionar rota do catálogo"));
    fireEvent.change(screen.getByPlaceholderText("Buscar rota..."), { target: { value: "manaus" } });
    expect(screen.queryByRole("option", { name: /ALPHA X BETA/i })).not.toBeInTheDocument();

    // Fecha via Escape e reabre — a lista volta completa (busca resetada).
    fireEvent.keyDown(screen.getByPlaceholderText("Buscar rota..."), { key: "Escape" });
    fireEvent.click(screen.getByText("Selecionar rota do catálogo"));

    expect(screen.getByPlaceholderText("Buscar rota...")).toHaveValue("");
    expect(screen.getByRole("option", { name: /ALPHA X BETA/i })).toBeInTheDocument();
  });
});
