/**
 * DriverCargoDetails — branch "pacote" (plan 10-06) + CONTAGEM DE REQUESTS do
 * detalhe da carga (workstream de egress, PONTO 8).
 *
 * Cobertura RTL do PacotePanel/CargaParadaCard é estrutural (smoke). O bloco
 * novo no fim do arquivo renderiza a PÁGINA e mede quantas idas à rede ela
 * custa: a tela passou a consumir `GET /api/driver/cargas/:id` (uma request,
 * respondida por um read model cacheado no servidor) em vez de ler o banco
 * direto do navegador com a chave anônima — antes eram 2 a 4 idas
 * navegador→pooler por abertura:
 *
 *   1. `cargas` + JOIN de `clientes` (SELECT de ~30 colunas)
 *   2. `route_metrics_cache` (sempre; em produção a policy anônima nega)
 *   3. `cargas` de novo, para herdar a distância do trecho (quando faltava)
 *   4. `clientes`, quando o JOIN não resolvia o cliente
 *
 * Os testes travam: (a) exatamente 1 request de detalhe por abertura, em todos
 * os cenários — inclusive nos que antes disparavam os fallbacks; (b) ZERO uso
 * do cliente Supabase anônimo na página; (c) o conteúdo renderizado (pagamento,
 * cliente, exigências, reputação, percurso, veículo) preservado.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";

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
      in: vi.fn().mockReturnThis(),
      not: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    })),
  },
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: null } }),
      signInWithPassword: vi.fn(),
      signOut: vi.fn(),
    },
  },
}));

vi.mock("@/hooks/useDriverAuth", () => ({
  useDriverAuth: () => ({ session: null, profile: null, loading: false, signOut: vi.fn() }),
  DriverAuthProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// Realtime do pacote assina um channel do Supabase — irrelevante para contagem
// de requests HTTP e ruidoso em jsdom.
vi.mock("@/hooks/usePacoteRealtime", () => ({
  usePacoteRealtime: () => undefined,
}));

// Painel de candidatura e wizard: stubs. Nenhum dos dois participa do carregamento
// do detalhe (só abrem em clique) e ambos trazem fetches próprios.
vi.mock("@/components/driver/DriverClaimPanel", () => ({
  default: ({ loadId }: { loadId: string }) => <div data-testid="claim-panel">{loadId}</div>,
}));

vi.mock("@/components/driver/cadastro-v2/DriverRegistrationWizard", () => ({
  DriverRegistrationWizard: () => null,
}));

const requestJsonMock = vi.fn();
vi.mock("@/services/apiClient", async () => {
  const actual = await vi.importActual<typeof import("@/services/apiClient")>(
    "@/services/apiClient",
  );
  return {
    ...actual,
    requestJson: (url: string, options?: unknown) => requestJsonMock(url, options),
  };
});

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

// ─── DriverCargoDetails — contagem de requests do detalhe (egress) ──────────

import { publicSupabase } from "@/integrations/supabase/public-client";
import DriverCargoDetails from "./DriverCargoDetails";

const CARGO_ID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";

const clienteFixture = {
  id: "cli-detalhe",
  nome: "Embarcador Detalhe",
  descricao: "Cliente do detalhe",
  forma_pagamento: "PIX 7 dias",
  prazo_pagamento: "7 dias",
  observacoes: "Chegar com 1h de antecedência.",
  exige_antt: true,
  exige_carga_monitorada: false,
  exige_rastreamento: true,
  exige_seguro: false,
  reputacao_boa_comunicacao: true,
  reputacao_bom_pagador: true,
  reputacao_carga_organizada: false,
  reputacao_liberacao_rapida: false,
  reputacao_pagamento_rapido: false,
  custom_reputacoes: null,
  custom_exigencias: null,
};

/** Payload do endpoint — mesma forma que `fetchDriverCargoDetail` consome. */
function buildDetailResponse(overrides: Record<string, unknown> = {}) {
  const cargoOverrides = (overrides.cargo ?? {}) as Record<string, unknown>;

  return {
    cargo: {
      id: CARGO_ID,
      data: "2099-06-02",
      horario: "08:00:00",
      origem: "Salvador / BA",
      destino: "Simoes Filho / BA",
      distancia_km: 1500,
      duracao_horas: 24,
      perfil: "CARRETA",
      eixos: null,
      valor: 7200,
      bonus: 300,
      bonus_exigencias: "Lona nova\nRastreador ativo",
      status: "OPEN",
      cliente_id: clienteFixture.id,
      sheet_data_carregamento: "2099-06-02 08:00",
      sheet_data_descarga: "2099-06-03 12:00",
      viagem_id: null,
      ordem_viagem: null,
      cliente: clienteFixture,
      ...cargoOverrides,
    },
    routeFallback: null,
    historyDistanciaKm: null,
    meta: { correlationId: "corr-test" },
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== "cargo")),
  };
}

