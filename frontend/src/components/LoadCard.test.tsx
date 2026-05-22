import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { auth: { getSession: vi.fn(), signInWithPassword: vi.fn(), signOut: vi.fn() } },
}));

vi.mock("@/integrations/supabase/public-client", () => ({
  publicSupabase: { channel: vi.fn(() => ({ on: vi.fn().mockReturnThis(), subscribe: vi.fn() })), removeChannel: vi.fn() },
}));

import LoadCard from "./LoadCard";
import * as readModels from "@/services/readModels";

/**
 * Wrapper para todos os testes — combina MemoryRouter (Link de cliente/Detalhes)
 * e QueryClientProvider (PacoteStopsList usa useQuery). Cria novo client por
 * render para isolar cache entre testes.
 */
const renderLoadCard = (ui: React.ReactElement) => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
};

const baseProps = {
  id: "ABC12345",
  loadId: "load-123",
  dateTime: "Saída hoje às 08:00",
  clienteId: "client-123",
  clienteNome: "Cliente Exemplo",
  carregamentoLabel: "03/04/2026 22:30",
  descargaLabel: "04/04/2026 16:30",
  origemCidade: "Salvador",
  origemEstado: "BA",
  destinoCidade: "Feira de Santana",
  destinoEstado: "BA",
  tipoVeiculo: "CARRETA",
  secondaryLabel: "Percurso recomendado",
  secondaryValue: "550 km",
  secondarySupportText: "Tempo estimado: 7h 30min",
  pagamento: "R$ 1.250,00",
  paymentDetails:
    "R$ 1.000,00 da carga + R$ 250,00 de bônus por concluir a entrega seguindo as normas pedidas",
  routeDistanceLabel: "550 km",
  routeDurationLabel: "Tempo estimado: 7h 30min",
  detailsHref: "/motorista/cargas/load-123",
};

const fakePacoteFull: readModels.PacoteFull = {
  id: "pacote-1",
  status: "publicado",
  valor_total: 5000,
  version: 1,
  published_at: null,
  total_cargas: 3,
  cargas: [
    {
      id: "carga-1",
      ordem_viagem: 1,
      status: "aberta",
      origem: "São Paulo",
      destino: "Salvador",
      perfil: "CARRETA",
      valor: 1500,
      bonus: null,
      bonus_exigencias: null,
      data: null,
      horario: null,
      distancia_km: null,
      duracao_horas: null,
      driver_visibility: "PREMIUM",
      cliente: null,
    },
    {
      id: "carga-2",
      ordem_viagem: 2,
      status: "aberta",
      origem: "Salvador",
      destino: "Recife",
      perfil: "CARRETA",
      valor: 1500,
      bonus: null,
      bonus_exigencias: null,
      data: null,
      horario: null,
      distancia_km: null,
      duracao_horas: null,
      driver_visibility: "PREMIUM",
      cliente: null,
    },
    {
      id: "carga-3",
      ordem_viagem: 3,
      status: "aberta",
      origem: "Recife",
      destino: "Fortaleza",
      perfil: "CARRETA",
      valor: 2000,
      bonus: null,
      bonus_exigencias: null,
      data: null,
      horario: null,
      distancia_km: null,
      duracao_horas: null,
      driver_visibility: "PREMIUM",
      cliente: null,
    },
  ],
};

describe("LoadCard — avulsa (legacy regression)", () => {
  it("links the client name and shows candidacy and details actions", () => {
    renderLoadCard(<LoadCard {...baseProps} />);

    // Marca discriminadora do branch avulsa (zero regressão CARGAS-CASADAS-08)
    expect(screen.getByTestId("load-card-avulsa")).toBeInTheDocument();
    expect(screen.queryByTestId("load-card-pacote")).not.toBeInTheDocument();

    const clientLinks = screen.getAllByRole("link", {
      name: /abrir dados de cliente exemplo/i,
    });
    expect(clientLinks).toHaveLength(2);
    clientLinks.forEach((clientLink) => {
      expect(clientLink).toHaveAttribute("href", "/motorista/cliente/client-123");
    });

    expect(screen.queryByText(/empresa com entrega rapida e atendimento direto/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/carregamento/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/descarga/i)).not.toBeInTheDocument();
    expect(screen.getAllByText(/saída hoje às 08:00/i)).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: /candidatar-se/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: /detalhes/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/tempo estimado: 7h 30min/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/03\/04\/2026 22:30/i)).toHaveLength(2);
    expect(screen.getAllByText(/04\/04\/2026 16:30/i)).toHaveLength(2);
  }, 15000);
});

