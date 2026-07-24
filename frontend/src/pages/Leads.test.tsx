import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import Leads from "@/pages/Leads";

const { mockUseQuery, mockUseQueryClient } = vi.hoisted(() => ({
  mockUseQuery: vi.fn(),
  mockUseQueryClient: vi.fn(),
}));

const { mockApproveOperatorLoadLead } = vi.hoisted(() => ({
  mockApproveOperatorLoadLead: vi.fn(),
}));

const { realtimeCallbacks, mockSupabaseChannel, mockSupabaseRemoveChannel } = vi.hoisted(() => {
  const callbacks = new Map<string, () => void>();
  const channel = {
    on: vi.fn((event: string, filter: { table?: string }, callback: () => void) => {
      if (event === "postgres_changes" && filter?.table) {
        callbacks.set(filter.table, callback);
      }

      return channel;
    }),
    subscribe: vi.fn(() => channel),
  };

  return {
    realtimeCallbacks: callbacks,
    mockSupabaseChannel: vi.fn(() => channel),
    mockSupabaseRemoveChannel: vi.fn(),
  };
});

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query");

  return {
    ...actual,
    useQuery: mockUseQuery,
    useQueryClient: mockUseQueryClient,
  };
});

vi.mock("@/components/DashboardHeader", () => ({
  default: ({ title }: { title: string }) => <div>{title}</div>,
}));

// Reproduz a forma do ApiError (servico de loadClaims) sem importar o modulo
// real — facilita o teste do banner amarelo sem fazer fetch.
// Declarado dentro do vi.hoisted pois a factory de vi.mock e hoisted para o
// topo do arquivo, antes de qualquer declaracao de class top-level.
const { FakeApiError } = vi.hoisted(() => {
  class FakeApiError extends Error {
    status: number;
    code?: string;
    constructor(message: string, opts: { status: number; code?: string }) {
      super(message);
      this.name = "ApiError";
      this.status = opts.status;
      this.code = opts.code;
    }
  }
  return { FakeApiError };
});

vi.mock("@/services/loadClaims", () => ({
  approveOperatorLoadLead: mockApproveOperatorLoadLead,
  fetchOperatorLoadLeads: vi.fn(),
  ApiError: FakeApiError,
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    channel: mockSupabaseChannel,
    removeChannel: mockSupabaseRemoveChannel,
  },
}));