/** Requests que a página emitiu para o endpoint de detalhe. */
function detailRequestUrls() {
  return requestJsonMock.mock.calls
    .map((call) => String(call[0]))
    .filter((url) => url.startsWith("/api/driver/cargas/"));
}

function renderCargoDetails() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/motorista/cargas/${CARGO_ID}`]}>
        <Routes>
          <Route path="/motorista/cargas/:cargoId" element={<DriverCargoDetails />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("DriverCargoDetails — requests por abertura do detalhe", () => {
  beforeEach(() => {
    requestJsonMock.mockReset();
    fetchPacoteMock.mockReset();
    (publicSupabase.from as unknown as ReturnType<typeof vi.fn>).mockClear();
    // POST fire-and-forget de "visita ao portal" (pré-existente) — stubado para
    // não sair da suíte e para ficar contável separadamente do detalhe.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }),
    );
    // O POST de visita é gravado 1× por sessão via sessionStorage.
    sessionStorage.clear();
  });

  it("uma única request de detalhe e ZERO leitura direta no banco pelo navegador", async () => {
    requestJsonMock.mockResolvedValue(buildDetailResponse());

    renderCargoDetails();

    await waitFor(() => {
      expect(screen.getByText(/Coleta, entrega e percurso/i)).toBeInTheDocument();
    });

    // Antes: 2 a 4 leituras navegador→pooler. Agora: 1 request ao backend.
    expect(detailRequestUrls()).toEqual([`/api/driver/cargas/${CARGO_ID}`]);
    // A página não fala mais com o Supabase anônimo (nem cargas, nem clientes,
    // nem route_metrics_cache).
    expect(publicSupabase.from).not.toHaveBeenCalled();
  });

  it("preserva o conteúdo renderizado (pagamento, cliente, exigências, reputação, percurso)", async () => {
    requestJsonMock.mockResolvedValue(buildDetailResponse());

    const { container } = renderCargoDetails();

    await waitFor(() => {
      expect(screen.getByText(/Coleta, entrega e percurso/i)).toBeInTheDocument();
    });

    // Cabeçalho da rota
    expect(container.querySelector("h1")?.textContent).toContain("Salvador / BA");
    expect(container.querySelector("h1")?.textContent).toContain("Simoes Filho / BA");

    // Pagamento total = valor + bônus (7.200 + 300). O Intl pt-BR usa NBSP
    // depois do "R$" — normaliza para espaço comum antes de casar.
    const flatten = (text: string) => text.replace(/\u00a0/g, " ");
    expect(
      Array.from(container.querySelectorAll("p")).some((p) =>
        /R\$ 7\.500,00/.test(flatten(p.textContent ?? "")),
      ),
    ).toBe(true);

    // Cliente + condições de pagamento
    expect(screen.getAllByText(/Embarcador Detalhe/).length).toBeGreaterThan(0);
    expect(screen.getByText("PIX 7 dias")).toBeInTheDocument();
    expect(screen.getByText("7 dias")).toBeInTheDocument();
    expect(screen.getByText(/Chegar com 1h de antecedência/)).toBeInTheDocument();

    // Exigências ativas (e só as ativas)
    expect(screen.getByText("Rastreamento")).toBeInTheDocument();
    expect(screen.getByText("ANTT")).toBeInTheDocument();
    expect(screen.queryByText("Seguro")).not.toBeInTheDocument();
    expect(screen.queryByText("Carga monitorada")).not.toBeInTheDocument();

    // Reputação: os 5 selos aparecem (ativos e inativos)
    expect(screen.getByText("Bom pagador")).toBeInTheDocument();
    expect(screen.getByText("Boa comunicação")).toBeInTheDocument();
    expect(screen.getByText("Pagamento rápido")).toBeInTheDocument();

    // Percurso + veículo + rótulos operacionais
    expect(screen.getByText("1.500 km")).toBeInTheDocument();
    expect(screen.getByText("Carreta")).toBeInTheDocument();
    expect(screen.getByText("02/06/2099 08:00")).toBeInTheDocument();
    expect(screen.getByText("03/06/2099 12:00")).toBeInTheDocument();

    // Bônus por conformidade (linha por exigência)
    expect(screen.getByText("Lona nova")).toBeInTheDocument();
    expect(screen.getByText("Rastreador ativo")).toBeInTheDocument();
  });

  it("herda perfil/valor/eixos do catálogo de rotas sem request extra", async () => {
    requestJsonMock.mockResolvedValue(
      buildDetailResponse({
        cargo: { perfil: "", valor: null, bonus: null, eixos: null, distancia_km: null, duracao_horas: null },
        routeFallback: {
          distancia_km: 1200,
          duracao_horas: 18,
          tempo_estimado_horas: 20,
          perfil_padrao: "CARRETA",
          eixos: 6,
          valor_padrao: 6400,
          bonus_padrao: 150,
        },
      }),
    );

    renderCargoDetails();

    await waitFor(() => {
      expect(screen.getByText(/Coleta, entrega e percurso/i)).toBeInTheDocument();
    });

    expect(screen.getByText("Carreta · 6 eixos")).toBeInTheDocument();
    expect(screen.getByText("1.200 km")).toBeInTheDocument();
    expect(detailRequestUrls()).toHaveLength(1);
    expect(publicSupabase.from).not.toHaveBeenCalled();
  });

  it("fallback de distância do histórico do trecho: mesma 1 request (antes eram 3)", async () => {
    requestJsonMock.mockResolvedValue(
      buildDetailResponse({
        cargo: { distancia_km: null },
        routeFallback: null,
        historyDistanciaKm: 900,
      }),
    );

    renderCargoDetails();

    await waitFor(() => {
      expect(screen.getByText(/Coleta, entrega e percurso/i)).toBeInTheDocument();
    });

    expect(screen.getByText("900 km")).toBeInTheDocument();
    expect(detailRequestUrls()).toHaveLength(1);
    expect(publicSupabase.from).not.toHaveBeenCalled();
  });

  it("carga sem dados de publicação continua caindo em 'Carga em preparacao'", async () => {
    requestJsonMock.mockResolvedValue(
      buildDetailResponse({
        cargo: { perfil: "", valor: null, bonus: null, distancia_km: null, duracao_horas: null },
        routeFallback: null,
        historyDistanciaKm: null,
      }),
    );

    renderCargoDetails();

    await waitFor(() => {
      expect(screen.getByText(/Carga em preparacao/i)).toBeInTheDocument();
    });

    // O aviso continua listando o que falta (texto vem de resolveCargoPublicationReadiness).
    expect(screen.getByText(/Faltam perfil do veiculo, frete/i)).toBeInTheDocument();
    expect(detailRequestUrls()).toHaveLength(1);
  });

  it("404 do endpoint cai no ErrorState (era o throw 'Carga não encontrada')", async () => {
    requestJsonMock.mockRejectedValue(new Error("Carga não encontrada."));

    renderCargoDetails();

    await waitFor(() => {
      expect(screen.getByText(/Não foi possível abrir esta carga/i)).toBeInTheDocument();
    });

    expect(detailRequestUrls()).toHaveLength(1);
    expect(publicSupabase.from).not.toHaveBeenCalled();
  });

  it("carga de pacote: 1 request de detalhe + 1 do pacote (nenhuma leitura direta)", async () => {
    requestJsonMock.mockResolvedValue(
      buildDetailResponse({ cargo: { viagem_id: "pacote-1", ordem_viagem: 1 } }),
    );
    fetchPacoteMock.mockResolvedValue(buildPacoteFixture());

    renderCargoDetails();

    await waitFor(() => {
      expect(screen.getByTestId("pacote-paradas-grid")).toBeInTheDocument();
    });

    expect(detailRequestUrls()).toHaveLength(1);
    expect(fetchPacoteMock).toHaveBeenCalledTimes(1);
    expect(publicSupabase.from).not.toHaveBeenCalled();
    // Seções de carga avulsa saem de cena no branch pacote (comportamento atual).
    // NB: o header "Coleta, entrega e percurso" reaparece dentro de cada
    // CargaParadaCard (espelhamento do plan revisão 2026-05-23), então a
    // ausência se verifica pelas seções exclusivas da avulsa.
    expect(screen.queryByText(/Cliente da carga/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Reputação do cliente/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Bônus por conformidade/i)).not.toBeInTheDocument();
  });
});
