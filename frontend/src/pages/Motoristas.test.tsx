import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import Motoristas from "@/pages/Motoristas";

const { mockUseQuery, mockUseMutation, mockUseQueryClient } = vi.hoisted(() => ({
  mockUseQuery: vi.fn(),
  mockUseMutation: vi.fn(),
  mockUseQueryClient: vi.fn(),
}));

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query");

  return {
    ...actual,
    useQuery: mockUseQuery,
    useMutation: mockUseMutation,
    useQueryClient: mockUseQueryClient,
  };
});

vi.mock("@/components/DashboardHeader", () => ({
  default: ({ title }: { title: string }) => <div>{title}</div>,
}));

vi.mock("@/components/AspxSyncCard", () => ({
  AspxSyncCard: () => null,
}));

vi.mock("@/services/apiClient", () => ({
  getOperatorAccessToken: vi.fn().mockResolvedValue("test-token"),
}));

vi.mock("@/hooks/useOperatorPermissions", () => ({
  useOperatorPermissions: () => ({
    isOperator: true,
    isAdvanced: true,
    isIntermediate: false,
    canApproveMotoristas: true,
    canRejectMotoristas: true,
    canEditMotoristas: true,
    canBulkRevalidateVehicles: true,
    canAllocateLeads: true,
    canCancelLeads: true,
  }),
}));

const mockMutate = vi.fn();

