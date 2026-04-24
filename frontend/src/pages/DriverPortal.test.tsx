import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { auth: { getSession: vi.fn(), signInWithPassword: vi.fn(), signOut: vi.fn() } },
}));

import DriverPortal from "@/pages/DriverPortal";

const { mockUseQuery } = vi.hoisted(() => ({
  mockUseQuery: vi.fn(),
}));

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query");

  return {
    ...actual,
    useQuery: mockUseQuery,
  };
});

vi.mock("@/components/LoadCard", () => ({
  default: ({ id }: { id: string }) => <div>Carga {id}</div>,
}));

function setupUseQuery(options?: {
  totalPages?: number;
  totalCount?: number;
  itemsByPage?: Record<number, Array<Record<string, unknown>>>;
}) {
  const totalPages = options?.totalPages ?? 1;
  const totalCount = options?.totalCount ?? 1;
  const itemsByPage =
    options?.itemsByPage ??
    {
      1: [
        {
          id: "load-1",
          data: "2026-04-10T10:00:00.000Z",
          horario: "10:00:00",
          origem: "Feira de Santana / BA",
          destino: "Salvador / BA",
          perfil: "CARRETA",
          valor: 1200,
          bonus: 200,
          clienteId: "client-1",
          clienteNome: "Shopee",
          clienteDescricao: null,
          carregamentoLabel: "10/04 10:00",
          descargaLabel: "10/04 18:00",
        },
      ],
    };

  mockUseQuery.mockImplementation((options: { queryKey?: unknown[] }) => {
    const queryKey = Array.isArray(options?.queryKey) ? options.queryKey : [];

    if (queryKey[1] === "lead-notifications") {
      return {
        data: [
          {
            state: {
              loadId: "load-1",
              leadId: "lead-1",
              stage: "QUEUED",
              form: {
                cpf: "123.456.789-01",
                phone: "(71) 99999-9999",
                horsePlate: "ABC1D23",
                trailerPlate: "DEF4G56",
                trailerPlate2: "",
                vehicleType: "CARRETA",
              },
              whatsappUrl: "https://wa.me/5571999999999",
              updatedAt: "2026-04-10T10:00:00.000Z",
            },
            status: {
              load: {
                id: "load-1",
                status: "RESERVED",
                reservedAt: "2026-04-10T10:05:00.000Z",
                reservedUntil: null,
                origem: "Feira de Santana / BA",
                destino: "Salvador / BA",
              },
              publicLead: {
                id: "lead-1",
                status: "APPROVED",
                queuedAt: "2026-04-10T10:00:00.000Z",
                whatsappClickedAt: "2026-04-10T09:58:00.000Z",
                approvedAt: "2026-04-10T10:05:00.000Z",
                approvedBy: "operator-1",
              },
              claim: null,
              meta: {
                correlationId: "corr-driver-portal",
              },
            },
            error: null,
          },
        ],
        isLoading: false,
        error: null,
      };
    }

    if (queryKey[1] === "loads-read-model") {
      const currentPage = Number(queryKey[7] || 1);

      return {
        data: {
          items: itemsByPage[currentPage] || [],
          summary: {
            totalCount,
            uniqueStateCount: 1,
            uniqueProfileCount: 1,
          },
          meta: {
            page: currentPage,
            pageSize: 12,
            totalCount,
            totalPages,
            hasNextPage: currentPage < totalPages,
            maxPageSize: 12,
            correlationId: "corr-loads",
          },
        },
        isLoading: false,
        isFetching: false,
        error: null,
      };
    }

    if (queryKey[1] === "loads-facets") {
      return {
        data: {
          origemOptions: ["Feira de Santana / BA"],
          destinoOptions: ["Salvador / BA"],
          perfilOptions: ["CARRETA"],
          meta: {
            correlationId: "corr-facets",
          },
        },
        isLoading: false,
        error: null,
      };
    }

    return {
      data: null,
      isLoading: false,
      isFetching: false,
      error: null,
    };
  });
}

