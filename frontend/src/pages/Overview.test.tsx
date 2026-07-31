import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Painel (/painel). Cobre o contrato de FRESCOR/EGRESS desta tela, que nao tinha
// nenhum teste de pagina: quais tabelas o realtime assina, quais opcoes de
// refetch cada query usa e quais colunas o snapshot pede ao PostgREST.

const { mockUseQuery, mockInvalidateQueries } = vi.hoisted(() => ({
  mockUseQuery: vi.fn(),
  mockInvalidateQueries: vi.fn(),
}));

const {
  realtimeCallbacks,
  mockChannelOn,
  mockSupabaseChannel,
  mockSupabaseRemoveChannel,
  mockSupabaseFrom,
  supabaseSelectCalls,
  supabaseRowsByTable,
} = vi.hoisted(() => {
  const callbacks = new Map<string, () => void>();
  const on = vi.fn();
  const channel = {
    on: on.mockImplementation((event: string, filter: { table?: string }, callback: () => void) => {
      if (event === "postgres_changes" && filter?.table) {
        callbacks.set(filter.table, callback);
      }
      return channel;
    }),
    subscribe: vi.fn(() => channel),
  };

  const selectCalls: Array<{ table: string; columns: string }> = [];
  const rowsByTable: Record<string, Array<Record<string, unknown>>> = {};

  const from = vi.fn((table: string) => {
    const builder = {
      select: vi.fn((columns: string) => {
        selectCalls.push({ table, columns });
        return builder;
      }),
      order: vi.fn(() => builder),
      limit: vi.fn(() => Promise.resolve({ data: rowsByTable[table] ?? [], error: null })),
    };
    return builder;
  });

  return {
    realtimeCallbacks: callbacks,
    mockChannelOn: on,
    mockSupabaseChannel: vi.fn(() => channel),
    mockSupabaseRemoveChannel: vi.fn(),
    mockSupabaseFrom: from,
    supabaseSelectCalls: selectCalls,
    supabaseRowsByTable: rowsByTable,
  };
});

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query");

  return {
    ...actual,
    useQuery: mockUseQuery,
    useQueryClient: () => ({ invalidateQueries: mockInvalidateQueries }),
  };
});

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    channel: mockSupabaseChannel,
    removeChannel: mockSupabaseRemoveChannel,
    from: mockSupabaseFrom,
  },
}));

vi.mock("@/services/readModels", () => ({
  fetchSponsorClicks: vi.fn(),
  fetchOperatorOverviewDigest: vi.fn(),
}));

vi.mock("@/components/DashboardHeader", () => ({
  default: ({ title }: { title: string }) => <div>{title}</div>,
}));

// Os blocos de driver-flow tem query propria e graficos — irrelevantes aqui e
// caros de montar no jsdom.
vi.mock("@/components/driver-flow/useDriverFlowMetrics", () => ({
  useDriverFlowMetrics: () => ({
    dateFrom: "2026-07-01",
    dateTo: "2026-07-31",
    setDateFrom: vi.fn(),
    setDateTo: vi.fn(),
    quickRange: vi.fn(),
    clear: vi.fn(),
    query: { data: undefined, isLoading: false, error: null },
  }),
}));

vi.mock("@/components/driver-flow/DriverFlowBlocks", () => ({
  DriverFlowPeriodBar: () => null,
  DriverFlowGate: () => null,
  CadastroDestaqueCard: () => null,
  AcessosCard: () => null,
  FunilCard: () => null,
  ValidacaoCard: () => null,
  PicoCandidaturaCard: () => null,
  PicoAcessoCard: () => null,
  RecorrenciaCard: () => null,
}));

import Overview from "@/pages/Overview";

type QueryOptions = {
  queryKey?: unknown[];
  queryFn?: () => Promise<unknown>;
  staleTime?: number;
  refetchInterval?: unknown;
  refetchIntervalInBackground?: unknown;
  refetchOnWindowFocus?: unknown;
};

const SNAPSHOT_FIXTURE = {
  hero: {
    activeLoads: 2,
    departuresNext24h: 0,
    queuedLeads: 1,
    noDriverLoads: 1,
    activeClaims: 2,
    draftCount: 1,
    bookedCount: 1,
    approvedToday: 0,
    overdueLoads: 0,
    reservedCount: 1,
    pendingApprovals: 1,
  },
  attentionLoads: [],
  recentActivity: [],
  lastUpdatedAt: "2026-07-30T12:00:00.000Z",
};

function findQueryOptions(scope: string) {
  return mockUseQuery.mock.calls
    .map(([options]) => options as QueryOptions)
    .find((options) => options?.queryKey?.[1] === scope);
}