describe("LoadCard — pacote_meta branch", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const buildPacoteMeta = (overrides: Partial<readModels.PacoteMeta> = {}): readModels.PacoteMeta => ({
    id: "pacote-1",
    status: "publicado",
    valor_total: 5000,
    version: 1,
    total_cargas: 3,
    ordem_propria: 1,
    published_at: null,
    ...overrides,
  });

  it("renderiza viagem casada com header 'N paradas' + 6 stops para 3 cargas", async () => {
    vi.spyOn(readModels, "fetchPacote").mockResolvedValue(fakePacoteFull);

    renderLoadCard(<LoadCard {...baseProps} pacoteMeta={buildPacoteMeta()} />);

    expect(screen.getByTestId("load-card-pacote")).toBeInTheDocument();
    expect(screen.queryByTestId("load-card-avulsa")).not.toBeInTheDocument();

    // Header
    expect(screen.getByText(/viagem casada — 3 paradas/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/valor total/i)).toHaveTextContent(/R\$\s*5\.000,00/);

    // Lista de stops
    await waitFor(() => {
      expect(
        screen.getByRole("list", { name: /viagem com 3 paradas/i }),
      ).toBeInTheDocument();
    });
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(6);

    // Sequência intercalada coleta/entrega
    expect(items[0]).toHaveTextContent(/coleta 1.*são paulo/i);
    expect(items[1]).toHaveTextContent(/entrega 1.*salvador/i);
    expect(items[2]).toHaveTextContent(/coleta 2.*salvador/i);
    expect(items[3]).toHaveTextContent(/entrega 2.*recife/i);
    expect(items[4]).toHaveTextContent(/coleta 3.*recife/i);
    expect(items[5]).toHaveTextContent(/entrega 3.*fortaleza/i);

    // Botão candidatar-se ainda presente (claim flow reusado)
    expect(screen.getAllByRole("button", { name: /candidatar-se/i }).length).toBeGreaterThan(0);
  });

  it("renderiza apenas 4 stops para pacote com 2 cargas", async () => {
    vi.spyOn(readModels, "fetchPacote").mockResolvedValue({
      ...fakePacoteFull,
      total_cargas: 2,
      valor_total: 3000,
      cargas: fakePacoteFull.cargas.slice(0, 2),
    });

    renderLoadCard(
      <LoadCard
        {...baseProps}
        pacoteMeta={buildPacoteMeta({ total_cargas: 2, valor_total: 3000 })}
      />,
    );

    expect(screen.getByText(/viagem casada — 2 paradas/i)).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole("list", { name: /viagem com 2 paradas/i })).toBeInTheDocument();
    });
    expect(screen.getAllByRole("listitem")).toHaveLength(4);
  });

  it("mostra skeletons de loading enquanto fetchPacote não resolveu", () => {
    vi.spyOn(readModels, "fetchPacote").mockImplementation(
      () => new Promise(() => {}), // pending forever
    );

    renderLoadCard(<LoadCard {...baseProps} pacoteMeta={buildPacoteMeta()} />);

    expect(screen.getByTestId("pacote-stops-loading")).toBeInTheDocument();
    expect(screen.getByTestId("pacote-stops-loading")).toHaveAttribute("aria-busy", "true");
    // Header já renderizado mesmo durante loading da lista
    expect(screen.getByText(/viagem casada — 3 paradas/i)).toBeInTheDocument();
  });

  it("mostra fallback acionável quando fetchPacote falha", async () => {
    vi.spyOn(readModels, "fetchPacote").mockRejectedValue(new Error("boom"));

    renderLoadCard(<LoadCard {...baseProps} pacoteMeta={buildPacoteMeta()} />);

    await waitFor(() => {
      expect(screen.getByTestId("pacote-stops-error")).toBeInTheDocument();
    });
    expect(screen.getByRole("alert")).toHaveTextContent(/não foi possível carregar as paradas/i);
    expect(screen.getByRole("button", { name: /tentar novamente/i })).toBeInTheDocument();
  });

  it("degrada para visual avulsa quando total_cargas === 1 (pacote degenerado)", () => {
    const spy = vi.spyOn(readModels, "fetchPacote").mockResolvedValue(fakePacoteFull);

    renderLoadCard(
      <LoadCard
        {...baseProps}
        pacoteMeta={buildPacoteMeta({ total_cargas: 1, valor_total: 1500 })}
      />,
    );

    // Branch avulsa ativo, branch pacote ausente
    expect(screen.getByTestId("load-card-avulsa")).toBeInTheDocument();
    expect(screen.queryByTestId("load-card-pacote")).not.toBeInTheDocument();
    expect(screen.queryByText(/viagem casada/i)).not.toBeInTheDocument();

    // Não deve disparar fetch do pacote — não há lista de stops para carregar
    expect(spy).not.toHaveBeenCalled();
  });

  it("não dispara fetch quando pacoteMeta é null (carga avulsa explícita)", () => {
    const spy = vi.spyOn(readModels, "fetchPacote");

    renderLoadCard(<LoadCard {...baseProps} pacoteMeta={null} />);

    expect(screen.getByTestId("load-card-avulsa")).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
  });
});
