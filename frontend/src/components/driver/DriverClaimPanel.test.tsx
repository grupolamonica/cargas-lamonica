import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import DriverClaimPanel from "@/components/driver/DriverClaimPanel";

const { mockUseQuery, mockUseQueryClient } = vi.hoisted(() => ({
  mockUseQuery: vi.fn(),
  mockUseQueryClient: vi.fn(),
}));

const {
  mockCreatePublicLoadLeadPreRegistration,
  mockFetchDriverLoadAlternatives,
  mockFetchLoadClaimStatus,
  mockToastError,
  mockToastSuccess,
  mockToastInfo,
} = vi.hoisted(() => ({
  mockCreatePublicLoadLeadPreRegistration: vi.fn(),
  mockFetchDriverLoadAlternatives: vi.fn(),
  mockFetchLoadClaimStatus: vi.fn(),
  mockToastError: vi.fn(),
  mockToastSuccess: vi.fn(),
  mockToastInfo: vi.fn(),
}));

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query");

  return {
    ...actual,
    useQuery: mockUseQuery,
    useQueryClient: mockUseQueryClient,
  };
});

vi.mock("@/integrations/supabase/public-client", () => ({
  publicSupabase: {
    channel: vi.fn(() => ({
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })),
    })),
    removeChannel: vi.fn(),
  },
}));

vi.mock("@/services/loadClaims", () => ({
  createPublicLoadLeadPreRegistration: mockCreatePublicLoadLeadPreRegistration,
  fetchLoadClaimStatus: mockFetchLoadClaimStatus,
}));

vi.mock("@/lib/driverLoadAlternatives", () => ({
  fetchDriverLoadAlternatives: mockFetchDriverLoadAlternatives,
}));

vi.mock("sonner", () => ({
  toast: {
    error: mockToastError,
    success: mockToastSuccess,
    info: mockToastInfo,
  },
}));

function buildStatusQueryResult(overrides?: Record<string, unknown>) {
  return {
    isLoading: false,
    data: {
      load: {
        id: "load-1",
        status: "OPEN",
        reservedUntil: null,
        perfil: "CARRETA",
      },
      publicLead: null,
      claim: null,
      meta: {
        publicLeadWhatsappConfigured: true,
      },
      ...overrides,
    },
    error: null,
  };
}

function buildAlternativesQueryResult(overrides?: Record<string, unknown>) {
  return {
    isLoading: false,
    data: {
      items: [],
      scope: "same-origin",
      ...overrides,
    },
    error: null,
  };
}

function setupUseQuery({
  statusResult = buildStatusQueryResult(),
  alternativesResult = buildAlternativesQueryResult(),
}: {
  statusResult?: ReturnType<typeof buildStatusQueryResult>;
  alternativesResult?: ReturnType<typeof buildAlternativesQueryResult>;
} = {}) {
  mockUseQuery.mockImplementation((options: { queryKey?: unknown[] }) => {
    const queryKey = Array.isArray(options?.queryKey) ? options.queryKey : [];

    if (queryKey[1] === "claim-status") {
      return statusResult;
    }

    if (queryKey[1] === "claim-alternatives") {
      return alternativesResult;
    }

    return {
      isLoading: false,
      data: null,
      error: null,
    };
  });
}

function renderPanel() {
  return render(
    <MemoryRouter>
      <DriverClaimPanel loadId="load-1" />
    </MemoryRouter>,
  );
}

