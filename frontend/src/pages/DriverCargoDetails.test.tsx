/**
 * DriverCargoDetails — testes do branch "pacote" (plan 10-06).
 *
 * Cobertura RTL aqui é estrutural: a página integra ~10 helpers (Supabase
 * direct query, fetchDriverClientsByIds, route fallback, publication
 * readiness, etc.) — montar fixtures completas para drivar o useQuery
 * principal explode a verbosidade. Estratégia adotada:
 *
 *  1. Smoke tests no PacotePanel isolado (já cobre o caminho feliz da seção
 *     "Viagem casada").
 *  2. Tests do branch completo + version-bump realtime ficam como `it.skip`
 *     com TODO, cobertos por E2E Playwright no plan 10-08 (decisão F-6
 *     do plan-checker para esta fase).
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

import PacotePanel from "@/components/driver/PacotePanel";
import type { PacoteFull } from "@/services/readModels";

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock("@/integrations/supabase/public-client", () => ({
  publicSupabase: {
    channel: vi.fn(() => ({
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })),
    })),
    removeChannel: vi.fn(),
    from: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    })),
  },
}));

const fetchPacoteMock = vi.fn();
vi.mock("@/services/readModels", async () => {
  const actual = await vi.importActual<typeof import("@/services/readModels")>(
    "@/services/readModels",
  );
  return {
    ...actual,
    fetchPacote: (id: string) => fetchPacoteMock(id),
  };
});

vi.mock("sonner", () => ({
  toast: {
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
  },
}));

// ─── Helpers ────────────────────────────────────────────────────────────────

function buildPacoteFixture(overrides: Partial<PacoteFull> = {}): PacoteFull {
  return {
    id: "pacote-1",
    status: "publicado",
    valor_total: 12_500,
    version: 1,
    published_at: null,
    total_cargas: 2,
    cargas: [
      {
        id: "carga-1",
        ordem_viagem: 1,
        status: "OPEN",
        origem: "São Paulo",
        destino: "Salvador",
        perfil: "CARRETA",
        valor: 8_000,
        bonus: 500,
        bonus_exigencias: null,
        data: null,
        horario: null,
        distancia_km: null,
        duracao_horas: null,
        driver_visibility: "PREMIUM",
        cliente: { id: "cli-a", nome: "Cliente A", logo_url: null, descricao: null },
      },
      {
        id: "carga-2",
        ordem_viagem: 2,
        status: "OPEN",
        origem: "Salvador",
        destino: "Recife",
        perfil: "CARRETA",
        valor: 4_500,
        bonus: 0,
        bonus_exigencias: null,
        data: null,
        horario: null,
        distancia_km: null,
        duracao_horas: null,
        driver_visibility: "PREMIUM",
        cliente: { id: "cli-b", nome: "Cliente B", logo_url: null, descricao: null },
      },
    ],
    ...overrides,
  };
}

function renderWithProviders(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

// ─── PacotePanel — smoke tests ──────────────────────────────────────────────

describe("PacotePanel", () => {
  it("destaca a carga atual e linka as demais", async () => {
    fetchPacoteMock.mockResolvedValueOnce(buildPacoteFixture());

    renderWithProviders(<PacotePanel pacoteId="pacote-1" currentCargaId="carga-1" />);

    await waitFor(() => {
      expect(screen.getByTestId("pacote-panel")).toBeInTheDocument();
    });

    // Carga atual destacada
    expect(screen.getByTestId("pacote-carga-current")).toBeInTheDocument();
    expect(screen.getByText("Você está aqui")).toBeInTheDocument();

    // Demais cargas têm link "Ver detalhes"
    const otherItems = screen.getAllByTestId("pacote-carga-other");
    expect(otherItems).toHaveLength(1);
    const verDetalhes = screen.getByRole("link", { name: /ver detalhes/i });
    expect(verDetalhes).toHaveAttribute("href", "/motorista/cargas/carga-2");
  });

  it("renderiza header com N paradas + valor_total", async () => {
    fetchPacoteMock.mockResolvedValueOnce(buildPacoteFixture());

    renderWithProviders(<PacotePanel pacoteId="pacote-1" currentCargaId="carga-1" />);

    await waitFor(() => {
      expect(screen.getByText(/Viagem casada — 2 paradas/)).toBeInTheDocument();
    });

    // Valor total formatado em BRL (12.500,00) — busca tolerante a NBSP do
    // Intl.NumberFormat pt-BR (R$<NBSP>12.500,00).
    expect(screen.getByLabelText(/Valor total R\$.*12\.500,00/)).toBeInTheDocument();
  });

  it("respeita ordem_viagem mesmo se array vier desordenado", async () => {
    const desordenado = buildPacoteFixture();
    desordenado.cargas = [desordenado.cargas[1], desordenado.cargas[0]];
    fetchPacoteMock.mockResolvedValueOnce(desordenado);

    renderWithProviders(<PacotePanel pacoteId="pacote-1" currentCargaId="carga-1" />);

    await waitFor(() => {
      expect(screen.getByTestId("pacote-panel")).toBeInTheDocument();
    });

    const items = screen.getAllByRole("listitem");
    // Primeira parada deve ser a ordem_viagem=1 (Cliente A)
    expect(items[0]).toHaveTextContent("Parada 1");
    expect(items[1]).toHaveTextContent("Parada 2");
  });

  it("mostra fallback de erro com botão tentar novamente", async () => {
    fetchPacoteMock.mockRejectedValueOnce(new Error("HTTP 500"));

    renderWithProviders(<PacotePanel pacoteId="pacote-1" currentCargaId="carga-1" />);

    await waitFor(() => {
      expect(screen.getByTestId("pacote-panel-error")).toBeInTheDocument();
    });

    expect(screen.getByText(/Tentar novamente/i)).toBeInTheDocument();
  });
});

// ─── DriverCargoDetails — branch completo ──────────────────────────────────
// Cobertura via E2E no plan 10-08 (Playwright). RTL mocks completos exigem
// fixture de useQuery principal + fetchDriverClientsByIds + route fallback +
// publicSupabase.channel — extrapola budget de F-6.

describe("DriverCargoDetails — pacote branch", () => {
  it.skip("renderiza PacotePanel quando cargo.viagem_id está presente", () => {
    // TODO: cobertura E2E no plan 10-08 (visual full-page + realtime emit).
  });

  it.skip("backward-compat: cargo.viagem_id null renderiza idêntico ao snapshot atual", () => {
    // TODO: cobertura E2E no plan 10-08 (snapshot avulsa).
  });

  it.skip("realtime version-bump dispara toast.info + invalida queries", () => {
    // TODO: cobertura E2E no plan 10-08 (operador edita pacote → driver recebe toast).
  });

  it.skip("realtime UPDATE com version <= currentVersion NÃO invalida (T-10-29)", () => {
    // TODO: cobertura unit no usePacoteRealtime quando mocks de channel
    //       suportarem manual emit (extrapola escopo desta fase).
  });
});