describe("DriverPortal", () => {
  beforeEach(() => {
    mockUseQuery.mockReset();
    window.localStorage.clear();

    window.localStorage.setItem(
      "lamonica-public-load-lead:load-1",
      JSON.stringify({
        loadId: "load-1",
        leadId: "lead-1",
        stage: "QUEUED",
        form: {
          cpf: "123.456.789-01",
          phone: "(71) 99999-9999",
          horsePlate: "ABC1D23",
          trailerPlate: "DEF4G56",
          trailerPlate2: "",
          vehicleType: "CARRETA",
        },
        whatsappUrl: "https://wa.me/5571999999999",
        updatedAt: "2026-04-10T10:00:00.000Z",
      }),
    );

    setupUseQuery();
  });

  it(
    "abre a central de notificacoes e mostra a carga salva para o motorista",
    async () => {
      render(
        <MemoryRouter>
          <DriverPortal />
        </MemoryRouter>,
      );

      expect(screen.getAllByRole("button", { name: /Abrir notificações/i })).toHaveLength(3);
      expect(screen.getByText(/Toque em Filtros para focar a próxima saída/i)).toBeInTheDocument();
      expect(screen.queryByText(/consulta protegida no backend/i)).not.toBeInTheDocument();

      fireEvent.click(screen.getAllByRole("button", { name: /Abrir notificações/i })[0]);

      expect(await screen.findByText("Central de notificações do motorista")).toBeInTheDocument();
      expect(await screen.findByText("Carga reservada para você")).toBeInTheDocument();
      expect(await screen.findByText("Feira de Santana / BA -> Salvador / BA")).toBeInTheDocument();
      expect(await screen.findByRole("link", { name: /Abrir carga|Acompanhar candidatura/i })).toHaveAttribute(
        "href",
        "/cargas/load-1",
      );
    },
    15_000,
  );

  it("mostra os atalhos de cadastro, Suporte e dúvidas na home do motorista", () => {
    render(
      <MemoryRouter>
        <DriverPortal />
      </MemoryRouter>,
    );

    const cadastroLinks = screen.getAllByRole("link", { name: "Cadastro" });
    const suporteButtons = screen.getAllByRole("button", { name: "Suporte" });

    expect(cadastroLinks.length).toBeGreaterThan(0);
    expect(suporteButtons.length).toBeGreaterThan(0);
    expect(cadastroLinks[0]).toHaveAttribute("href", expect.stringContaining("wa.me/557199050085"));

    fireEvent.click(screen.getAllByRole("button", { name: "Dúvidas" })[0]);

    expect(screen.getByText("Respostas rápidas para usar o portal")).toBeInTheDocument();
    expect(screen.getByText(/Sua candidatura já entra direto na fila operacional/i)).toBeInTheDocument();
  });

  it("troca a pagina no primeiro clique no portal do motorista", async () => {
    setupUseQuery({
      totalPages: 3,
      totalCount: 24,
      itemsByPage: {
        1: [
          {
            id: "load-1",
            data: "2026-04-10T10:00:00.000Z",
            horario: "10:00:00",
            origem: "Feira de Santana / BA",
            destino: "Salvador / BA",
            perfil: "CARRETA",
            valor: 1200,
            bonus: 200,
            clienteId: "client-1",
            clienteNome: "Shopee",
            clienteDescricao: null,
            carregamentoLabel: "10/04 10:00",
            descargaLabel: "10/04 18:00",
          },
        ],
        2: [
          {
            id: "load-2",
            data: "2026-04-11T12:00:00.000Z",
            horario: "12:00:00",
            origem: "Simoes Filho / BA",
            destino: "Salvador / BA",
            perfil: "TRUCK",
            valor: 1100,
            bonus: 150,
            clienteId: "client-2",
            clienteNome: "Cliente 2",
            clienteDescricao: null,
            carregamentoLabel: "11/04 12:00",
            descargaLabel: "11/04 18:00",
          },
        ],
      },
    });

    render(
      <MemoryRouter>
        <DriverPortal />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getAllByRole("button", { name: /Próxima/i })[0]);

    expect(screen.getAllByText(/Página 2 de 3/i).length).toBeGreaterThan(0);
  });

  it("revalida as cargas do motorista ao voltar para a tela ou reconectar", () => {
    render(
      <MemoryRouter>
        <DriverPortal />
      </MemoryRouter>,
    );

    const loadsQueryOptions = mockUseQuery.mock.calls
      .map(([options]) => options)
      .find((options) => options?.queryKey?.[1] === "loads-read-model");
    const facetsQueryOptions = mockUseQuery.mock.calls
      .map(([options]) => options)
      .find((options) => options?.queryKey?.[1] === "loads-facets");

    expect(loadsQueryOptions).toMatchObject({
      staleTime: 30_000,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      refetchInterval: 45_000,
    });
    expect(facetsQueryOptions).toMatchObject({
      staleTime: 30_000,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
    });
  });
});
