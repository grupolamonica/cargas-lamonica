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
import CargaParadaCard from "@/components/driver/CargaParadaCard";
import type { PacoteCarga, PacoteFull } from "@/services/readModels";

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

// ─── CargaParadaCard — smoke tests (plan revisao 2026-05-23) ───────────────
//
// Cobre o sub-card que substitui a antiga card unica "Coleta, entrega e
// percurso" quando a carga aberta pertence a um pacote.
//
// iter #2 (2026-05-23 D9): CargaParadaCard agora ESPELHA exatamente o JSX
// do bloco "Coleta, entrega e percurso" do avulsa. Tempo estimado +
// Percurso recomendado VOLTAM (5 DetailMetrics no total). D5 mantido so
// para o LoadCard listing.

function buildPacoteCargaFixture(overrides: Partial<PacoteCarga> = {}): PacoteCarga {
  return {
    id: "carga-x",
    ordem_viagem: 2,
    status: "OPEN",
    origem: "Salvador / BA",
    destino: "Recife / PE",
    perfil: "CARRETA",
    valor: 4_500,
    bonus: 200,
    bonus_exigencias: null,
    data: "2026-06-12",
    horario: "08:30",
    distancia_km: 800,
    duracao_horas: 12,
    driver_visibility: "PREMIUM",
    cliente: null,
    ...overrides,
  };
}

describe("CargaParadaCard", () => {
  it("renderiza header 'Carga N — origem -> destino' com data-testid 'current' quando isCurrent=true", () => {
    renderWithProviders(
      <CargaParadaCard carga={buildPacoteCargaFixture()} isCurrent index={2} />,
    );

    expect(screen.getByTestId("carga-parada-current")).toBeInTheDocument();
    expect(screen.queryByTestId("carga-parada-other")).not.toBeInTheDocument();
    expect(screen.getByText(/carga 2/i)).toBeInTheDocument();
    expect(screen.getByText(/salvador \/ ba/i)).toBeInTheDocument();
    expect(screen.getByText(/recife \/ pe/i)).toBeInTheDocument();
    // Badge "Voce esta aqui" removido (iter #4) — apenas testid muda entre variantes.
    expect(screen.queryByText(/voc[eê] est[áa] aqui/i)).not.toBeInTheDocument();
  });

  it("usa data-testid 'other' quando isCurrent=false", () => {
    renderWithProviders(
      <CargaParadaCard carga={buildPacoteCargaFixture()} isCurrent={false} index={2} />,
    );

    expect(screen.getByTestId("carga-parada-other")).toBeInTheDocument();
    expect(screen.queryByText(/voc[eê] est[áa] aqui/i)).not.toBeInTheDocument();
  });

  it("espelha o card avulsa: header 'Informações da carga / Coleta, entrega e percurso' + 5 DetailMetrics (iter #2 D9)", () => {
    renderWithProviders(
      <CargaParadaCard carga={buildPacoteCargaFixture()} isCurrent index={2} />,
    );

    // Header idêntico ao avulsa (D9)
    expect(screen.getByText(/informações da carga/i)).toBeInTheDocument();
    expect(screen.getByText(/coleta, entrega e percurso/i)).toBeInTheDocument();

    // 5 DetailMetrics presentes (espelha avulsa)
    expect(screen.getByText(/carregamento/i)).toBeInTheDocument();
    expect(screen.getByText(/descarga/i)).toBeInTheDocument();
    expect(screen.getByText(/tempo estimado/i)).toBeInTheDocument();
    expect(screen.getByText(/tipo de ve[íi]culo/i)).toBeInTheDocument();
    expect(screen.getByText(/percurso recomendado/i)).toBeInTheDocument();

    // Valor do perfil (CARRETA) renderizado
    expect(screen.getByText(/carreta/i)).toBeInTheDocument();
    // Distancia formatada para Percurso
    expect(screen.getByText(/800 km/i)).toBeInTheDocument();
  });
});

// ─── DriverCargoDetails — branch completo ──────────────────────────────────
// Cobertura via E2E no plan 10-08 (Playwright). RTL mocks completos exigem
// fixture de useQuery principal + fetchDriverClientsByIds + route fallback +
// publicSupabase.channel — extrapola budget de F-6. Cargas individuais e
// CargaParadaCard ja sao cobertos acima.

describe("DriverCargoDetails — pacote branch", () => {
  it.skip("renderiza grid 'Informações das cargas' quando cargo.viagem_id está presente", () => {
    // TODO: cobertura E2E no plan 10-08 (visual full-page + realtime emit).
    // Verificar AUSENCIA de BÔNUS, CLIENTE, EXIGÊNCIAS, REPUTAÇÃO + presença
    // de N CargaParadaCard + badge "Você está aqui" no current.
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