describe("Leads", () => {
  beforeEach(() => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    mockUseQuery.mockReset();
    mockUseQueryClient.mockReset();
    mockApproveOperatorLoadLead.mockReset();
    realtimeCallbacks.clear();
    mockSupabaseChannel.mockClear();
    mockSupabaseRemoveChannel.mockClear();

    mockUseQueryClient.mockReturnValue({
      invalidateQueries: vi.fn(),
    });
    mockUseQuery.mockReturnValue({
      data: {
        groups: [
          {
            load: {
              id: "load-1",
              status: "OPEN",
              origem: "Salvador / BA",
              destino: "Campinas / SP",
              perfil: "CARRETA",
              data: "2026-04-07",
              horario: "08:00:00",
              reservedPublicLeadId: null,
            },
            queueCount: 1,
            totalLeads: 1,
            leads: [
              {
                id: "lead-1",
                status: "QUEUED",
                cpf: "12345678901",
                phone: "71999999999",
                horsePlate: "ABC1D23",
                trailerPlate: "DEF4G56",
                trailerPlate2: "",
                vehicleType: "CARRETA",
                preRegisteredAt: "2026-04-07T10:00:00.000Z",
                queuedAt: "2026-04-07T10:01:00.000Z",
                whatsappClickedAt: "2026-04-07T10:01:00.000Z",
                approvedAt: null,
                approvedBy: null,
                queuePosition: 1,
                validation: {
                  schemaVersion: 1,
                  checkedAt: "2026-04-14T10:00:00.000Z",
                  candidateSubmittedAt: "2026-04-14T09:00:00.000Z",
                  overallStatus: "EXPIRING",
                  missingFields: [],
                  warnings: ["Vigencia do cadastro vence em 12 dia(s)."],
                  driver: {
                    angelira: {
                      status: "FOUND",
                      found: true,
                    },
                    aspx: {
                      status: "FOUND",
                      found: true,
                    },
                  },
                  plates: [
                    {
                      field: "horsePlate",
                      label: "Placa do cavalo",
                      status: "FOUND",
                      found: true,
                      validUntil: "2026-04-26",
                      lastSeenAt: "2026-04-14T10:00:00.000Z",
                    },
                  ],
                  vigency: {
                    status: "EXPIRING",
                    validUntil: "2026-04-26",
                    daysUntilExpiry: 12,
                    source: "ANGELLIRA_DRIVER",
                  },
                  support: {
                    whatsappNumber: "5571997254530",
                    whatsappUrl: "https://wa.me/5571997254530?text=teste",
                  },
                  sources: {
                    angelira: {
                      status: "OK",
                    },
                    aspx: {
                      status: "OK",
                    },
                  },
                },
                whatsappUrl: "https://wa.me/5571999999999",
              },
            ],
          },
          {
            load: {
              id: "load-2",
              status: "RESERVED",
              origem: "Recife / PE",
              destino: "Fortaleza / CE",
              perfil: "TRUCK",
              data: "2026-04-08",
              horario: "09:00:00",
              reservedPublicLeadId: "lead-2",
            },
            queueCount: 0,
            totalLeads: 1,
            leads: [
              {
                id: "lead-2",
                status: "APPROVED",
                cpf: "98765432100",
                phone: "81999991111",
                horsePlate: "XYZ1W29",
                trailerPlate: "GHI3J47",
                trailerPlate2: "JKL5M68",
                vehicleType: "TRUCK",
                preRegisteredAt: "2026-04-08T09:00:00.000Z",
                queuedAt: "2026-04-08T09:01:00.000Z",
                whatsappClickedAt: "2026-04-08T09:01:00.000Z",
                approvedAt: "2026-04-08T09:05:00.000Z",
                approvedBy: "operator-1",
                queuePosition: null,
                validation: null,
                whatsappUrl: "https://wa.me/5581999999999",
              },
            ],
          },
        ],
      },
      isLoading: false,
      isFetching: false,
    });
    mockApproveOperatorLoadLead.mockResolvedValue({});
  });

  it("DC-257: mostra cargas OPEN sem candidatura e selo 'Alocado pelo operador'", () => {
    mockUseQuery.mockReturnValue({
      data: {
        groups: [
          {
            load: {
              id: "open-empty", status: "OPEN", origem: "Salvador / BA", destino: "Campinas / SP",
              perfil: "CARRETA", data: "2026-04-07", horario: "08:00:00", reservedPublicLeadId: null,
            },
            queueCount: 0, totalLeads: 0, leads: [],
          },
          {
            load: {
              id: "open-alloc", status: "OPEN", origem: "Recife / PE", destino: "Natal / RN",
              perfil: "CARRETA", data: "2026-04-08", horario: "09:00:00", reservedPublicLeadId: null,
              sheetMotorista: "JOAO DA SILVA", allocatedByOperator: true,
            },
            queueCount: 0, totalLeads: 0, leads: [],
          },
          {
            // Perna de uma viagem casada (multi-parada) sem candidatura — NÃO deve
            // aparecer fragmentada como carga avulsa.
            load: {
              id: "pacote-leg", status: "OPEN", origem: "Ilhéus / BA", destino: "Vitória / ES",
              perfil: "CARRETA", data: "2026-04-09", horario: "07:00:00", reservedPublicLeadId: null,
              viagemId: "viagem-1", pacoteMeta: { id: "viagem-1", status: "publicado", valorTotal: 9000, version: 1, totalCargas: 2, ordemPropria: 1 },
            },
            queueCount: 0, totalLeads: 0, leads: [],
          },
        ],
      },
      isLoading: false,
      isFetching: false,
    });

    render(<Leads />);

    // Antes eram escondidas (guard leads.length===0). Agora as duas cargas OPEN
    // avulsas sem candidatura aparecem na Fila.
    expect(screen.getByText("Carga open-empty")).toBeInTheDocument();
    expect(screen.getByText("Carga open-alloc")).toBeInTheDocument();
    // Selo do requisito 2 na carga alocada pelo operador no Monitor.
    expect(screen.getByText(/Alocado pelo operador/i)).toBeInTheDocument();
    // Perna de viagem casada sem candidatura NÃO é exibida como card avulso.
    expect(screen.queryByText("Carga pacote-leg")).not.toBeInTheDocument();
  });

  it("DC-272: filtra a fila por presença de candidatura (com/sem)", () => {
    mockUseQuery.mockReturnValue({
      data: {
        groups: [
          {
            load: {
              id: "com-lead", status: "OPEN", origem: "Curitiba / PR", destino: "Joinville / SC",
              perfil: "CARRETA", data: "2026-04-07", horario: "08:00:00", reservedPublicLeadId: null,
            },
            queueCount: 1, totalLeads: 1,
            leads: [
              {
                id: "lead-x", status: "QUEUED", cpf: "11122233344", phone: "71988887777",
                horsePlate: "AAA1A11", trailerPlate: "BBB2B22", trailerPlate2: "",
                vehicleType: "CARRETA", preRegisteredAt: "2026-04-07T10:00:00.000Z",
                queuedAt: "2026-04-07T10:01:00.000Z", whatsappClickedAt: null,
                approvedAt: null, approvedBy: null, queuePosition: 1, validation: null,
                whatsappUrl: "https://wa.me/5571988887777",
              },
            ],
          },
          {
            load: {
              id: "sem-lead", status: "OPEN", origem: "Manaus / AM", destino: "Belém / PA",
              perfil: "CARRETA", data: "2026-04-08", horario: "09:00:00", reservedPublicLeadId: null,
            },
            queueCount: 0, totalLeads: 0, leads: [],
          },
        ],
      },
      isLoading: false,
      isFetching: false,
    });

    render(<Leads />);

    // Padrão "Com e sem candidatura": as duas cargas aparecem.
    expect(screen.getByText("Curitiba / PR -> Joinville / SC")).toBeInTheDocument();
    expect(screen.getByText("Carga sem-lead")).toBeInTheDocument();

    const filtro = screen.getByTitle("Filtrar cargas por presença de candidatura");

    // "Só com candidatura": esconde a carga OPEN vazia (DC-257).
    fireEvent.change(filtro, { target: { value: "com" } });
    expect(screen.getByText("Curitiba / PR -> Joinville / SC")).toBeInTheDocument();
    expect(screen.queryByText("Carga sem-lead")).not.toBeInTheDocument();

    // "Só sem candidatura": mostra apenas a carga OPEN vazia; esconde a que tem fila.
    fireEvent.change(filtro, { target: { value: "sem" } });
    expect(screen.queryByText("Curitiba / PR -> Joinville / SC")).not.toBeInTheDocument();
    expect(screen.getByText("Carga sem-lead")).toBeInTheDocument();
  });

  it("DC-287: os cards do topo (Cargas/Na fila/Reservadas) refletem o filtro de cliente", () => {
    const makeQueuedLead = (id: string, cpf: string, phone: string) => ({
      id, status: "QUEUED", cpf, phone, horsePlate: "AAA1A11", trailerPlate: "BBB2B22",
      trailerPlate2: "", vehicleType: "CARRETA", preRegisteredAt: "2026-04-07T10:00:00.000Z",
      queuedAt: "2026-04-07T10:01:00.000Z", whatsappClickedAt: null, approvedAt: null,
      approvedBy: null, queuePosition: 1, validation: null, whatsappUrl: `https://wa.me/55${phone}`,
    });

    // useQuery é mockado globalmente; roteia por queryKey para servir também os
    // clientes do seletor (senão o dropdown fica vazio e não dá pra filtrar).
    mockUseQuery.mockImplementation((opts: { queryKey?: unknown[] }) => {
      const key = opts?.queryKey?.[1];
      if (key === "clientes-selector") {
        return { data: { items: [{ id: "cli-1", nome: "Cliente A" }, { id: "cli-2", nome: "Cliente B" }] } };
      }
      if (key === "sheet-monitor") {
        return { data: { items: [] } };
      }
      return {
        data: {
          groups: [
            {
              load: {
                id: "load-a", status: "OPEN", origem: "A / AA", destino: "B / BB", perfil: "CARRETA",
                data: "2026-04-07", horario: "08:00:00", reservedPublicLeadId: null,
                clienteId: "cli-1", clienteNome: "Cliente A",
              },
              queueCount: 1, totalLeads: 1, leads: [makeQueuedLead("lead-a", "11111111111", "71911111111")],
            },
            {
              load: {
                id: "load-b", status: "OPEN", origem: "C / CC", destino: "D / DD", perfil: "CARRETA",
                data: "2026-04-08", horario: "09:00:00", reservedPublicLeadId: null,
                clienteId: "cli-2", clienteNome: "Cliente B",
              },
              queueCount: 1, totalLeads: 1, leads: [makeQueuedLead("lead-b", "22222222222", "71922222222")],
            },
          ],
        },
        isLoading: false, isFetching: false,
      };
    });

    render(<Leads />);

    const cargasCardValue = () =>
      within(screen.getByText("Cargas").closest("div") as HTMLElement).getByText(/^\d+$/).textContent;

    // Sem filtro: as duas cargas contam.
    expect(cargasCardValue()).toBe("2");

    // Ao filtrar por Cliente A, o card do topo cai para 1 (antes do fix ficava 2).
    fireEvent.change(screen.getByDisplayValue("Todos os clientes"), { target: { value: "cli-1" } });
    expect(cargasCardValue()).toBe("1");
  });

  it("renderiza a fila real e aprova a reserva do motorista selecionado", async () => {
    render(<Leads />);

    expect(screen.getByText("Fila")).toBeInTheDocument();
    expect(screen.getByText("Salvador / BA -> Campinas / SP")).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: "Expandir disputa" })[0]);

    fireEvent.click(screen.getByRole("button", { name: "Reservar para este motorista" }));

    await waitFor(() => {
      expect(mockApproveOperatorLoadLead).toHaveBeenCalledWith("load-1", "lead-1");
    });
  });

  it("configura polling resiliente e invalida a fila quando chegam eventos realtime", async () => {
    const invalidateQueries = vi.fn();
    mockUseQueryClient.mockReturnValue({
      invalidateQueries,
    });

    render(<Leads />);

    expect(mockUseQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        // Backoff dinâmico: 30s antes do primeiro response, 60s estável.
        refetchInterval: expect.any(Function),
        refetchIntervalInBackground: false,
        // Desligado para cortar egress do pooler: alternar abas não deve
        // refetchar a query pesada da fila (polling + realtime já cobrem).
        refetchOnWindowFocus: false,
        refetchOnReconnect: true,
        staleTime: 15_000,
      }),
    );

    // Valida o contrato do interval function: backoff 30s → 60s
    const callArgs = mockUseQuery.mock.calls[0][0] as { refetchInterval: (query: { state: { data: unknown } }) => number };
    expect(callArgs.refetchInterval({ state: { data: undefined } })).toBe(30_000);
    expect(callArgs.refetchInterval({ state: { data: { items: [] } } })).toBe(60_000);

    await waitFor(() => {
      expect(mockSupabaseChannel).toHaveBeenCalledWith("operator-public-load-leads");
    });

    expect(realtimeCallbacks.has("load_public_leads")).toBe(true);
    expect(realtimeCallbacks.has("cargas")).toBe(true);

    realtimeCallbacks.get("load_public_leads")?.();

    // A invalidação é DEBOUNCED em 3s (corta egress do pooler: rajada de
    // eventos do canal `cargas`, inflada pelo sheet sync, colapsa em 1
    // refetch). Por isso o waitFor precisa de timeout > 3s.
    await waitFor(() => {
      expect(invalidateQueries).toHaveBeenCalledWith({
        queryKey: ["operator", "public-load-leads"],
      });
    }, { timeout: 5_000 });
  });

  it("historico usa escopo proprio na query key e nao faz auto-poll (corta egress)", () => {
    render(<Leads historicoMode />);

    const leadsCall = mockUseQuery.mock.calls.find(
      (c) => (c[0] as { queryKey?: unknown[] })?.queryKey?.[1] === "public-load-leads",
    )?.[0] as { queryKey: unknown[]; refetchInterval: unknown; staleTime: number };

    // Fila e Historico compartilham o modulo — a query key precisa separar por
    // escopo, senao as duas telas colidem no cache do TanStack.
    expect(leadsCall.queryKey).toEqual(["operator", "public-load-leads", "historico"]);
    // Historico (conjunto grande de cargas terminais) abre sob demanda; sem
    // auto-poll para nao reenviar a lista pesada a cada 60s enquanto aberto.
    expect(leadsCall.refetchInterval).toBe(false);
    expect(leadsCall.staleTime).toBe(5 * 60_000);
  });

  it("mostra banner amarelo de sincronizacao indisponivel quando 503 e ja existem dados", () => {
    // Cenario: polling ja trouxe dados; uma proxima refetch falhou com 503
    // schema-drift. UI mantem os dados antigos visiveis e exibe banner gracioso.
    mockUseQuery.mockReturnValue({
      data: {
        groups: [
          {
            load: {
              id: "load-existente",
              status: "OPEN",
              origem: "Curitiba / PR",
              destino: "Porto Alegre / RS",
              perfil: "CARRETA",
              data: "2026-05-25",
              horario: "10:00:00",
              reservedPublicLeadId: null,
            },
            queueCount: 1,
            totalLeads: 1,
            leads: [
              {
                id: "lead-stale",
                status: "QUEUED",
                cpf: "11122233344",
                phone: "41999999999",
                horsePlate: "AAA1B22",
                trailerPlate: "BBB3C44",
                trailerPlate2: "",
                vehicleType: "CARRETA",
                preRegisteredAt: "2026-05-25T09:00:00.000Z",
                queuedAt: "2026-05-25T09:01:00.000Z",
                whatsappClickedAt: null,
                approvedAt: null,
                approvedBy: null,
                queuePosition: 1,
                validation: null,
                whatsappUrl: "https://wa.me/5541999999999",
              },
            ],
          },
        ],
      },
      error: new FakeApiError("Schema drift", { status: 503, code: "SCHEMA_DRIFT" }),
      isLoading: false,
      isFetching: true,
    });

    render(<Leads />);

    expect(screen.getByText("Sincronizacao temporariamente indisponivel")).toBeInTheDocument();
    // Dados antigos (rota) seguem visiveis — banner NAO bloqueia a UI.
    expect(screen.getByText("Curitiba / PR -> Porto Alegre / RS")).toBeInTheDocument();
    // Mensagem do erro completo NAO eh exibida (so o banner gracioso).
    expect(screen.queryByText("Não foi possível carregar a fila")).not.toBeInTheDocument();
  });

  it("mostra o erro da API em vez de fingir que a fila esta vazia", () => {
    mockUseQuery.mockReturnValue({
      data: undefined,
      error: new Error("Only authenticated operators can perform this operation."),
      isLoading: false,
      isFetching: false,
    });

    render(<Leads />);

    expect(screen.getByText("Não foi possível carregar a fila")).toBeInTheDocument();
    expect(screen.getByText("Only authenticated operators can perform this operation.")).toBeInTheDocument();
    expect(screen.queryByText("Nenhum lead na fila")).not.toBeInTheDocument();
  });

  it("filtra leads por busca, status da carga e status do lead", () => {
    render(<Leads />);

    fireEvent.change(screen.getByPlaceholderText(/Pesquisar por/i), {
      target: { value: "Recife" },
    });

    expect(screen.getByText("Recife / PE -> Fortaleza / CE")).toBeInTheDocument();
    expect(screen.queryByText("Salvador / BA -> Campinas / SP")).not.toBeInTheDocument();

    fireEvent.change(screen.getByDisplayValue("Todas as cargas"), {
      target: { value: "RESERVED" },
    });
    fireEvent.change(screen.getByDisplayValue("Todos os leads"), {
      target: { value: "APPROVED" },
    });

    fireEvent.click(screen.getAllByRole("button", { name: "Expandir disputa" })[0]);

    expect(screen.getAllByText("Reservado").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Reservar para este motorista" })).not.toBeInTheDocument();
  });

  it("agrupa N cargas de um pacote candidatadas pelo mesmo motorista em um unico card 'Viagem casada'", async () => {
    // Mesmo pacote, mesmo motorista (cpf+phone iguais) → 1 card pacote agrupado.
    mockUseQuery.mockReturnValue({
      data: {
        groups: [
          {
            load: {
              id: "carga-pacote-1",
              status: "OPEN",
              origem: "Sao Paulo / SP",
              destino: "Rio de Janeiro / RJ",
              perfil: "CARRETA",
              data: "2026-05-10",
              horario: "08:00:00",
              reservedPublicLeadId: null,
              sheetLh: "LH-PCT-1",
              viagemId: "pacote-001",
              ordemViagem: 1,
              pacoteMeta: {
                id: "pacote-001",
                status: "publicado",
                valorTotal: 18000,
                version: 1,
                totalCargas: 2,
                ordemPropria: 1,
              },
            },
            queueCount: 1,
            totalLeads: 1,
            leads: [
              {
                id: "lead-pct-a",
                status: "QUEUED",
                cpf: "55544433322",
                phone: "31988887777",
                horsePlate: "PCT1A23",
                trailerPlate: "PCT4B56",
                trailerPlate2: "",
                vehicleType: "CARRETA",
                preRegisteredAt: "2026-05-08T10:00:00.000Z",
                queuedAt: "2026-05-08T10:00:30.000Z",
                whatsappClickedAt: null,
                approvedAt: null,
                approvedBy: null,
                queuePosition: 1,
                validation: null,
                whatsappUrl: "https://wa.me/5531988887777",
              },
            ],
          },
          {
            load: {
              id: "carga-pacote-2",
              status: "OPEN",
              origem: "Rio de Janeiro / RJ",
              destino: "Belo Horizonte / MG",
              perfil: "CARRETA",
              data: "2026-05-11",
              horario: "07:00:00",
              reservedPublicLeadId: null,
              sheetLh: "LH-PCT-2",
              viagemId: "pacote-001",
              ordemViagem: 2,
              pacoteMeta: {
                id: "pacote-001",
                status: "publicado",
                valorTotal: 18000,
                version: 1,
                totalCargas: 2,
                ordemPropria: 2,
              },
            },
            queueCount: 1,
            totalLeads: 1,
            leads: [
              {
                id: "lead-pct-b",
                status: "QUEUED",
                cpf: "55544433322",
                phone: "31988887777",
                horsePlate: "PCT1A23",
                trailerPlate: "PCT4B56",
                trailerPlate2: "",
                vehicleType: "CARRETA",
                preRegisteredAt: "2026-05-08T10:00:00.000Z",
                queuedAt: "2026-05-08T10:00:30.000Z",
                whatsappClickedAt: null,
                approvedAt: null,
                approvedBy: null,
                queuePosition: 1,
                validation: null,
                whatsappUrl: "https://wa.me/5531988887777",
              },
            ],
          },
        ],
      },
      isLoading: false,
      isFetching: false,
    });

    render(<Leads />);

    // Card pacote unico (1 viagem casada, 2 paradas).
    expect(screen.getByText("Viagem casada")).toBeInTheDocument();
    // Pelo menos um indicador de "2 paradas" no DOM (header + estado colapsado).
    expect(screen.getAllByText(/2 paradas/i).length).toBeGreaterThan(0);

    // Cards avulsos NAO existem (o card pacote substitui). Confirma pela ausencia
    // do botao "Expandir disputa" (usado so em cards avulsos).
    expect(screen.queryByRole("button", { name: /Expandir disputa/i })).not.toBeInTheDocument();
    // Botoes "Reservar para este motorista" (avulso) tambem nao aparecem.
    expect(screen.queryByRole("button", { name: /Reservar para este motorista/i })).not.toBeInTheDocument();

    // Card pacote ja aparece expandido por padrao — cada parada tem seu LH e rota.
    expect(screen.getByText("LH LH-PCT-1")).toBeInTheDocument();
    expect(screen.getByText("LH LH-PCT-2")).toBeInTheDocument();
    // Cada rota aparece pelo menos uma vez (lista de paradas exibe origem -> destino por parada).
    expect(screen.getAllByText(/Sao Paulo \/ SP -> Rio de Janeiro \/ RJ/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Rio de Janeiro \/ RJ -> Belo Horizonte \/ MG/).length).toBeGreaterThan(0);

    // Iter #9: candidaturas em tabela — 1 row por motorista, com "Reservar pacote"
    // que reserva todas as paradas QUEUED daquele driver de uma vez.
    const reservarPacoteBtn = screen.getByRole("button", { name: /Reservar pacote/i });
    expect(reservarPacoteBtn).toBeInTheDocument();

    // Clicar em "Reservar pacote" sequencia approve para todos os leads QUEUED.
    fireEvent.click(reservarPacoteBtn);
    await waitFor(() => {
      expect(mockApproveOperatorLoadLead).toHaveBeenCalledWith("carga-pacote-1", "lead-pct-a");
    });
    // Sequencial: segunda parada tambem.
    await waitFor(() => {
      expect(mockApproveOperatorLoadLead).toHaveBeenCalledWith("carga-pacote-2", "lead-pct-b");
    });
  });

  it("exibe driverName na coluna Motorista quando o backend resolve o nome", () => {
    mockUseQuery.mockReturnValue({
      data: {
        groups: [
          {
            load: {
              id: "load-com-nome",
              status: "OPEN",
              origem: "Sao Paulo / SP",
              destino: "Rio de Janeiro / RJ",
              perfil: "CARRETA",
              data: "2026-05-25",
              horario: "08:00:00",
              reservedPublicLeadId: null,
            },
            queueCount: 1,
            totalLeads: 1,
            leads: [
              {
                id: "lead-com-nome",
                status: "QUEUED",
                cpf: "12345678901",
                phone: "71999998888",
                horsePlate: "ABC1D23",
                trailerPlate: "DEF4G56",
                trailerPlate2: "",
                vehicleType: "CARRETA",
                preRegisteredAt: "2026-05-25T09:00:00.000Z",
                queuedAt: "2026-05-25T09:01:00.000Z",
                whatsappClickedAt: null,
                approvedAt: null,
                approvedBy: null,
                queuePosition: 1,
                validation: null,
                whatsappUrl: "https://wa.me/5571999998888",
                driverName: "Carlos Eduardo Pereira",
                vinculo: "AGREGADO DEDICADO",
              },
            ],
          },
        ],
      },
      isLoading: false,
      isFetching: false,
    });

    render(<Leads />);
    fireEvent.click(screen.getAllByRole("button", { name: /Expandir disputa/i })[0]);

    // Cabecalho da coluna mudou de "Telefone" para "Motorista".
    expect(screen.getByRole("columnheader", { name: "Motorista" })).toBeInTheDocument();
    // Nome aparece como label principal.
    expect(screen.getByText("Carlos Eduardo Pereira")).toBeInTheDocument();
    // Badge de vínculo aparece ao lado do nome (sem precisar abrir o modal).
    expect(screen.getByText("Agregado dedicado")).toBeInTheDocument();
    // CPF mascarado + phone formatado aparecem como sublabel.
    expect(screen.getByText(/CPF \*01.*\(71\) 99999-8888/)).toBeInTheDocument();
  });

  it("exibe phone formatado + sem cadastro quando driverName eh null", () => {
    mockUseQuery.mockReturnValue({
      data: {
        groups: [
          {
            load: {
              id: "load-sem-nome",
              status: "OPEN",
              origem: "Curitiba / PR",
              destino: "Florianopolis / SC",
              perfil: "CARRETA",
              data: "2026-05-25",
              horario: "10:00:00",
              reservedPublicLeadId: null,
            },
            queueCount: 1,
            totalLeads: 1,
            leads: [
              {
                id: "lead-sem-nome",
                status: "QUEUED",
                cpf: "98765432100",
                phone: "41977776666",
                horsePlate: "XYZ1A22",
                trailerPlate: "YYY2B33",
                trailerPlate2: "",
                vehicleType: "CARRETA",
                preRegisteredAt: "2026-05-25T09:00:00.000Z",
                queuedAt: "2026-05-25T09:01:00.000Z",
                whatsappClickedAt: null,
                approvedAt: null,
                approvedBy: null,
                queuePosition: 1,
                validation: null,
                whatsappUrl: "https://wa.me/5541977776666",
                driverName: null,
              },
            ],
          },
        ],
      },
      isLoading: false,
      isFetching: false,
    });

    render(<Leads />);
    fireEvent.click(screen.getAllByRole("button", { name: /Expandir disputa/i })[0]);

    // Phone formatado eh exibido como label principal (fallback do driverName null).
    expect(screen.getByText("(41) 97777-6666")).toBeInTheDocument();
    // Sublabel sinaliza "sem cadastro".
    expect(screen.getByText(/CPF \*00.*sem cadastro/)).toBeInTheDocument();
    // Sem vinculo na planilha => badge "Terceiro" ao lado do nome/telefone.
    expect(screen.getByText("Terceiro")).toBeInTheDocument();
  });

  it("abre as disputas minimizadas por padrao e permite expandir depois", () => {
    render(<Leads />);

    expect(screen.queryByRole("button", { name: "Reservar para este motorista" })).not.toBeInTheDocument();
    expect(screen.getAllByText("Candidatos nesta carga").length).toBeGreaterThan(0);

    fireEvent.click(screen.getAllByRole("button", { name: "Expandir disputa" })[0]);

    expect(screen.getByRole("button", { name: "Reservar para este motorista" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Minimizar disputa" }));

    expect(screen.queryByRole("button", { name: "Reservar para este motorista" })).not.toBeInTheDocument();
  });

  it("no Historico fila, lista as cargas do mais recente para o mais antigo", () => {
    // Backend entrega a fila em ordem FIFO (queued_at ASC) — a mais antiga
    // primeiro. No Historico fila a ordem deve ser invertida por recencia.
    const makeLead = (id: string, ts: string) => ({
      id,
      status: "APPROVED",
      cpf: "12345678901",
      phone: "71999999999",
      horsePlate: "ABC1D23",
      trailerPlate: "DEF4G56",
      trailerPlate2: "",
      vehicleType: "CARRETA",
      preRegisteredAt: ts,
      queuedAt: ts,
      whatsappClickedAt: null,
      approvedAt: ts,
      approvedBy: "operator-1",
      queuePosition: null,
      validation: null,
      whatsappUrl: "https://wa.me/5571999999999",
    });

    mockUseQuery.mockReturnValue({
      data: {
        groups: [
          {
            // Mais ANTIGA (chega primeiro na ordem FIFO do backend).
            load: {
              id: "load-antiga",
              status: "COMPLETED",
              origem: "Antiga / AA",
              destino: "Velha / VV",
              perfil: "CARRETA",
              data: "2026-04-01",
              horario: "08:00:00",
              reservedPublicLeadId: "lead-antiga",
            },
            queueCount: 0,
            totalLeads: 1,
            leads: [makeLead("lead-antiga", "2026-04-01T10:00:00.000Z")],
          },
          {
            // Mais RECENTE (chega depois na ordem FIFO do backend).
            load: {
              id: "load-recente",
              status: "CANCELLED",
              origem: "Recente / RR",
              destino: "Nova / NN",
              perfil: "CARRETA",
              data: "2026-04-20",
              horario: "08:00:00",
              reservedPublicLeadId: "lead-recente",
            },
            queueCount: 0,
            totalLeads: 1,
            leads: [makeLead("lead-recente", "2026-04-20T10:00:00.000Z")],
          },
        ],
      },
      isLoading: false,
      isFetching: false,
    });

    render(<Leads historicoMode />);

    const recente = screen.getByText("Recente / RR -> Nova / NN");
    const antiga = screen.getByText("Antiga / AA -> Velha / VV");

    // A mais recente deve aparecer ANTES da mais antiga no DOM.
    expect(
      recente.compareDocumentPosition(antiga) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});