function renderOverview() {
  return render(
    <MemoryRouter>
      <Overview />
    </MemoryRouter>,
  );
}

describe("Overview (Painel)", () => {
  beforeEach(() => {
    mockUseQuery.mockReset();
    mockInvalidateQueries.mockReset();
    realtimeCallbacks.clear();
    mockChannelOn.mockClear();
    mockSupabaseChannel.mockClear();
    mockSupabaseRemoveChannel.mockClear();
    mockSupabaseFrom.mockClear();
    supabaseSelectCalls.length = 0;
    for (const table of Object.keys(supabaseRowsByTable)) {
      delete supabaseRowsByTable[table];
    }

    mockUseQuery.mockImplementation((options: QueryOptions) => {
      const scope = options?.queryKey?.[1];
      if (scope === "overview-dashboard") {
        return { data: SNAPSHOT_FIXTURE, isLoading: false, error: null };
      }
      if (scope === "overview-digest") {
        return { data: { digest: "1:2:3:4:5:6" }, isLoading: false, error: null };
      }
      if (scope === "sponsor-clicks") {
        return { data: { items: [] }, isLoading: false, error: null };
      }
      return { data: undefined, isLoading: false, error: null };
    });
  });

  it("assina no realtime apenas leads/claims — o canal ruidoso de cargas ficou de fora", async () => {
    renderOverview();

    await waitFor(() => {
      expect(mockSupabaseChannel).toHaveBeenCalledTimes(1);
    });
    // Canal com sufixo aleatorio (uma aba nao derruba o canal da outra).
    const channelName = (mockSupabaseChannel.mock.calls[0] as unknown as unknown[])[0];
    expect(String(channelName)).toMatch(/^operator-overview-/);

    // Proxy direto do medidor de Realtime Message Count: cada tabela assinada
    // entrega 1 mensagem por linha alterada, por aba aberta. `cargas` era a
    // tabela reescrita em massa pelo sheet sync a cada 5min — 3 listeners
    // viraram 2, e o que saiu e justamente o de volume.
    const postgresChangesCalls = mockChannelOn.mock.calls.filter(([event]) => event === "postgres_changes");
    expect(postgresChangesCalls.map(([, filter]) => (filter as { table?: string })?.table)).toEqual([
      "load_public_leads",
      "load_claims",
    ]);
    expect(realtimeCallbacks.has("cargas")).toBe(false);
    // Nenhum listener usa filter (nao ha `filter` para adicionar sem perder
    // transicoes) — registrado para que ninguem "conserte" isso depois.
    for (const [, filter] of postgresChangesCalls) {
      expect((filter as { filter?: string }).filter).toBeUndefined();
    }
  });

  it("evento de lead ainda revalida o snapshot (com debounce)", async () => {
    renderOverview();

    await waitFor(() => {
      expect(realtimeCallbacks.has("load_public_leads")).toBe(true);
    });

    realtimeCallbacks.get("load_public_leads")?.();

    // Debounce de 1.5s: waitFor precisa de folga.
    await waitFor(
      () => {
        expect(mockInvalidateQueries).toHaveBeenCalledWith({
          queryKey: ["operator", "overview-dashboard"],
        });
      },
      { timeout: 3_000 },
    );
  });

  it("snapshot nao refetcha no foco da aba; o digest sonda no lugar dele", () => {
    renderOverview();

    const snapshotOptions = findQueryOptions("overview-dashboard");
    const digestOptions = findQueryOptions("overview-digest");

    // Volta ao default do QueryClient (App.tsx). Antes era `true`: cada foco de
    // aba com >60s de idade rebaixava os 3x select(500) mesmo sem nada ter
    // mudado.
    expect(snapshotOptions).toMatchObject({
      staleTime: 60_000,
      refetchOnWindowFocus: false,
    });
    expect(snapshotOptions?.refetchInterval).toBeUndefined();

    // Companheiro obrigatorio: com staleTime de 30s o digest (3 agregados
    // escalares, ~0,3 KB) e reavaliado a cada foco, e o snapshot so e invalidado
    // se o digest mudou de fato. Sem isso, um foco dentro da janela do poll nao
    // buscaria nada.
    // O intervalo de 60s e o teto de propagacao passiva de `cargas` no Painel
    // (unico gatilho restante depois que o listener realtime da tabela saiu), e
    // alinha o Painel com o poll de 60s da propria Fila. Nao afrouxar para 5min:
    // deixaria o operador ate 5min sem ver uma carga fechada por outra pessoa.
    expect(digestOptions).toMatchObject({
      staleTime: 30_000,
      refetchInterval: 60_000,
      refetchIntervalInBackground: false,
      refetchOnWindowFocus: true,
    });
  });

  it("pede ao PostgREST somente as colunas que o snapshot le, e o resultado nao muda", async () => {
    supabaseRowsByTable.cargas = [
      {
        id: "c1", data: "2020-01-10", horario: "08:00:00", origem: "Salvador / BA", destino: "Campinas / SP",
        distancia_km: 1800, perfil: "CARRETA", status: "OPEN", is_template: false,
        created_at: "2020-01-01T10:00:00.000Z", updated_at: "2020-01-01T10:00:00.000Z",
        sheet_data_carregamento: null,
      },
      {
        id: "c2", data: "2020-01-11", horario: "09:00:00", origem: "Recife / PE", destino: "Natal / RN",
        distancia_km: 300, perfil: "TRUCK", status: "OPEN", is_template: false,
        created_at: "2020-01-02T10:00:00.000Z", updated_at: "2020-01-02T10:00:00.000Z",
        sheet_data_carregamento: null,
      },
      {
        id: "c3", data: "2020-01-12", horario: "07:00:00", origem: "Curitiba / PR", destino: "Joinville / SC",
        distancia_km: 130, perfil: "TRUCK", status: "DRAFT", is_template: false,
        created_at: "2020-01-03T10:00:00.000Z", updated_at: "2020-01-03T10:00:00.000Z",
        sheet_data_carregamento: null,
      },
      {
        id: "c4", data: "2020-01-13", horario: "07:00:00", origem: "Manaus / AM", destino: "Belem / PA",
        distancia_km: 1500, perfil: "CARRETA", status: "BOOKED", is_template: false,
        created_at: "2020-01-04T10:00:00.000Z", updated_at: "2020-01-04T10:00:00.000Z",
        sheet_data_carregamento: null,
      },
      {
        id: "c5", data: "2020-01-14", horario: "07:00:00", origem: "Ilheus / BA", destino: "Vitoria / ES",
        distancia_km: 800, perfil: "CARRETA", status: "RESERVED", is_template: false,
        created_at: "2020-01-05T10:00:00.000Z", updated_at: "2020-01-05T10:00:00.000Z",
        sheet_data_carregamento: null,
      },
    ];
    supabaseRowsByTable.load_public_leads = [
      {
        id: "l1", load_id: "c1", status: "QUEUED", created_at: "2020-01-06T10:00:00.000Z",
        queued_at: "2020-01-06T10:00:00.000Z", approved_at: null, whatsapp_clicked_at: null,
        vehicle_type: "CARRETA",
      },
      {
        id: "l2", load_id: "c5", status: "APPROVED", created_at: "2020-01-07T10:00:00.000Z",
        queued_at: "2020-01-07T10:00:00.000Z", approved_at: "2020-01-07T11:00:00.000Z",
        whatsapp_clicked_at: null, vehicle_type: "CARRETA",
      },
    ];
    supabaseRowsByTable.load_claims = [];

    renderOverview();

    const snapshotOptions = findQueryOptions("overview-dashboard");
    const snapshot = (await snapshotOptions?.queryFn?.()) as typeof SNAPSHOT_FIXTURE;

    const cargoSelect = supabaseSelectCalls.find((call) => call.table === "cargas")?.columns ?? "";
    const cargoColumns = cargoSelect.split(",").map((column) => column.trim());

    // Payload morto removido: nenhuma conta de buildOverviewSnapshot le esses
    // campos (so existiam na tipagem), e o embed custava um join por linha.
    expect(cargoColumns).toEqual([
      "id", "data", "horario", "origem", "destino", "distancia_km", "perfil", "status",
      "is_template", "created_at", "updated_at", "sheet_data_carregamento",
    ]);
    expect(cargoSelect).not.toMatch(/valor|bonus|duracao_horas|clientes?\(/);

    // ... e com as linhas enxutas os numeros da tela sao exatamente os mesmos.
    expect(snapshot.hero).toMatchObject({
      activeLoads: 2,
      queuedLeads: 1,
      pendingApprovals: 1,
      activeClaims: 2,
      noDriverLoads: 1,
      draftCount: 1,
      bookedCount: 1,
      reservedCount: 1,
      departuresNext24h: 0,
    });
    expect(snapshot.lastUpdatedAt).toBe("2020-01-07T11:00:00.000Z");
  });

  it("renderiza os numeros-chave do snapshot", () => {
    renderOverview();

    expect(screen.getByText("Painel")).toBeInTheDocument();
    expect(screen.getAllByText("Cargas ativas").length).toBeGreaterThan(0);
    // activeLoads (2) aparece no hero e no KPI da aba "Visao geral".
    expect(screen.getAllByText("2").length).toBeGreaterThan(0);
  });
});