describe("Motoristas", () => {
  beforeEach(() => {
    mockUseQuery.mockReset();
    mockUseMutation.mockReset();
    mockUseQueryClient.mockReset();
    mockMutate.mockReset();

    mockUseMutation.mockReturnValue({
      mutate: mockMutate,
      isPending: false,
    });

    mockUseQueryClient.mockReturnValue({
      invalidateQueries: vi.fn(),
    });
    mockUseQuery.mockReturnValue({
      data: {
        items: [
          {
            id: "driver-1",
            sourceType: "REGISTERED",
            registrationStatus: "REGISTERED",
            displayName: "Maria Santos",
            contact: {
              phone: "71912345678",
              document: "12345678901",
            },
            profile: {
              vehicleProfile: "CARRETA",
              active: true,
              documentsValid: true,
              anttValid: true,
              trackingEnabled: true,
              insuranceValid: true,
              monitoringCapable: true,
              operationalBlocked: false,
            },
            externalValidation: null,
            stats: {
              totalApplications: 1,
              queuedApplications: 1,
              reservedApplications: 0,
              confirmedApplications: 0,
              latestApplicationAt: "2026-04-14T09:00:00.000Z",
            },
            applications: [
              {
                id: "claim-1",
                source: "CLAIM",
                status: "WAITLISTED",
                submittedAt: "2026-04-14T09:00:00.000Z",
                queuePosition: 1,
                vehicleType: "CARRETA",
                plates: null,
                validation: null,
                load: {
                  id: "load-1",
                  status: "OPEN",
                  origem: "Salvador / BA",
                  destino: "Campinas / SP",
                  data: "2026-04-14",
                  horario: "08:00:00",
                  perfil: "CARRETA",
                },
              },
            ],
          },
          {
            id: "public-1",
            sourceType: "PUBLIC_LEAD",
            registrationStatus: "PUBLIC_ONLY",
            displayName: "Motorista sem cadastro no app",
            contact: {
              phone: "71999888777",
              document: "98765432100",
            },
            profile: {
              vehicleProfile: "TRUCK",
              active: null,
              documentsValid: null,
              anttValid: null,
              trackingEnabled: null,
              insuranceValid: null,
              monitoringCapable: null,
              operationalBlocked: null,
            },
            externalValidation: {
              overallStatus: "EXPIRING",
              warnings: ["Vigencia perto de vencer."],
              hasAngelira: true,
              hasAspx: true,
              checkedAt: "2026-04-14T10:00:00.000Z",
            },
            stats: {
              totalApplications: 1,
              queuedApplications: 1,
              reservedApplications: 0,
              confirmedApplications: 0,
              latestApplicationAt: "2026-04-14T10:05:00.000Z",
            },
            applications: [
              {
                id: "lead-1",
                source: "PUBLIC_LEAD",
                status: "QUEUED",
                submittedAt: "2026-04-14T10:05:00.000Z",
                queuePosition: null,
                vehicleType: "TRUCK",
                plates: {
                  horsePlate: "ABC1D23",
                  trailerPlate: "DEF4G56",
                  trailerPlate2: null,
                },
                validation: {
                  schemaVersion: 1,
                  checkedAt: "2026-04-14T10:00:00.000Z",
                  candidateSubmittedAt: "2026-04-14T09:55:00.000Z",
                  overallStatus: "EXPIRING",
                  missingFields: [],
                  warnings: ["Vigencia perto de vencer."],
                  driver: {
                    angelira: {
                      status: "FOUND",
                      found: true,
                      displayName: null,
                    },
                    aspx: {
                      status: "FOUND",
                      found: true,
                      displayName: null,
                    },
                  },
                  plates: [],
                  vigency: {
                    status: "EXPIRING",
                    validUntil: "2026-04-28",
                    daysUntilExpiry: 14,
                    source: "ANGELLIRA_DRIVER",
                  },
                  support: {
                    whatsappNumber: "5571997254530",
                    whatsappUrl: "https://wa.me/5571997254530",
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
                load: {
                  id: "load-2",
                  status: "OPEN",
                  origem: "Feira de Santana / BA",
                  destino: "Recife / PE",
                  data: "2026-04-14",
                  horario: "10:00:00",
                  perfil: "TRUCK",
                },
              },
            ],
          },
        ],
        summary: {
          totalDrivers: 2,
          registeredCount: 1,
          publicOnlyCount: 1,
          totalApplications: 2,
        },
        meta: {
          page: 1,
          pageSize: 8,
          totalCount: 2,
          totalPages: 1,
          hasNextPage: false,
          maxPageSize: 8,
          correlationId: "corr-motoristas",
        },
      },
      error: null,
      isLoading: false,
      isFetching: false,
    });
  });

  it("mostra o nome do motorista cadastrado e o fallback seguro do pre-cadastro publico", () => {
    render(<Motoristas />);

    expect(screen.getAllByText("Motoristas")[0]).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Maria Santos" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Motorista sem cadastro no app" })).toBeInTheDocument();
    expect(screen.getByText("71912345678")).toBeInTheDocument();
    expect(screen.getByText("12345678901")).toBeInTheDocument();
  });

  it("renderiza candidaturas dentro das secoes colapsaveis ao expandir", () => {
    render(<Motoristas />);

    // Candidaturas estao colapsadas por default — expandir secao
    const candidaturaTriggers = screen.getAllByText(/Candidaturas \(\d+\)/);
    expect(candidaturaTriggers.length).toBeGreaterThan(0);
    // Clicar no botao pai (CollapsibleTrigger) para abrir a secao
    const triggerButton = candidaturaTriggers[0].closest("button");
    expect(triggerButton).toBeTruthy();
    fireEvent.click(triggerButton!);

    expect(screen.getByText(/Salvador \/ BA/)).toBeInTheDocument();
  });

  it("exibe botao de edicao apenas para motoristas cadastrados", () => {
    render(<Motoristas />);

    const editButtons = screen.getAllByTitle("Editar perfil do motorista");
    expect(editButtons).toHaveLength(1);
  });

  it("abre o modal de edicao ao clicar no botao de editar", () => {
    render(<Motoristas />);

    const editButton = screen.getByTitle("Editar perfil do motorista");
    fireEvent.click(editButton);

    expect(screen.getByText("Editar motorista")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Maria Santos")).toBeInTheDocument();
    expect(screen.getByDisplayValue("CARRETA")).toBeInTheDocument();
  });

  it("chama mutate com os dados corretos ao salvar edicao", () => {
    render(<Motoristas />);

    const editButton = screen.getByTitle("Editar perfil do motorista");
    fireEvent.click(editButton);

    const nameInput = screen.getByDisplayValue("Maria Santos");
    fireEvent.change(nameInput, { target: { value: "Maria Silva Santos" } });

    const saveButton = screen.getByText("Salvar alteracoes");
    fireEvent.click(saveButton);

    expect(mockMutate).toHaveBeenCalledWith({
      driverId: "driver-1",
      payload: expect.objectContaining({
        full_name: "Maria Silva Santos",
        vehicle_profile: "CARRETA",
        documents_valid: true,
        antt_valid: true,
      }),
    });
  });

  it("fecha o modal ao clicar em cancelar", () => {
    render(<Motoristas />);

    const editButton = screen.getByTitle("Editar perfil do motorista");
    fireEvent.click(editButton);

    expect(screen.getByText("Editar motorista")).toBeInTheDocument();

    const cancelButton = screen.getByText("Cancelar");
    fireEvent.click(cancelButton);

    expect(screen.queryByText("Editar motorista")).not.toBeInTheDocument();
  });

  it("nao exibe botao de edicao para pre-cadastros publicos", () => {
    mockUseQuery.mockReturnValue({
      data: {
        items: [
          {
            id: "public-1",
            sourceType: "PUBLIC_LEAD",
            registrationStatus: "PUBLIC_ONLY",
            displayName: "Motorista sem cadastro",
            contact: { phone: null, document: null },
            profile: {
              vehicleProfile: null,
              active: null,
              documentsValid: null,
              anttValid: null,
              trackingEnabled: null,
              insuranceValid: null,
              monitoringCapable: null,
              operationalBlocked: null,
            },
            externalValidation: null,
            stats: { totalApplications: 0, queuedApplications: 0, reservedApplications: 0, confirmedApplications: 0, latestApplicationAt: null },
            applications: [],
          },
        ],
        summary: { totalDrivers: 1, registeredCount: 0, publicOnlyCount: 1, totalApplications: 0 },
        meta: { page: 1, pageSize: 8, totalCount: 1, totalPages: 1, hasNextPage: false, maxPageSize: 8, correlationId: "c" },
      },
      error: null,
      isLoading: false,
      isFetching: false,
    });

    render(<Motoristas />);

    expect(screen.queryByTitle("Editar perfil do motorista")).not.toBeInTheDocument();
  });
});
