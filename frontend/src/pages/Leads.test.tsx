import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

vi.mock("@/services/loadClaims", () => ({
  approveOperatorLoadLead: mockApproveOperatorLoadLead,
  fetchOperatorLoadLeads: vi.fn(),
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
        refetchInterval: 30_000,
        refetchIntervalInBackground: false,
        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
        staleTime: 15_000,
      }),
    );

    await waitFor(() => {
      expect(mockSupabaseChannel).toHaveBeenCalledWith("operator-public-load-leads");
    });

    expect(realtimeCallbacks.has("load_public_leads")).toBe(true);
    expect(realtimeCallbacks.has("cargas")).toBe(true);

    realtimeCallbacks.get("load_public_leads")?.();

    await waitFor(() => {
      expect(invalidateQueries).toHaveBeenCalledWith({
        queryKey: ["operator", "public-load-leads"],
      });
    });
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

    fireEvent.change(screen.getByPlaceholderText(/Pesquisar por carga, origem, destino, telefone, CPF ou placa/i), {
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

  it("abre as disputas minimizadas por padrao e permite expandir depois", () => {
    render(<Leads />);

    expect(screen.queryByRole("button", { name: "Reservar para este motorista" })).not.toBeInTheDocument();
    expect(screen.getAllByText("Candidatos nesta carga").length).toBeGreaterThan(0);

    fireEvent.click(screen.getAllByRole("button", { name: "Expandir disputa" })[0]);

    expect(screen.getByRole("button", { name: "Reservar para este motorista" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Minimizar disputa" }));

    expect(screen.queryByRole("button", { name: "Reservar para este motorista" })).not.toBeInTheDocument();
  });
});
