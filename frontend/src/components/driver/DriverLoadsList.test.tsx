import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { auth: { getSession: vi.fn(), signInWithPassword: vi.fn(), signOut: vi.fn() } },
}));

vi.mock("@/integrations/supabase/public-client", () => ({
  publicSupabase: {
    channel: vi.fn(() => ({ on: vi.fn().mockReturnThis(), subscribe: vi.fn() })),
    removeChannel: vi.fn(),
  },
}));

import { DriverLoadsList } from "./DriverLoadsList";
import type { Cargo } from "@/hooks/useDriverLoads";

const renderList = (cargas: Cargo[]) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <DriverLoadsList
          cargas={cargas}
          loading={false}
          hasActiveFilters={false}
          onClearFilters={() => {}}
          onInterestDialogOpenChange={() => {}}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

/**
 * Carga lançada SEM data de carregamento definida: o backend grava placeholder em
 * data/horario (dia do lançamento às 00:00 — colunas NOT NULL) e denormaliza o rótulo
 * "A confirmar" em carregamentoLabel. O card não pode traduzir o placeholder em uma
 * coleta real ("hoje às 00:00") — isso anunciaria ao motorista um horário inexistente.
 */
const cargaAConfirmar = {
  id: "11111111-2222-3333-4444-555555555555",
  data: "2026-08-03",
  horario: "00:00:00",
  origem: "Cordeiropolis / SP",
  destino: "Paulista / PE",
  distancia_km: 2780,
  duracao_horas: 75,
  tempo_estimado_horas: 75,
  perfil: "CARRETA",
  eixos: null,
  valor: 21200,
  bonus: null,
  clienteId: "cliente-1",
  clienteNome: "Produtos Alimentícios",
  clienteDescricao: null,
  clienteLogoUrl: null,
  clienteLogoUrlCard: null,
  clienteLogoUrlProximas: null,
  carregamentoLabel: "A confirmar",
  descargaLabel: null,
  routeLabel: "CORDEIROPOLIS X PAULISTA",
} as unknown as Cargo;

describe("DriverLoadsList — agenda a confirmar", () => {
  it('mostra "Coleta a confirmar" e não o placeholder de data/hora do lançamento', () => {
    renderList([cargaAConfirmar]);

    expect(screen.getAllByText(/Coleta a confirmar/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Coleta hoje às 00:00/i)).toBeNull();
    expect(screen.queryByText(/03\/08\/2026 00:00/)).toBeNull();
  });

  it("mantém a data real no card quando a agenda está definida", () => {
    renderList([
      { ...cargaAConfirmar, carregamentoLabel: "2026-08-06T10:00", data: "2026-08-06", horario: "10:00:00" },
    ]);

    expect(screen.getAllByText(/06\/08\/2026 10:00/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Coleta a confirmar/i)).toBeNull();
  });
});