describe("DriverClaimPanel", () => {
  beforeEach(() => {
    mockUseQuery.mockReset();
    mockUseQueryClient.mockReset();
    mockCreatePublicLoadLeadPreRegistration.mockReset();
    mockFetchDriverLoadAlternatives.mockReset();
    mockFetchLoadClaimStatus.mockReset();
    mockToastError.mockReset();
    mockToastSuccess.mockReset();

    mockUseQueryClient.mockReturnValue({
      invalidateQueries: vi.fn(),
    });
    mockFetchLoadClaimStatus.mockResolvedValue({
      load: {
        id: "load-1",
        status: "OPEN",
        reservedUntil: null,
        perfil: "CARRETA",
      },
      claim: null,
      meta: {
        publicLeadWhatsappConfigured: true,
      },
    });
    setupUseQuery();
    mockCreatePublicLoadLeadPreRegistration.mockResolvedValue({
      lead: {
        id: "lead-1",
        status: "QUEUED",
        validation: {
          schemaVersion: 1,
          checkedAt: "2026-04-14T10:00:00.000Z",
          candidateSubmittedAt: "2026-04-14T09:00:00.000Z",
          overallStatus: "PARTIAL",
          missingFields: ["validade"],
          warnings: ["Motorista nao encontrado no diretorio ASPx.", "Vigencia do cadastro nao foi encontrada."],
          driver: {
            angelira: {
              status: "FOUND",
              found: true,
              displayName: "Motorista Teste",
              validUntil: null,
              lastSeenAt: "2026-04-14T10:00:00.000Z",
            },
            aspx: {
              status: "NOT_FOUND",
              found: false,
              displayName: null,
            },
          },
          plates: [
            {
              field: "horsePlate",
              label: "Placa do cavalo",
              status: "FOUND",
              found: true,
              validUntil: null,
              lastSeenAt: "2026-04-14T10:00:00.000Z",
            },
            {
              field: "trailerPlate",
              label: "Placa da carreta",
              status: "FOUND",
              found: true,
              validUntil: null,
              lastSeenAt: "2026-04-14T10:00:00.000Z",
            },
          ],
          vigency: {
            status: "MISSING",
            validUntil: null,
            daysUntilExpiry: null,
            source: null,
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
      },
    });
    mockFetchDriverLoadAlternatives.mockResolvedValue({
      items: [],
      scope: "same-origin",
    });
    window.localStorage.clear();
  });

  it("envia a candidatura para a equipe ao clicar em candidatar-se", async () => {
    renderPanel();

    expect(screen.queryByText("Entrar")).not.toBeInTheDocument();
    expect(screen.queryByText("Cadastrar")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /candidatar-se/i })).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("CPF do motorista"), {
      target: { value: "39053344705" },
    });
    fireEvent.change(screen.getByPlaceholderText("Telefone"), {
      target: { value: "71999999999" },
    });
    fireEvent.change(screen.getByPlaceholderText("Placa do cavalo"), {
      target: { value: "ABC1D23" },
    });
    fireEvent.change(screen.getByPlaceholderText("Placa da carreta"), {
      target: { value: "DEF4G56" },
    });

    fireEvent.click(screen.getByRole("button", { name: /candidatar-se/i }));

    await waitFor(() => {
      expect(mockCreatePublicLoadLeadPreRegistration).toHaveBeenCalledWith("load-1", {
        cpf: "390.533.447-05",
        phone: "(71) 99999-9999",
        horsePlate: "ABC1D23",
        trailerPlate: "DEF4G56",
        trailerPlate2: "",
        vehicleType: "CARRETA",
      });
    });

    expect(await screen.findByText(/Sua candidatura já chegou para a equipe/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Atualizar meus dados/i })).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("CPF do motorista")).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Telefone")).not.toBeInTheDocument();
    expect(screen.getAllByText("390.533.447-05")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /WhatsApp/i })).not.toBeInTheDocument();
    expect(mockToastSuccess).toHaveBeenCalledWith("Candidatura enviada para a equipe.");
  }, 15000);

  it("mostra exatamente quais campos faltam para concluir a candidatura", () => {
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: /candidatar-se/i }));

    expect(mockCreatePublicLoadLeadPreRegistration).not.toHaveBeenCalled();
    expect(mockToastError).toHaveBeenCalledWith(
      "Para se candidatar, preencha CPF, telefone, placa do cavalo e placa da carreta.",
    );
  });

  it("permite editar uma candidatura salva e reenviar os dados", async () => {
    window.localStorage.setItem(
      "lamonica-public-load-lead:load-1",
      JSON.stringify({
        loadId: "load-1",
        leadId: "lead-1",
        stage: "PRE_REGISTERED",
        form: {
          cpf: "390.533.447-05",
          phone: "(71) 99999-9999",
          horsePlate: "ABC1234",
          trailerPlate: "DEF5678",
          trailerPlate2: "",
          vehicleType: "CARRETA",
        },
        whatsappUrl: null,
        updatedAt: "2026-04-08T10:00:00.000Z",
      }),
    );

    renderPanel();

    expect(screen.getByRole("button", { name: /Editar candidatura/i })).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("CPF do motorista")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Editar candidatura/i }));

    expect(screen.getByPlaceholderText("CPF do motorista")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Atualizar candidatura/i })).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("Telefone"), {
      target: { value: "71912345678" },
    });

    fireEvent.click(screen.getByRole("button", { name: /Atualizar candidatura/i }));

    await waitFor(() => {
      expect(mockCreatePublicLoadLeadPreRegistration).toHaveBeenCalledWith("load-1", {
        cpf: "390.533.447-05",
        phone: "(71) 91234-5678",
        horsePlate: "ABC1234",
        trailerPlate: "DEF5678",
        trailerPlate2: "",
        vehicleType: "CARRETA",
      });
    });

    expect(await screen.findByRole("button", { name: /Atualizar meus dados/i })).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("CPF do motorista")).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Telefone")).not.toBeInTheDocument();
    expect(screen.getAllByText("(71) 91234-5678")).toHaveLength(1);
    expect(screen.getByText(/Sua candidatura já chegou para a equipe/i)).toBeInTheDocument();
  });

  it("mostra que a carga já foi reservada quando o status não está mais aberto", () => {
    setupUseQuery({
      statusResult: buildStatusQueryResult({
        load: {
          id: "load-1",
          status: "RESERVED",
          reservedUntil: null,
        },
      }),
    });

    renderPanel();

    expect(screen.getByText(/Esta carga já seguiu com outro motorista/i)).toBeInTheDocument();
  });

  it("mostra confirmacao persistente quando a carga foi reservada para o proprio motorista da fila publica", () => {
    window.localStorage.setItem(
      "lamonica-public-load-lead:load-1",
      JSON.stringify({
        loadId: "load-1",
        leadId: "lead-1",
        stage: "QUEUED",
        form: {
          cpf: "390.533.447-05",
          phone: "(71) 99999-9999",
          horsePlate: "ABC1234",
          trailerPlate: "DEF5678",
          trailerPlate2: "",
          vehicleType: "CARRETA",
        },
        whatsappUrl: "https://wa.me/5571999999999?text=teste",
        updatedAt: "2026-04-09T15:00:00.000Z",
      }),
    );

    setupUseQuery({
      statusResult: buildStatusQueryResult({
        load: {
          id: "load-1",
          status: "RESERVED",
          reservedUntil: null,
          perfil: "CARRETA",
        },
        publicLead: {
          id: "lead-1",
          status: "APPROVED",
          approvedAt: "2026-04-09T15:10:00.000Z",
        },
      }),
    });

    renderPanel();

    expect(screen.getByText(/Carga reservada para você/i)).toBeInTheDocument();
    expect(screen.getByText(/continua salvo para você acompanhar/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Abrir detalhes da carga/i })).toHaveAttribute(
      "href",
      "/motorista/cargas/load-1",
    );
    expect(screen.queryByText(/foi direcionada para outro motorista/i)).not.toBeInTheDocument();
  });

  it("continua permitindo candidatura mesmo quando a meta antiga de WhatsApp vem desabilitada", async () => {
    setupUseQuery({
      statusResult: buildStatusQueryResult({
        meta: {
          publicLeadWhatsappConfigured: false,
        },
      }),
    });

    renderPanel();

    expect(screen.queryByText(/WhatsApp indisponivel no momento/i)).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("CPF do motorista"), {
      target: { value: "39053344705" },
    });
    fireEvent.change(screen.getByPlaceholderText("Telefone"), {
      target: { value: "71999999999" },
    });
    fireEvent.change(screen.getByPlaceholderText("Placa do cavalo"), {
      target: { value: "ABC1D23" },
    });
    fireEvent.change(screen.getByPlaceholderText("Placa da carreta"), {
      target: { value: "DEF4G56" },
    });

    fireEvent.click(screen.getByRole("button", { name: /candidatar-se/i }));

    await waitFor(() => {
      expect(mockCreatePublicLoadLeadPreRegistration).toHaveBeenCalledWith("load-1", {
        cpf: "390.533.447-05",
        phone: "(71) 99999-9999",
        horsePlate: "ABC1D23",
        trailerPlate: "DEF4G56",
        trailerPlate2: "",
        vehicleType: "CARRETA",
      });
    });

    expect(await screen.findByText(/Sua candidatura já chegou para a equipe/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /WhatsApp/i })).not.toBeInTheDocument();
  });

  it("usa automaticamente o tipo truck da carga e não pede placa de carreta", async () => {
    setupUseQuery({
      statusResult: buildStatusQueryResult({
        load: {
          id: "load-1",
          status: "OPEN",
          reservedUntil: null,
          perfil: "TRUCK",
        },
      }),
    });

    renderPanel();

    expect(screen.queryByPlaceholderText("Placa da carreta")).not.toBeInTheDocument();
    expect(screen.getByText("Truck")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("CPF do motorista"), {
      target: { value: "39053344705" },
    });
    fireEvent.change(screen.getByPlaceholderText("Telefone"), {
      target: { value: "71999999999" },
    });
    fireEvent.change(screen.getByPlaceholderText("Placa do cavalo"), {
      target: { value: "ABC1D23" },
    });

    fireEvent.click(screen.getByRole("button", { name: /candidatar-se/i }));

    await waitFor(() => {
      expect(mockCreatePublicLoadLeadPreRegistration).toHaveBeenCalledWith("load-1", {
        cpf: "390.533.447-05",
        phone: "(71) 99999-9999",
        horsePlate: "ABC1D23",
        trailerPlate: "",
        trailerPlate2: "",
        vehicleType: "TRUCK",
      });
    });
  });

  it("exige duas placas de carreta quando a carga pede bitrem", () => {
    setupUseQuery({
      statusResult: buildStatusQueryResult({
        load: {
          id: "load-1",
          status: "OPEN",
          reservedUntil: null,
          perfil: "BITREM",
        },
      }),
    });

    renderPanel();

    fireEvent.change(screen.getByPlaceholderText("CPF do motorista"), {
      target: { value: "39053344705" },
    });
    fireEvent.change(screen.getByPlaceholderText("Telefone"), {
      target: { value: "71999999999" },
    });
    fireEvent.change(screen.getByPlaceholderText("Placa do cavalo"), {
      target: { value: "ABC1D23" },
    });
    fireEvent.change(screen.getByPlaceholderText("1ª placa da carreta"), {
      target: { value: "DEF4G56" },
    });

    fireEvent.click(screen.getByRole("button", { name: /candidatar-se/i }));

    expect(mockCreatePublicLoadLeadPreRegistration).not.toHaveBeenCalled();
    expect(mockToastError).toHaveBeenCalledWith(
      "Para se candidatar, preencha 2ª placa da carreta.",
    );

    fireEvent.change(screen.getByPlaceholderText("2ª placa da carreta"), {
      target: { value: "GHI7J89" },
    });

    fireEvent.click(screen.getByRole("button", { name: /candidatar-se/i }));

    expect(mockCreatePublicLoadLeadPreRegistration).toHaveBeenCalledWith("load-1", {
      cpf: "390.533.447-05",
      phone: "(71) 99999-9999",
      horsePlate: "ABC1D23",
      trailerPlate: "DEF4G56",
      trailerPlate2: "GHI7J89",
      vehicleType: "BITREM",
    });
  });

  it("avisa quando a carga vai para outro motorista e destaca alternativas da mesma origem", () => {
    window.localStorage.setItem(
      "lamonica-public-load-lead:load-1",
      JSON.stringify({
        loadId: "load-1",
        leadId: "lead-1",
        stage: "QUEUED",
        form: {
          cpf: "390.533.447-05",
          phone: "(71) 99999-9999",
          horsePlate: "ABC1234",
          trailerPlate: "DEF5678",
          trailerPlate2: "",
          vehicleType: "CARRETA",
        },
        whatsappUrl: "https://wa.me/5571999999999?text=teste",
        updatedAt: "2026-04-09T15:00:00.000Z",
      }),
    );

    setupUseQuery({
      statusResult: buildStatusQueryResult({
        load: {
          id: "load-1",
          status: "BOOKED",
          reservedUntil: null,
          origem: "Feira de Santana / BA",
          data: "2026-04-09T14:30:00.000Z",
          horario: "17:00:00",
          carregamentoLabel: "09/04 17:00",
        },
      }),
      alternativesResult: buildAlternativesQueryResult({
        items: [
          {
            id: "load-2",
            data: "2026-04-09T15:00:00.000Z",
            horario: "18:00:00",
            origem: "Feira de Santana / BA",
            destino: "Salvador / BA",
            perfil: "CARRETA",
            valor: 1200,
            bonus: 200,
            clienteNome: "Shopee",
            carregamentoLabel: "09/04 18:00",
          },
        ],
        scope: "same-origin-eta",
      }),
    });

    renderPanel();

    expect(screen.getByText(/Esta carga seguiu com outro motorista/i)).toBeInTheDocument();
    expect(screen.getByText(/por volta de 09\/04 17:00/i)).toBeInTheDocument();
    expect(screen.getByText(/mesma origem e uma janela parecida de saída/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Feira de Santana \/ BA/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Salvador \/ BA/i).length).toBeGreaterThan(0);
    expect(screen.getByText("R$ 1.400,00")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Abrir carga/i })).toHaveAttribute("href", "/cargas/load-2");
  });
});
